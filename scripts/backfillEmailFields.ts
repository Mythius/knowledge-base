/**
 * Backfill for the structured email columns added in prisma/migrations/add_email_structure
 * (emailThreadId, emailThreadKey, emailFrom/To/Cc, emailSentAt, emailDirection, emailBody).
 *
 * Everything except emailThreadId is recovered from the stored rawText (the header block
 * ingestEmails.ts's formatRawText writes). emailThreadId needs the In-Reply-To/References
 * headers, which were never stored — pass --fetch-headers to pull them from Gmail
 * (one metadata call per message, needs the same service-account setup as ingestion).
 * Without it emailThreadId stays null and consumers group threads by emailThreadKey.
 *
 * Safe to re-run: by default only touches EMAIL rows where emailBody is still null.
 * --force recomputes every EMAIL row (e.g. after changing rules in tools/emailParse.ts).
 *
 * Usage:
 *   bun scripts/backfillEmailFields.ts                     # dry run: report + samples
 *   bun scripts/backfillEmailFields.ts --apply
 *   bun scripts/backfillEmailFields.ts --apply --fetch-headers
 *   bun scripts/backfillEmailFields.ts --apply --force --limit 100
 */
import { sql } from "../tools/db.ts";
import { deriveEmailFields, parseRawText, threadRootId, type EmailFields } from "../tools/emailParse.ts";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FORCE = args.includes("--force");
const FETCH_HEADERS = args.includes("--fetch-headers");
const limitArg = args.find((a) => a.startsWith("--limit"));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1] ?? args[args.indexOf(limitArg) + 1], 10) : undefined;
const INTERNAL_DOMAIN = (process.env.GMAIL_INGEST_DOMAIN || "cgcharitable.org").toLowerCase();
const CONCURRENCY = 10;

interface Row {
  id: string;
  rawText: string | null;
  storageUrl: string;
  emailMessageId: string | null;
}

async function fetchRows(): Promise<Row[]> {
  const filter = FORCE ? sql`` : sql`AND "emailBody" IS NULL`;
  const limitClause = LIMIT ? sql`LIMIT ${LIMIT}` : sql``;
  return sql<Row[]>`
    SELECT id, "rawText", "storageUrl", "emailMessageId"
    FROM "KnowledgeDocument"
    WHERE "fileType" = 'EMAIL' ${filter}
    ORDER BY "documentDate" NULLS LAST
    ${limitClause}
  `;
}

/** storageUrl is gmail://<mailbox>/<gmailId> (see ingestEmails.ts). */
function gmailLocation(storageUrl: string): { mailbox: string; gmailId: string } | null {
  const m = storageUrl.match(/^gmail:\/\/([^/]+)\/(.+)$/);
  return m ? { mailbox: m[1], gmailId: m[2] } : null;
}

async function fetchThreadHeaders(row: Row): Promise<{ inReplyTo: string | null; references: string | null } | null> {
  const loc = gmailLocation(row.storageUrl);
  if (!loc) return null;
  // Imported lazily so a plain rawText-only run doesn't need Gmail credentials at all.
  const { getMessageMetadata } = await import("../tools/gmail.ts");
  try {
    const meta = await getMessageMetadata(loc.mailbox, loc.gmailId);
    const header = (name: string) =>
      meta.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
    return { inReplyTo: header("In-Reply-To"), references: header("References") };
  } catch (err) {
    console.warn(`  ! header fetch failed for ${row.storageUrl}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function derive(row: Row): Promise<EmailFields> {
  const parsed = parseRawText(row.rawText ?? "");
  const fields = deriveEmailFields({ ...parsed, textBody: parsed.body }, INTERNAL_DOMAIN);
  // Without References/In-Reply-To, threadRootId would fall back to the message's own
  // Message-ID, making every message its own "thread" — leave it null instead so consumers
  // fall back to emailThreadKey grouping.
  fields.emailThreadId = null;
  if (FETCH_HEADERS) {
    const headers = await fetchThreadHeaders(row);
    if (headers) fields.emailThreadId = threadRootId(row.emailMessageId, headers.inReplyTo, headers.references);
  }
  return fields;
}

async function main() {
  const rows = await fetchRows();
  console.log(`${rows.length} EMAIL row(s) to process${FORCE ? " (--force)" : ""}${FETCH_HEADERS ? ", fetching thread headers from Gmail" : ""}`);

  let rawChars = 0;
  let bodyChars = 0;
  const directions = new Map<string, number>();
  const samples: { id: string; before: number; after: number; preview: string }[] = [];
  let done = 0;

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (row) => {
        const f = await derive(row);
        rawChars += row.rawText?.length ?? 0;
        bodyChars += f.emailBody.length;
        directions.set(f.emailDirection ?? "(null)", (directions.get(f.emailDirection ?? "(null)") ?? 0) + 1);
        if (samples.length < 5 && (row.rawText?.length ?? 0) > 3000) {
          samples.push({ id: row.id, before: row.rawText!.length, after: f.emailBody.length, preview: f.emailBody.slice(0, 300) });
        }
        if (APPLY) {
          await sql`
            UPDATE "KnowledgeDocument" SET
              "emailThreadId" = ${f.emailThreadId},
              "emailThreadKey" = ${f.emailThreadKey},
              "emailFrom" = ${f.emailFrom},
              "emailTo" = ${f.emailTo},
              "emailCc" = ${f.emailCc},
              "emailSentAt" = ${f.emailSentAt},
              "emailDirection" = ${f.emailDirection},
              "emailBody" = ${f.emailBody}
            WHERE id = ${row.id}
          `;
        }
      }),
    );
    done += batch.length;
    if (done % 500 < CONCURRENCY) console.log(`  ${done}/${rows.length}`);
  }

  console.log(`\nrawText ${rawChars.toLocaleString()} chars -> emailBody ${bodyChars.toLocaleString()} chars ` +
    `(${rawChars ? Math.round((1 - bodyChars / rawChars) * 100) : 0}% removed as quoted history/signatures)`);
  console.log("emailDirection:", Object.fromEntries(directions));
  for (const s of samples) console.log(`\n--- ${s.id}: ${s.before} -> ${s.after} chars\n${s.preview}`);
  console.log(APPLY ? "\nApplied." : "\nDry run — pass --apply to write.");
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
