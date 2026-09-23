import { basename, extname, join } from "path";
import { readdir, unlink } from "node:fs/promises";
import { Queue } from "bullmq";
import { prisma } from "../tools/prisma.ts";
import { chunkText } from "../tools/VectorTable.ts";
import { extractText } from "../tools/textExtract.ts";
import { transcribeVideo } from "../tools/geminiVideo.ts";
import { compressVideo } from "../tools/videoCompress.ts";
import { buildOrgIndex, classifyProcessingIssue, deriveDocumentMetadata, toPrismaDate, type OrgIndex } from "../tools/documentMetadata.ts";
import { getOrgs } from "./datarequest.ts";

const docQueue = new Queue("document-processing", {
  connection: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
  },
});

const DEFAULT_ROOTS = [
  "Y:\\Shared\\CG\\04_Grant_Organizations\\1 Funded Orgs",
  "Y:\\Shared\\CG\\02_Audio_Visual_and_Web\\Trip Media",
  "Y:\\Shared\\CG\\05_Travel\\Trips",
];

const DOC_EXT: Record<string, "PDF" | "DOCX" | "PPTX" | "MD"> = {
  ".pdf": "PDF",
  ".docx": "DOCX",
  ".pptx": "PPTX",
  ".md": "MD",
};

const VIDEO_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

const MAX_VIDEO_MB = parseInt(process.env.GEMINI_MAX_VIDEO_MB || "2000", 10);
const COMPRESS_TARGET_MB = parseInt(process.env.GEMINI_VIDEO_COMPRESS_TARGET_MB || "1800", 10);
// Above this, don't even attempt compression — the source file is too unwieldy to be
// worth the transcode time. Marked FAILED/TOO_LARGE in the DB rather than skipped outright,
// so it's visible and distinguishable from "not yet scanned."
const HARD_CAP_MB = parseInt(process.env.GEMINI_VIDEO_HARD_CAP_MB || "10000", 10);

const SKIP_DIRS = new Set(["$RECYCLE.BIN", "System Volume Information", ".git", "node_modules"]);

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[ingest] cannot read directory ${dir}: ${err}`);
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith("~$") || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

interface IngestStats {
  created: number;
  skipped: number;
  failed: number;
}

interface Failure {
  path: string;
  error: string;
}

async function upsertChunks(documentId: string, text: string): Promise<void> {
  const db = prisma as any;
  await db.knowledgeChunk.deleteMany({ where: { documentId } });
  const textChunks = chunkText(text);
  await db.knowledgeChunk.createMany({
    data: textChunks.map((content: string, index: number) => ({ documentId, chunkIndex: index, content })),
  });
}

async function markFailed(documentId: string, message: string): Promise<void> {
  const db = prisma as any;
  await db.knowledgeDocument
    .update({
      where: { id: documentId },
      data: { status: "FAILED", errorMessage: message, processingIssue: classifyProcessingIssue("FAILED", message) },
    })
    .catch(() => {});
}

async function ingestDoc(
  filePath: string,
  fileType: "PDF" | "DOCX" | "PPTX" | "MD",
  orgIndex: OrgIndex,
  stats: IngestStats,
  failures: Failure[],
): Promise<void> {
  const db = prisma as any;
  const filename = basename(filePath);
  const meta = deriveDocumentMetadata({ storageUrl: filePath, filename, status: "PENDING", errorMessage: null }, orgIndex);

  const created = await db.knowledgeDocument.create({
    data: {
      filename,
      fileType,
      storageUrl: filePath,
      status: "EXTRACTING",
      orgGovId: meta.orgGovId,
      orgName: meta.orgName,
      fundingStatus: meta.fundingStatus,
      documentYear: meta.documentYear,
      documentDate: toPrismaDate(meta.documentDate),
      category: meta.category,
      language: meta.language,
      docProvenance: meta.docProvenance,
      isTemplate: meta.isTemplate,
      containsPii: meta.containsPii,
    },
  });
  const documentId = created.id;

  try {
    const buffer = Buffer.from(await Bun.file(filePath).arrayBuffer());
    const text = await extractText(buffer, fileType);
    if (!text.trim()) {
      throw new Error("no extractable text (scanned/image-only or empty document?)");
    }

    await db.knowledgeDocument.update({ where: { id: documentId }, data: { rawText: text, status: "CHUNKING" } });
    await upsertChunks(documentId, text);
    await db.knowledgeDocument.update({ where: { id: documentId }, data: { status: "READY" } });
    await docQueue.add("embed-chunks", { documentId });

    console.log(`[ingest] created document for ${filename}`);
    stats.created++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ingest] FAILED to extract "${filePath}": ${message}`);
    await markFailed(documentId, message);
    stats.failed++;
    failures.push({ path: filePath, error: message });
  }
}

