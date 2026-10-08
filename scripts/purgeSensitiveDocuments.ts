/**
 * Removes already-ingested CG staff personnel data from the knowledge base, using the
 * same rules ingestion now applies (tools/sensitiveContent.ts). Re-run after changing
 * those rules so stored content matches what ingestion would accept today.
 *
 * - Files/docs: path + filename rules, then the extracted-text rules.
 * - Emails: sender/recipient domain, subject and body rules. A hit on a message that
 *   isn't partner-org correspondence takes its whole Gmail thread with it, since replies
 *   usually carry the same content without repeating the keyword.
 * - --llm also asks the classifier model (AI_CHAT_PROVIDER) whether each non-partner email
 *   that mentions pay/performance wording is about CG staff — the same check ingestion runs.
 * - --gmail-labels also removes emails carrying an excluded Gmail label
 *   (GMAIL_INGEST_EXCLUDE_LABELS, default "CLASSIFIED,payroll") in any configured mailbox.
 * - --id <uuid> (repeatable) adds documents the rules can't catch; their threads are
 *   included too. --keep <uuid> (repeatable) spares a false positive.
 *
 * Content-excluded placeholders written by ingestion (no text, errorMessage "excluded: …")
 * are left alone — they hold nothing and stop the file being re-extracted.
 *
 * Usage:
 *   bun scripts/purgeSensitiveDocuments.ts                 # dry run: list what would go
 *   bun scripts/purgeSensitiveDocuments.ts --apply
 *   bun scripts/purgeSensitiveDocuments.ts --llm --gmail-labels    # dry run incl. both extra passes
 *   bun scripts/purgeSensitiveDocuments.ts --apply --id <uuid> --id <uuid>
 */
