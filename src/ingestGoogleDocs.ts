import { Queue } from "bullmq";
import { prisma } from "../tools/prisma.ts";
import { chunkText } from "../tools/VectorTable.ts";
import { exportGoogleDoc, parseGoogleFileId } from "../tools/googleapi/index.ts";
import {
  buildOrgIndex,
  CATEGORY_VALUES,
  classifyProcessingIssue,
  deriveDocumentMetadata,
  toPrismaDate,
  type Category,
} from "../tools/documentMetadata.ts";
import { splitByOrgHeadings, type SectionOrg } from "../tools/orgSections.ts";
import { sensitiveDocumentReason } from "../tools/sensitiveContent.ts";
import { getOrgs } from "./datarequest.ts";

const docQueue = new Queue("document-processing", {
  connection: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
  },
});

const GDOC_PREFIX = "https://docs.google.com/document/d/";

/** A doc with at least this many org headings is a per-org notes doc and gets split. */
const MIN_ORG_SECTIONS = 3;

/**
 * Ingest Google Docs (URLs or ids) into the knowledge base as MD documents.
 *
 * Unlike the Egnyte import (files assumed immutable, ingested once), Google Docs are
 * living documents: every run re-exports the current version and replaces whatever was
 * ingested before. Run with no URLs to refresh every Google Doc already in the KB.
 *
 * Per-org notes docs ("FY2025 Org Notes": one section per grantee) are stored as one
 * KnowledgeDocument per org section, each with that org's govId, category
 * CG_REVIEW_NOTES and storageUrl `<doc url>#org=<govId or name>`, so org-scoped search
 * and the MCP's funding brief find them. Other docs are stored whole at the doc URL.
 *
 * Docs in the CG Google workspace are staff-authored, so provenance is always CG_INTERNAL.
 * documentYear comes from an "FY2025"/"2025" in the title, never the last-edited date.
 */
async function ingestGoogleDocs(urls: string[], extraCategories: Category[] = [], dryRun = false): Promise<void> {
  const db = prisma as any;
  const stats = { docs: 0, documentsWritten: 0, failed: 0 };

  const orgs = (await getOrgs()).filter((o) => o.govId);
  const orgIndex = buildOrgIndex(orgs.map((o) => ({ name: o.name, govId: o.govId })));
  const sectionOrgs: SectionOrg[] = orgs.map((o) => ({ name: o.name.trim(), govId: o.govId.trim() }));
  const fallbackOrgs = await knownOrgsWithoutGovId();

  for (const url of urls) {
    const fileId = parseGoogleFileId(url);
    const baseUrl = `${GDOC_PREFIX}${fileId}`;
    try {
      const doc = await exportGoogleDoc(fileId);
      if (!doc.text.trim()) throw new Error("doc exported with no text");

      const meta = deriveDocumentMetadata(
        { storageUrl: baseUrl, filename: `${doc.name}.md`, status: "PENDING", errorMessage: null },
        orgIndex,
      );
      const common = {
        fileType: "MD",
        status: "CHUNKING",
        errorMessage: null,
        processingIssue: null,
        fundingStatus: null,
        documentYear: yearFromTitle(doc.name) ?? meta.documentYear,
        documentDate: toPrismaDate(meta.documentDate),
        language: meta.language ?? "en",
        docProvenance: "CG_INTERNAL",
        isTemplate: meta.isTemplate,
        containsPii: meta.containsPii,
      };

      const sections = splitByOrgHeadings(doc.text, sectionOrgs, fallbackOrgs);
      const orgSections = mergeByOrg(sections.filter((s) => s.org));
      let records: any[];

      if (orgSections.length >= MIN_ORG_SECTIONS) {
        const category = [...new Set<Category>(["CG_REVIEW_NOTES", ...extraCategories])];
        records = orgSections.map((s) => ({
          ...common,
          filename: `${doc.name} — ${s.org!.name}.md`,
          storageUrl: `${baseUrl}#org=${encodeURIComponent(s.org!.govId ?? s.org!.name)}`,
          // Lead with the doc + org name so keyword search on either finds the section.
          rawText: `${doc.name} — ${s.org!.name}\n\n${s.text}`,
          orgGovId: s.org!.govId,
          orgName: s.org!.name,
          category,
        }));
        const preamble = sections.find((s) => !s.org)?.text ?? "";
        if (preamble.trim()) {
          records.unshift({
            ...common,
            filename: `${doc.name} — General.md`,
            storageUrl: `${baseUrl}#general`,
            rawText: `${doc.name} — General\n\n${preamble}`,
            orgGovId: null,
            orgName: null,
            category,
          });
        }
      } else {
        records = [
          {
            ...common,
            filename: `${doc.name}.md`,
            storageUrl: baseUrl,
            rawText: doc.text,
            orgGovId: meta.orgGovId,
            orgName: meta.orgName,
            category: [...new Set([...meta.category, ...extraCategories])],
          },
        ];
      }

      // Dropped records still clear their previous version below, so a doc that turns
      // sensitive is removed from the KB on its next refresh.
      records = records.filter((r) => {
        const reason = sensitiveDocumentReason(r.storageUrl, r.filename, r.rawText);
        if (reason) console.log(`[gdocs] excluded ${r.filename}: sensitive content (${reason})`);
        return !reason;
      });

      console.log(`[gdocs] "${doc.name}" (modified ${doc.modifiedTime ?? "?"}) -> ${records.length} document(s)`);
      for (const r of records) console.log(`    ${r.orgGovId ?? "(no govId)"}\t${r.rawText.length} chars\t${r.filename}`);
      stats.docs++;
      if (dryRun) continue;

      // Replace everything previously ingested from this doc (the whole doc, or its
      // sections — the set of orgs in it can change between runs).
      const sameDoc = { OR: [{ storageUrl: baseUrl }, { storageUrl: { startsWith: `${baseUrl}#` } }] };
      const oldIds = (await db.knowledgeDocument.findMany({ where: sameDoc, select: { id: true } })).map(
        (d: { id: string }) => d.id,
      );
      await db.$transaction([
        db.knowledgeChunk.deleteMany({ where: { documentId: { in: oldIds } } }),
        db.knowledgeDocument.deleteMany({ where: { id: { in: oldIds } } }),
      ]);

      for (const record of records) {
        const { id: documentId } = await db.knowledgeDocument.create({ data: record });
        const chunks = chunkText(record.rawText);
        await db.knowledgeChunk.createMany({
          data: chunks.map((content: string, chunkIndex: number) => ({ documentId, chunkIndex, content })),
        });
        await db.knowledgeDocument.update({ where: { id: documentId }, data: { status: "READY" } });
        await docQueue.add("embed-chunks", { documentId });
        stats.documentsWritten++;
      }
      console.log(`[gdocs] replaced ${oldIds.length} old document(s) with ${records.length}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[gdocs] FAILED ${baseUrl}: ${message}`);
      // The previous version stays in place; record the failure on it so it's visible.
      if (!dryRun) {
        await db.knowledgeDocument
          .updateMany({
            where: { OR: [{ storageUrl: baseUrl }, { storageUrl: { startsWith: `${baseUrl}#` } }] },
            data: { errorMessage: `refresh failed: ${message}` },
          })
          .catch(() => {});
      }
      stats.failed++;
    }
  }

  console.log(
    `\n[gdocs] done${dryRun ? " (dry run, nothing written)" : ""} — ${stats.docs} doc(s) processed, ` +
      `${stats.documentsWritten} document(s) written, ${stats.failed} failed`,
  );
}

