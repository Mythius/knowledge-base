import { join } from "path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Queue } from "bullmq";
import { prisma } from "../tools/prisma.ts";
import { chunkText } from "../tools/VectorTable.ts";

const docQueue = new Queue("document-processing", {
  connection: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
  },
});

const PS_SCRIPT = join(import.meta.dir, "..", "tools", "chromeOcr.ps1");
const RASTERIZE_SCRIPT = join(import.meta.dir, "..", "tools", "rasterizePdf.py");

interface Stats {
  fixed: number;
  failed: number;
  skippedForGood: number;
}

// Some PDFs (seen from certain accounting-software exporters) draw every character as an
// outlined vector shape instead of a text run or an embedded image - no /Font, no /Image,
// nothing for either a text extractor or Chrome's on-device (image-based) OCR to find, even
// though they render as normal-looking documents. Rendering each page to a real pixel image
// first and rebuilding an image-only PDF gives Chrome's OCR something to actually see.
// This also sidesteps the Egnyte/Y: file-access flakiness that caused some documents to hit
// PERSISTENT_ACCESS_FAILURE before, since the rasterized PDF always lands on local disk.
async function rasterizePdf(srcPath: string, dstPath: string): Promise<void> {
  const proc = Bun.spawn(["python", RASTERIZE_SCRIPT, srcPath, dstPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `rasterizePdf.py exited ${exitCode}`);
  }
}

async function runChromeOcr(pdfPath: string, outFile: string): Promise<void> {
  const proc = Bun.spawn(
    [
      "powershell",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      PS_SCRIPT,
      "-PdfPath",
      pdfPath,
      "-OutFile",
      outFile,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  // Always surface the step-by-step timeline (window counts, close verification, WARNINGs)
  // regardless of success/failure - this was previously silently discarded on success,
  // which is exactly the visibility we need to catch a window-leak while watching the batch.
  for (const line of stdout.split("\n")) {
    if (line.trim()) console.log(`  ${line}`);
  }

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `chromeOcr.ps1 exited ${exitCode}`);
  }
}

async function ocrOneDocument(doc: { id: string; storageUrl: string; filename: string }, stats: Stats): Promise<void> {
  const db = prisma as any;
  const workDir = await mkdtemp(join(tmpdir(), "chrome-ocr-"));
  const outFile = join(workDir, "output.txt");

  try {
    console.log(`[ocr] ${doc.filename}`);

    const rasterizedPath = join(workDir, "rasterized.pdf");
    await rasterizePdf(doc.storageUrl, rasterizedPath);
    await runChromeOcr(rasterizedPath, outFile);

    const text = await readFile(outFile, "utf-8");
    if (!text.trim()) throw new Error("OCR produced empty text");

    await db.knowledgeDocument.update({
      where: { id: doc.id },
      data: { rawText: text, status: "CHUNKING", errorMessage: null, processingIssue: null },
    });

    await db.knowledgeChunk.deleteMany({ where: { documentId: doc.id } });
    const textChunks = chunkText(text);
    await db.knowledgeChunk.createMany({
      data: textChunks.map((content: string, index: number) => ({ documentId: doc.id, chunkIndex: index, content })),
    });

    await db.knowledgeDocument.update({ where: { id: doc.id }, data: { status: "READY" } });
    await docQueue.add("embed-chunks", { documentId: doc.id });

    console.log(`[ocr] fixed ${doc.filename} (${text.length} chars, ${textChunks.length} chunks)`);
    stats.fixed++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ocr] FAILED ${doc.filename}: ${message}`);
    stats.failed++;

    // Chrome couldn't open this file even from a local copy, or the source PDF itself
    // couldn't be rasterized (missing/empty/corrupt) - neither is a transient issue, so
    // don't leave it as NEEDS_OCR (the next batch run would just retry it forever).
    if (message.includes("PERSISTENT_ACCESS_FAILURE") || message.includes("RASTERIZE_ERROR")) {
      await db.knowledgeDocument
        .update({ where: { id: doc.id }, data: { errorMessage: message, processingIssue: "NEEDS_MANUAL_FIX" } })
        .catch(() => {});
      stats.skippedForGood++;
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Re-run OCR (via a real Chrome window's on-device text extraction) over every PDF
 * previously marked FAILED/NEEDS_OCR, and write successes straight into the knowledge
 * base - same rawText/chunk/embed-queue flow as ingestFiles.ts. This takes over the
 * screen/keyboard briefly (~15-80s) per document since it drives a real, visible browser.
 */
async function ocrChromeBatch(limit?: number): Promise<void> {
  const db = prisma as any;
  const docs = await db.knowledgeDocument.findMany({
    where: {
      fileType: "PDF",
      status: "FAILED",
      // Retrying NEEDS_MANUAL_FIX too: most of those were PERSISTENT_ACCESS_FAILURE from
      // Chrome navigating straight to the Y: path, which rasterizing (a local, non-Chrome
      // file read) sidesteps entirely - worth another shot now.
      processingIssue: { in: ["NEEDS_OCR", "NEEDS_MANUAL_FIX"] },
    },
    select: { id: true, storageUrl: true, filename: true },
    orderBy: { storageUrl: "asc" },
    ...(limit ? { take: limit } : {}),
  });

  console.log(`[ocr] ${docs.length} document(s) queued for Chrome OCR`);
  const stats: Stats = { fixed: 0, failed: 0, skippedForGood: 0 };

  for (const doc of docs) {
    await ocrOneDocument(doc, stats);
  }

  console.log(
    `\n[ocr] done — fixed ${stats.fixed}, failed ${stats.failed} (${stats.skippedForGood} marked NEEDS_MANUAL_FIX and won't be retried)`,
  );
}

// Usage: `bun src/ocrChromeBatch.ts [--limit N]`
if (import.meta.main) {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;

  ocrChromeBatch(limit)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { ocrChromeBatch };
