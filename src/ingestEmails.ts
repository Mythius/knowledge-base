import { Queue } from "bullmq";
import { prisma } from "../tools/prisma.ts";
import { chunkText } from "../tools/VectorTable.ts";
import { getOrgs } from "./datarequest.ts";
import { buildOrgIndex, classifyEmail, fallbackFingerprint, isNoiseMessage, type ClassifyContext } from "../tools/emailClassify.ts";
import {
  getCurrentHistoryId,
  getMessageFull,
  getMessageMetadata,
  HistoryIdExpiredError,
  listAllMessageIds,
  listNewMessageIds,
  type ParsedMessage,
} from "../tools/gmail.ts";

const docQueue = new Queue("document-processing", {
  connection: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
  },
});

const MAILBOXES = (process.env.GMAIL_INGEST_MAILBOXES || "").split(",").map((s) => s.trim()).filter(Boolean);
const INTERNAL_DOMAIN = (process.env.GMAIL_INGEST_DOMAIN || "").toLowerCase();
// Bounds the very first backfill per mailbox so years of history don't take forever; override via env.
const BACKFILL_DAYS = parseInt(process.env.GMAIL_INGEST_BACKFILL_DAYS || "730", 10);
// How many messages within one mailbox to fetch/classify at once. Cross-mailbox races on
// the same Message-ID (e.g. an internal email in both Sent and Inbox) are already handled
// by the P2002 catch in ingestMessage, so this can safely be > 1.
const CONCURRENCY = parseInt(process.env.GMAIL_INGEST_CONCURRENCY || "8", 10);

/** Runs `fn` over `items` with at most `concurrency` in flight at once. */
async function pMap<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

interface Stats {
  created: number;
  skipped: number;
  failed: number;
  needsReview: Array<{ gmailId: string; subject: string }>;
}

async function buildClassifyContext(): Promise<ClassifyContext> {
  const db = prisma as any;
  const orgs = (await getOrgs()).filter((o) => o.govId);
  const orgIndex = buildOrgIndex(orgs.map((o) => ({ name: o.name, govId: o.govId })));
  const orgNameByGovId = new Map(orgs.map((o) => [o.govId, o.name]));

  const domainRows: { domain: string; govId: string }[] = await db.orgEmailDomain.findMany();
  const domainMap = new Map(domainRows.map((r) => [r.domain, r.govId]));

  return { orgIndex, domainMap, orgNameByGovId, internalDomain: INTERNAL_DOMAIN };
}

async function upsertChunks(documentId: string, text: string): Promise<void> {
  const db = prisma as any;
  await db.knowledgeChunk.deleteMany({ where: { documentId } });
  const textChunks = chunkText(text);
  await db.knowledgeChunk.createMany({
    data: textChunks.map((content: string, index: number) => ({ documentId, chunkIndex: index, content })),
  });
}

function formatRawText(msg: ParsedMessage): string {
  return `From: ${msg.from}\nTo: ${msg.to}\nCc: ${msg.cc}\nSubject: ${msg.subject}\nDate: ${msg.date}\n\n${msg.textBody}`;
}

