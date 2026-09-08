/**
 * One-off (but re-runnable) backfill for the searchability columns added to
 * KnowledgeDocument in prisma/migrations/add_document_metadata (orgGovId, orgName,
 * fundingStatus, documentYear, documentDate, category, language, docProvenance,
 * isTemplate, containsPii, processingIssue).
 *
 * Safe to re-run: by default it only touches rows that look untouched (orgGovId,
 * documentYear, category, and docProvenance all still at their initial/empty state),
 * so running it again after a fresh `bun src/ingestFiles.ts` only tags the new rows.
 * Pass --force to recompute and overwrite every row (e.g. after improving the
 * classification rules in tools/documentMetadata.ts).
 *
 * Usage:
 *   bun scripts/backfillDocumentMetadata.ts              # dry run, prints a report
 *   bun scripts/backfillDocumentMetadata.ts --apply       # writes the changes
 *   bun scripts/backfillDocumentMetadata.ts --apply --force
 *   bun scripts/backfillDocumentMetadata.ts --limit 50    # try it on a subset first
 */
import { sql } from "../tools/db.ts";
import {
  buildOrgIndex,
  deriveDocumentMetadata,
  type DerivedMetadata,
  type DocumentInput,
  type OrgRef,
} from "../tools/documentMetadata.ts";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FORCE = args.includes("--force");
const limitArg = args.find((a) => a.startsWith("--limit"));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1] ?? args[args.indexOf(limitArg) + 1], 10) : undefined;

/** Minimal standalone fetch of the org directory — deliberately not importing
 * src/datarequest.ts here, since that module opens a BullMQ/Redis connection as a
 * side effect of import, which this read-mostly script has no need for. */
async function fetchOrgList(): Promise<OrgRef[]> {
  const res = await fetch("https://datarequest.cgcharitable.org/api/organization", {
    headers: { Authorization: process.env.DR_API_KEY! },
  });
  if (!res.ok) throw new Error(`Failed to fetch org list: ${res.status} ${await res.text()}`);
  const orgs = (await res.json()) as { name: string; govId: string | null }[];
  return orgs.filter((o): o is OrgRef => Boolean(o.govId)).map((o) => ({ name: o.name, govId: o.govId! }));
}

interface Row {
  id: string;
  filename: string;
  storageUrl: string;
  status: string;
  errorMessage: string | null;
}

async function fetchRows(): Promise<Row[]> {
  const untouchedFilter = FORCE
    ? sql``
    : sql`WHERE "orgGovId" IS NULL
            AND "documentYear" IS NULL
            AND "docProvenance" IS NULL
            AND category = '{}'`;
  const limitClause = LIMIT ? sql`LIMIT ${LIMIT}` : sql``;
  return sql<Row[]>`
    SELECT id, filename, "storageUrl", status, "errorMessage"
    FROM "KnowledgeDocument"
    ${untouchedFilter}
    ORDER BY "createdAt"
    ${limitClause}
  `;
}

function summarize(results: { row: Row; meta: DerivedMetadata }[]) {
  const count = <T extends string | null>(pick: (m: DerivedMetadata) => T) => {
    const counts = new Map<string, number>();
    for (const { meta } of results) {
      const key = pick(meta) ?? "(null)";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };

  const categoryCounts = new Map<string, number>();
  for (const { meta } of results) {
    for (const c of meta.category) categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1);
    if (meta.category.length === 0) categoryCounts.set("(uncategorized)", (categoryCounts.get("(uncategorized)") ?? 0) + 1);
  }

  const unmatched = new Map<string, number>();
  for (const { meta } of results) {
    if (meta.unmatchedOrgLabel) unmatched.set(meta.unmatchedOrgLabel, (unmatched.get(meta.unmatchedOrgLabel) ?? 0) + 1);
  }

  console.log(`\n=== Backfill report (${results.length} row(s) considered) ===\n`);

  console.log(`Org match: ${results.filter((r) => r.meta.orgGovId).length} resolved to a govId, ` +
    `${results.filter((r) => !r.meta.orgGovId && r.meta.orgName).length} have a name but no govId, ` +
    `${results.filter((r) => !r.meta.orgName).length} have neither (not org-scoped, e.g. trip media/uploads).`);

  console.log("\nfundingStatus:");
  for (const [k, v] of count((m) => m.fundingStatus)) console.log(`  ${k}: ${v}`);

  console.log("\ndocProvenance:");
  for (const [k, v] of count((m) => m.docProvenance)) console.log(`  ${k}: ${v}`);

  console.log("\ncategory (multi-value, counts sum > row count):");
  for (const [k, v] of [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);

  console.log("\nprocessingIssue (FAILED docs only):");
  for (const [k, v] of count((m) => m.processingIssue)) if (k !== "(null)") console.log(`  ${k}: ${v}`);

  console.log(`\nisTemplate: ${results.filter((r) => r.meta.isTemplate).length}`);
  console.log(`containsPii (heuristic — review before relying on it): ${results.filter((r) => r.meta.containsPii).length}`);

  if (unmatched.size) {
    console.log(`\n${unmatched.size} distinct org folder label(s) did not resolve to a govId — ` +
      `add to ORG_ALIASES in tools/documentMetadata.ts if they're a known org under a different name:`);
    for (const [k, v] of [...unmatched.entries()].sort((a, b) => b[1] - a[1])) console.log(`  "${k}": ${v} doc(s)`);
  }
}

async function applyUpdates(results: { row: Row; meta: DerivedMetadata }[]) {
  const CONCURRENCY = 20;
  let done = 0;
  for (let i = 0; i < results.length; i += CONCURRENCY) {
    const batch = results.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(({ row, meta }) =>
        sql`
          UPDATE "KnowledgeDocument" SET
            "orgGovId" = ${meta.orgGovId},
            "orgName" = ${meta.orgName},
            "fundingStatus" = ${meta.fundingStatus},
            "documentYear" = ${meta.documentYear},
            "documentDate" = ${meta.documentDate},
            "category" = ${meta.category},
            "language" = ${meta.language},
            "docProvenance" = ${meta.docProvenance},
            "isTemplate" = ${meta.isTemplate},
            "containsPii" = ${meta.containsPii},
            "processingIssue" = ${meta.processingIssue}
          WHERE id = ${row.id}
        `,
      ),
    );
    done += batch.length;
    console.log(`[backfill] updated ${done}/${results.length}`);
  }
}

async function main() {
  console.log(`[backfill] mode: ${APPLY ? "APPLY (writing changes)" : "DRY RUN (pass --apply to write)"}${FORCE ? ", FORCE (reprocessing already-tagged rows)" : ""}`);

  console.log("[backfill] fetching org directory…");
  const orgs = await fetchOrgList();
  const orgIndex = buildOrgIndex(orgs);
  console.log(`[backfill] loaded ${orgs.length} orgs`);

  const rows = await fetchRows();
  console.log(`[backfill] ${rows.length} document(s) to process`);
  if (!rows.length) return;

  const results = rows.map((row) => ({
    row,
    meta: deriveDocumentMetadata(row as DocumentInput, orgIndex),
  }));

  summarize(results);

  if (APPLY) {
    console.log("\n[backfill] applying updates…");
    await applyUpdates(results);
    console.log("[backfill] done.");
  } else {
    console.log("\n[backfill] dry run only — no rows were changed. Re-run with --apply to write.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