async function ingestVideo(
  filePath: string,
  mimeType: string,
  orgIndex: OrgIndex,
  stats: IngestStats,
  failures: Failure[],
): Promise<void> {
  const db = prisma as any;
  const filename = basename(filePath);
  const sizeMb = Bun.file(filePath).size / (1024 * 1024);
  const meta = deriveDocumentMetadata({ storageUrl: filePath, filename, status: "PENDING", errorMessage: null }, orgIndex);

  const created = await db.knowledgeDocument.create({
    data: {
      filename,
      fileType: "VIDEO",
      storageUrl: filePath,
      status: "EXTRACTING",
      orgGovId: meta.orgGovId,
      orgName: meta.orgName,
      fundingStatus: meta.fundingStatus,
      documentYear: meta.documentYear,
      documentDate: toPrismaDate(meta.documentDate),
      category: meta.category,
      language: meta.language,
      docProvenance: meta.docProvenance,
      isTemplate: meta.isTemplate,
      containsPii: meta.containsPii,
    },
  });
  const documentId = created.id;

  if (sizeMb > HARD_CAP_MB) {
    const message = `${sizeMb.toFixed(0)}MB exceeds hard cap of ${HARD_CAP_MB}MB — skipped, not processed`;
    console.warn(`[ingest] ${filePath} — ${message}`);
    await markFailed(documentId, message);
    stats.failed++;
    failures.push({ path: filePath, error: message });
    return;
  }

  let uploadPath = filePath;
  let uploadMime = mimeType;
  let compressedPath: string | null = null;

  try {
    if (sizeMb > MAX_VIDEO_MB) {
      console.log(`[ingest] ${filePath} is ${sizeMb.toFixed(0)}MB, over Gemini's ${MAX_VIDEO_MB}MB limit — compressing…`);
      compressedPath = await compressVideo(filePath, COMPRESS_TARGET_MB);
      const compressedMb = Bun.file(compressedPath).size / (1024 * 1024);
      console.log(`[ingest] compressed to ${compressedMb.toFixed(0)}MB`);
      if (compressedMb > MAX_VIDEO_MB) {
        throw new Error(`compressed size ${compressedMb.toFixed(0)}MB still exceeds ${MAX_VIDEO_MB}MB`);
      }
      uploadPath = compressedPath;
      uploadMime = "video/mp4";
    }

    console.log(`[ingest] transcribing ${filePath}…`);
    const markdown = await transcribeVideo(uploadPath, uploadMime, filename);

    await db.knowledgeDocument.update({ where: { id: documentId }, data: { rawText: markdown, status: "CHUNKING" } });
    await upsertChunks(documentId, markdown);
    await db.knowledgeDocument.update({ where: { id: documentId }, data: { status: "READY" } });
    await docQueue.add("embed-chunks", { documentId });

    console.log(`[ingest] created video document for ${filename}`);
    stats.created++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ingest] FAILED to transcribe "${filePath}": ${message}`);
    await markFailed(documentId, message);
    stats.failed++;
    failures.push({ path: filePath, error: message });
  } finally {
    if (compressedPath) await unlink(compressedPath).catch(() => {});
  }
}

/**
 * Walk `roots`, find PDFs/DOCX/PPTX/MD files and MP4/MOV videos, and ingest each into
 * the knowledge base. A file already ingested (matched by absolute path in storageUrl)
 * is skipped and never touched again on later runs, even if it previously failed —
 * this is a one-way, additive scan, not a sync. Extraction/transcription happens
 * synchronously here (not via the background worker) so failures are visible immediately;
 * only the final embedding step is queued.
 */
async function ingestFiles(roots: string[]): Promise<void> {
  const db = prisma as any;
  const stats: IngestStats = { created: 0, skipped: 0, failed: 0 };
  const failures: Failure[] = [];

  const orgs = await getOrgs();
  const orgIndex = buildOrgIndex(orgs.filter((o) => o.govId).map((o) => ({ name: o.name, govId: o.govId })));
  console.log(`[ingest] loaded ${orgIndex.orgs.length} orgs for metadata tagging`);

  for (const root of roots) {
    console.log(`[ingest] scanning ${root}`);
    for await (const filePath of walk(root)) {
      const ext = extname(filePath).toLowerCase();
      const docType = DOC_EXT[ext];
      const videoMime = VIDEO_EXT[ext];
      if (!docType && !videoMime) continue;

      const existing = await db.knowledgeDocument.findFirst({
        where: { storageUrl: filePath },
        select: { id: true },
      });

      if (existing) {
        stats.skipped++;
        continue;
      }

      if (docType) {
        await ingestDoc(filePath, docType, orgIndex, stats, failures);
      } else {
        await ingestVideo(filePath, videoMime, orgIndex, stats, failures);
      }
    }
  }

  console.log(`\n[ingest] done — created ${stats.created}, skipped ${stats.skipped}, failed ${stats.failed}`);
  if (failures.length) {
    console.log(`[ingest] ${failures.length} file(s) failed:`);
    for (const f of failures) console.log(`  - ${f.path}\n      ${f.error}`);
  }
}

// Usage: `bun src/ingestFiles.ts [rootDir ...]`
if (import.meta.main) {
  const roots = process.argv.slice(2);

  ingestFiles(roots.length ? roots : DEFAULT_ROOTS)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { ingestFiles };