function parseHeaderDate(date: string): Date | null {
  const parsed = new Date(date);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Fetch, classify, and (if relevant) persist one message. Never throws for an individual
 * message's own processing problems — logged and counted as failed so one bad message
 * can't stall the rest of a mailbox's sync or block its historyId cursor from advancing.
 */
async function ingestMessage(mailbox: string, gmailId: string, ctx: ClassifyContext, stats: Stats): Promise<void> {
  const db = prisma as any;
  try {
    const metadata = await getMessageMetadata(mailbox, gmailId);
    if (isNoiseMessage(metadata)) {
      stats.skipped++;
      return;
    }

    const msg = await getMessageFull(mailbox, gmailId);
    const fingerprint = msg.messageId || fallbackFingerprint(msg);

    const existing = await db.knowledgeDocument.findFirst({ where: { emailMessageId: fingerprint }, select: { id: true } });
    if (existing) {
      stats.skipped++;
      return;
    }

    const classification = await classifyEmail(msg, ctx);
    if (!classification.ingest) {
      // "See attached" emails with thin bodies fail text classification but are plausibly
      // exactly the financial/report content this pipeline is for — flag for a human look.
      if (msg.hasAttachment && msg.textBody.trim().length < 200) {
        stats.needsReview.push({ gmailId, subject: msg.subject });
      }
      stats.skipped++;
      return;
    }

    const rawText = formatRawText(msg);

    const created = await db.knowledgeDocument.create({
      data: {
        filename: msg.subject,
        fileType: "EMAIL",
        storageUrl: `gmail://${mailbox}/${gmailId}`,
        emailMessageId: fingerprint,
        rawText,
        status: "CHUNKING",
        orgGovId: classification.orgGovId,
        orgName: classification.orgName,
        documentDate: parseHeaderDate(msg.date),
        category: classification.categories,
        language: "en",
        docProvenance: classification.docProvenance,
      },
    });

    await upsertChunks(created.id, rawText);
    await db.knowledgeDocument.update({ where: { id: created.id }, data: { status: "READY" } });
    await docQueue.add("embed-chunks", { documentId: created.id });

    console.log(`[ingest-emails] ${mailbox}: created document for "${msg.subject}" (${classification.orgName ?? "no org"})`);
    stats.created++;
  } catch (err: any) {
    if (err?.code === "P2002") {
      // Lost a race with another concurrent ingest (same mailbox or a different one) that
      // created this Message-ID first.
      stats.skipped++;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ingest-emails] FAILED on ${mailbox}/${gmailId}: ${message}`);
    stats.failed++;
  }
}

async function processIds(mailbox: string, ids: AsyncGenerator<string>, ctx: ClassifyContext, stats: Stats): Promise<void> {
  const gmailIds: string[] = [];
  for await (const id of ids) gmailIds.push(id);
  await pMap(gmailIds, CONCURRENCY, (gmailId) => ingestMessage(mailbox, gmailId, ctx, stats));
}

async function fullBackfill(mailbox: string, since: Date, ctx: ClassifyContext, stats: Stats): Promise<void> {
  await processIds(mailbox, listAllMessageIds(mailbox, since), ctx, stats);
  const historyId = await getCurrentHistoryId(mailbox);
  const db = prisma as any;
  await db.emailSyncState.upsert({
    where: { mailbox },
    create: { mailbox, historyId, lastSyncedAt: new Date() },
    update: { historyId, lastSyncedAt: new Date() },
  });
}

async function syncMailbox(mailbox: string, ctx: ClassifyContext, stats: Stats): Promise<void> {
  const db = prisma as any;
  const state = await db.emailSyncState.findUnique({ where: { mailbox } });

  if (!state?.historyId) {
    console.log(`[ingest-emails] ${mailbox}: no prior sync state, doing bounded backfill (last ${BACKFILL_DAYS}d)`);
    await fullBackfill(mailbox, new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000), ctx, stats);
    return;
  }

  try {
    console.log(`[ingest-emails] ${mailbox}: incremental sync from historyId ${state.historyId}`);
    await processIds(mailbox, listNewMessageIds(mailbox, state.historyId), ctx, stats);
    const historyId = await getCurrentHistoryId(mailbox);
    await db.emailSyncState.update({ where: { mailbox }, data: { historyId, lastSyncedAt: new Date() } });
  } catch (err) {
    if (err instanceof HistoryIdExpiredError) {
      // Gmail doesn't guarantee history retention (can be as little as ~7 days on a quiet
      // mailbox) — fall back to a bounded scan from the last successful sync, not from
      // scratch, then re-seed the cursor.
      console.warn(`[ingest-emails] ${mailbox}: historyId expired, falling back to bounded scan since last sync`);
      const since = state.lastSyncedAt ?? new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000);
      await fullBackfill(mailbox, since, ctx, stats);
      return;
    }
    throw err;
  }
}

/**
 * Periodic entry point: syncs every configured mailbox concurrently, and within each
 * mailbox classifies+ingests up to CONCURRENCY messages at once. A dedup race between two
 * mailboxes seeing the same message (or two messages within a mailbox) is caught by the
 * P2002 unique-constraint handler in ingestMessage rather than avoided via serialization —
 * stats/needsReview are plain in-memory mutations, safe under async interleaving since
 * there's no real thread-level concurrency. Only messages that resolve to a known partner
 * org, or match a configured topic and pass the LLM relevance check, are ever persisted —
 * everything else is discarded without being written to the database.
 */
async function ingestEmails(mailboxes: string[]): Promise<void> {
  if (!mailboxes.length) throw new Error("No mailboxes configured — set GMAIL_INGEST_MAILBOXES");
  if (!INTERNAL_DOMAIN) throw new Error("GMAIL_INGEST_DOMAIN not set");

  const stats: Stats = { created: 0, skipped: 0, failed: 0, needsReview: [] };
  const ctx = await buildClassifyContext();
  console.log(`[ingest-emails] loaded ${ctx.orgIndex.orgs.length} orgs, ${ctx.domainMap.size} domain mappings`);

  await Promise.all(
    mailboxes.map(async (mailbox) => {
      try {
        await syncMailbox(mailbox, ctx, stats);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ingest-emails] ${mailbox}: sync failed — ${message}`);
        stats.failed++;
      }
    }),
  );

  console.log(`\n[ingest-emails] done — created ${stats.created}, skipped ${stats.skipped}, failed ${stats.failed}`);
  if (stats.needsReview.length) {
    console.log(`[ingest-emails] ${stats.needsReview.length} message(s) skipped but look attachment-heavy — review manually:`);
    for (const m of stats.needsReview) console.log(`  - ${m.gmailId}: ${m.subject}`);
  }
}

// Usage: `bun src/ingestEmails.ts`, configured via GMAIL_INGEST_MAILBOXES / GMAIL_INGEST_DOMAIN
if (import.meta.main) {
  ingestEmails(MAILBOXES)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { ingestEmails };