/** An org can have more than one heading in a doc (revisited further down) — one document per org. */
function mergeByOrg<T extends { org: SectionOrg | null; text: string }>(sections: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const s of sections) {
    const key = s.org!.govId ?? s.org!.name;
    const prev = byKey.get(key);
    byKey.set(key, prev ? { ...prev, text: `${prev.text}\n\n${s.text}` } : s);
  }
  return [...byKey.values()];
}

/**
 * Grantee folders on the shared drive whose org has no data-request record (mostly
 * defunded orgs). Notes docs still have sections for them, and those must be split off
 * rather than run on into the previous org's section.
 */
async function knownOrgsWithoutGovId(): Promise<SectionOrg[]> {
  const rows = await prisma.$queryRaw<{ orgName: string }[]>`
    SELECT DISTINCT "orgName" FROM "KnowledgeDocument"
    WHERE "orgGovId" IS NULL AND "orgName" IS NOT NULL AND "storageUrl" ILIKE '%Grant_Organizations%'
  `;
  return rows.map((r) => ({ name: r.orgName, govId: null }));
}

/** Every Google Doc already in the KB, by base URL. */
async function ingestedGoogleDocUrls(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ url: string }[]>`
    SELECT DISTINCT split_part("storageUrl", '#', 1) AS url FROM "KnowledgeDocument"
    WHERE "storageUrl" LIKE ${`${GDOC_PREFIX}%`}
  `;
  return rows.map((r) => r.url);
}

function yearFromTitle(title: string): number | null {
  const m = title.match(/\b(?:FY\s?)?(20\d{2})\b/i);
  return m ? parseInt(m[1], 10) : null;
}

// Usage: `bun src/ingestGoogleDocs.ts [--dry-run] [--category=MEETING_NOTES,...] [<url-or-id> ...]`
// With no URLs, re-ingests every Google Doc already in the knowledge base.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const categoryArg = args.find((a) => a.startsWith("--category="));
  const categories = (categoryArg?.slice("--category=".length).split(",") ?? []).filter(Boolean) as Category[];
  const invalid = categories.filter((c) => !CATEGORY_VALUES.includes(c));
  if (invalid.length) {
    console.error(`Unknown category: ${invalid.join(", ")} (valid: ${CATEGORY_VALUES.join(", ")})`);
    process.exit(1);
  }

  (async () => {
    let urls = args.filter((a) => !a.startsWith("--"));
    if (!urls.length) {
      urls = await ingestedGoogleDocUrls();
      console.log(`[gdocs] no URLs given — refreshing all ${urls.length} Google Doc(s) in the knowledge base`);
    }
    await ingestGoogleDocs(urls, categories, dryRun);
  })()
    .then(async () => {
      await docQueue.close();
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { ingestGoogleDocs };