import { sql } from "../tools/db.ts";
import { sensitiveEmailReason, sensitiveFileReason, sensitiveTextReason } from "../tools/sensitiveContent.ts";
import { isStaffPersonnelEmail } from "../tools/emailClassify.ts";
import { findLabelIds, getMessageMetadata, listMessageIdsWithLabels } from "../tools/gmail.ts";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const USE_LLM = args.includes("--llm");
const GMAIL_LABELS = args.includes("--gmail-labels");
const EXCLUDE_LABELS = (process.env.GMAIL_INGEST_EXCLUDE_LABELS || "CLASSIFIED,payroll").split(",");
const MAILBOXES = (process.env.GMAIL_INGEST_MAILBOXES || "").split(",").map((s) => s.trim()).filter(Boolean);
const argValues = (flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
const EXTRA_IDS = argValues("--id");
const KEEP_IDS = new Set(argValues("--keep"));
const INTERNAL_DOMAIN = (process.env.GMAIL_INGEST_DOMAIN || "cgcharitable.org").toLowerCase();
const BATCH = 200;

interface Hit {
  id: string;
  fileType: string;
  filename: string;
  storageUrl: string;
  reason: string;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

function partnerDomainsOf(participants: string, domainMap: Set<string>): string[] {
  const domains = (participants.match(EMAIL_RE) ?? []).map((e) => e.slice(e.indexOf("@") + 1).toLowerCase());
  return [...new Set(domains)].filter((d) => d !== INTERNAL_DOMAIN && domainMap.has(d));
}

async function main(): Promise<void> {
  const domainMap = new Set<string>((await sql`SELECT domain FROM "OrgEmailDomain"`).map((r: any) => r.domain));
  const hits = new Map<string, Hit>();
  const threadsToExpand = new Set<string>();
  const llmCandidates: { id: string; subject: string; body: string; threadId: string | null; hit: Omit<Hit, "reason"> }[] = [];

  const cursor = sql`
    SELECT id, "fileType", filename, "storageUrl", "orgGovId", "rawText", "errorMessage",
           "emailFrom", "emailTo", "emailCc", "emailBody", "emailThreadId"
    FROM "KnowledgeDocument"
  `.cursor(BATCH);

  for await (const rows of cursor) {
    for (const r of rows as any[]) {
      if (!r.rawText && r.errorMessage?.startsWith("excluded:")) continue;

      let reason: string | null;
      if (r.fileType === "EMAIL") {
        const email = {
          from: r.emailFrom ?? "",
          to: r.emailTo ?? "",
          cc: r.emailCc ?? "",
          subject: r.filename,
          textBody: r.emailBody ?? r.rawText ?? "",
        };
        const partners = partnerDomainsOf(`${email.from} ${email.to} ${email.cc}`, domainMap);
        reason = sensitiveEmailReason(email, partners);
        if (reason && !partners.length && r.emailThreadId) threadsToExpand.add(r.emailThreadId);
        if (!reason && !partners.length && USE_LLM) {
          llmCandidates.push({
            id: r.id,
            subject: email.subject,
            body: email.textBody,
            threadId: r.emailThreadId,
            hit: { id: r.id, fileType: r.fileType, filename: r.filename, storageUrl: r.storageUrl },
          });
        }
      } else {
        reason = sensitiveFileReason(r.storageUrl, r.filename) ?? (r.rawText ? sensitiveTextReason(r.storageUrl, r.rawText) : null);
      }
      if (reason) hits.set(r.id, { id: r.id, fileType: r.fileType, filename: r.filename, storageUrl: r.storageUrl, reason });
    }
  }

  for (const c of llmCandidates) {
    if (await isStaffPersonnelEmail(c.subject, c.body)) {
      hits.set(c.id, { ...c.hit, reason: "CG staff compensation/performance (LLM)" });
      if (c.threadId) threadsToExpand.add(c.threadId);
    }
  }

  if (GMAIL_LABELS) {
    if (!MAILBOXES.length) throw new Error("--gmail-labels needs GMAIL_INGEST_MAILBOXES");
    const messageIds = new Set<string>();
    for (const mailbox of MAILBOXES) {
      const labelIds = await findLabelIds(mailbox, EXCLUDE_LABELS);
      for await (const gmailId of listMessageIdsWithLabels(mailbox, labelIds)) {
        const meta = await getMessageMetadata(mailbox, gmailId);
        const messageId = meta.payload?.headers?.find((h) => h.name?.toLowerCase() === "message-id")?.value;
        if (messageId) messageIds.add(messageId);
      }
      console.log(`${mailbox}: ${labelIds.size} excluded label(s)`);
    }
    if (messageIds.size) {
      const labelled = await sql`
        SELECT id, "fileType", filename, "storageUrl", "emailThreadId" FROM "KnowledgeDocument"
        WHERE "emailMessageId" IN ${sql([...messageIds])}
      `;
      for (const r of labelled as any[]) {
        hits.set(r.id, { id: r.id, fileType: r.fileType, filename: r.filename, storageUrl: r.storageUrl, reason: "excluded Gmail label" });
        if (r.emailThreadId) threadsToExpand.add(r.emailThreadId);
      }
    }
  }

  if (EXTRA_IDS.length) {
    const extra = await sql`
      SELECT id, "fileType", filename, "storageUrl", "emailThreadId" FROM "KnowledgeDocument" WHERE id IN ${sql(EXTRA_IDS)}
    `;
    const missing = EXTRA_IDS.filter((id) => !extra.some((r: any) => r.id === id));
    if (missing.length) throw new Error(`--id not found: ${missing.join(", ")}`);
    for (const r of extra as any[]) {
      hits.set(r.id, { id: r.id, fileType: r.fileType, filename: r.filename, storageUrl: r.storageUrl, reason: "explicit --id" });
      if (r.emailThreadId) threadsToExpand.add(r.emailThreadId);
    }
  }

  if (threadsToExpand.size) {
    const siblings = await sql`
      SELECT id, "fileType", filename, "storageUrl" FROM "KnowledgeDocument"
      WHERE "fileType" = 'EMAIL' AND "orgGovId" IS NULL AND "emailThreadId" IN ${sql([...threadsToExpand])}
    `;
    for (const r of siblings as any[]) {
      if (!hits.has(r.id)) {
        hits.set(r.id, { id: r.id, fileType: r.fileType, filename: r.filename, storageUrl: r.storageUrl, reason: "same thread as a sensitive email" });
      }
    }
  }

  for (const id of KEEP_IDS) hits.delete(id);

  const byReason = new Map<string, Hit[]>();
  for (const h of hits.values()) byReason.set(h.reason, [...(byReason.get(h.reason) ?? []), h]);
  for (const [reason, list] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${reason} — ${list.length}`);
    for (const h of list.sort((a, b) => a.storageUrl.localeCompare(b.storageUrl))) {
      console.log(`  ${h.id}  ${h.fileType.padEnd(5)}  ${h.fileType === "EMAIL" ? h.filename : h.storageUrl}`);
    }
  }
  console.log(`\n${hits.size} document(s) ${APPLY ? "to delete" : "would be deleted (dry run — pass --apply)"}`);

  if (!APPLY || !hits.size) return;
  const ids = [...hits.keys()];
  await sql.begin(async (tx) => {
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      await tx`DELETE FROM "KnowledgeChunk" WHERE "documentId" IN ${sql(batch)}`;
      await tx`DELETE FROM "KnowledgeDocument" WHERE id IN ${sql(batch)}`;
    }
  });
  console.log(`deleted ${ids.length} document(s) and their chunks`);
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error(err);
    await sql.end();
    process.exit(1);
  });
