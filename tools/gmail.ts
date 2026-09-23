/**
 * Gmail read access for src/ingestEmails.ts via Google Workspace domain-wide delegation —
 * a single admin-authorized service account impersonates each of the org's mailboxes
 * (no per-user OAuth consent, no app passwords). Setup:
 *   1. Create a GCP service account, enable domain-wide delegation on it.
 *   2. In Workspace Admin Console -> Security -> API Controls -> Domain-wide Delegation,
 *      authorize its numeric OAuth Client ID (NOT its email) for scope
 *      https://www.googleapis.com/auth/gmail.readonly — nothing broader.
 *   3. Save the service account's JSON key to tools/googleapi/gmail-service-account.json
 *      (already gitignored, see .gitignore's `tools/googleapi/*.json`) or set
 *      GMAIL_INGEST_SERVICE_ACCOUNT_KEY to inline JSON.
 * Propagation of the Admin Console authorization can take up to ~24h; an
 * `unauthorized_client` error right after setup is expected, not a bug.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { google, type gmail_v1 } from "googleapis";
import libmime from "libmime";
import { convert } from "html-to-text";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const DEFAULT_KEY_PATH = join(process.cwd(), "tools/googleapi/gmail-service-account.json");

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

let cachedKey: ServiceAccountKey | null = null;

function loadServiceAccountKey(): ServiceAccountKey {
  if (cachedKey) return cachedKey;
  const raw = process.env.GMAIL_INGEST_SERVICE_ACCOUNT_KEY;
  const json = raw?.trim().startsWith("{") ? raw : readFileSync(raw || DEFAULT_KEY_PATH, "utf-8");
  cachedKey = JSON.parse(json);
  return cachedKey!;
}

function gmailClientFor(mailbox: string): gmail_v1.Gmail {
  const key = loadServiceAccountKey();
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SCOPES,
    subject: mailbox,
  });
  return google.gmail({ version: "v1", auth });
}

export interface ParsedMessage {
  gmailId: string;
  messageId: string | null; // RFC822 Message-ID header
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  textBody: string;
  hasAttachment: boolean;
}

/** Thrown when a stored historyId has aged out of Gmail's retention window. */
export class HistoryIdExpiredError extends Error {
  constructor(mailbox: string) {
    super(`historyId expired/invalid for ${mailbox} — needs a fresh bounded backfill`);
    this.name = "HistoryIdExpiredError";
  }
}

function decodeHeaderValue(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return libmime.decodeWords(value);
  } catch {
    return value;
  }
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | null {
  const h = headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

function decodeBody(data: string | null | undefined): string {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf-8");
}

/**
 * Walk the MIME tree Gmail already parsed and return the best-effort plain-text body
 * (prefers text/plain, falls back to a stripped text/html) plus whether any part looks
 * like a real attachment (has a filename — inline images without one are ignored).
 */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): { text: string; hasAttachment: boolean } {
  let plain: string | null = null;
  let html: string | null = null;
  let hasAttachment = false;

  function walk(part: gmail_v1.Schema$MessagePart | undefined): void {
    if (!part) return;
    if (part.filename) hasAttachment = true;
    if (part.mimeType === "text/plain" && plain === null) plain = decodeBody(part.body?.data);
    else if (part.mimeType === "text/html" && html === null) html = decodeBody(part.body?.data);
    for (const child of part.parts ?? []) walk(child);
  }
  walk(payload);

  if (plain !== null) return { text: plain, hasAttachment };
  if (html !== null) {
    return { text: convert(html, { wordwrap: false }), hasAttachment };
  }
  return { text: "", hasAttachment };
}

function parseMessage(msg: gmail_v1.Schema$Message): ParsedMessage {
  const headers = msg.payload?.headers;
  const { text, hasAttachment } = extractBody(msg.payload);
  return {
    gmailId: msg.id!,
    messageId: header(headers, "Message-ID"),
    from: decodeHeaderValue(header(headers, "From")),
    to: decodeHeaderValue(header(headers, "To")),
    cc: decodeHeaderValue(header(headers, "Cc")),
    subject: decodeHeaderValue(header(headers, "Subject")) || "(no subject)",
    date: header(headers, "Date") || "",
    textBody: text,
    hasAttachment,
  };
}

/** Cheap headers-only fetch for the noise-filter pass before paying for a full body fetch. */
export async function getMessageMetadata(mailbox: string, gmailId: string): Promise<gmail_v1.Schema$Message> {
  const gmail = gmailClientFor(mailbox);
  const res = await gmail.users.messages.get({
    userId: "me",
    id: gmailId,
    format: "metadata",
    metadataHeaders: ["From", "To", "Cc", "Subject", "Date", "Message-ID", "List-Id", "List-Unsubscribe", "Precedence"],
  });
  return res.data;
}

export async function getMessageFull(mailbox: string, gmailId: string): Promise<ParsedMessage> {
  const gmail = gmailClientFor(mailbox);
  const res = await gmail.users.messages.get({ userId: "me", id: gmailId, format: "full" });
  return parseMessage(res.data);
}

/** Bounded full backfill — used on first run per mailbox, or after a historyId expires. */
export async function* listAllMessageIds(mailbox: string, after?: Date): AsyncGenerator<string> {
  const gmail = gmailClientFor(mailbox);
  const q = after ? `after:${Math.floor(after.getTime() / 1000)}` : undefined;
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({ userId: "me", q, pageToken, maxResults: 500 });
    for (const m of res.data.messages ?? []) if (m.id) yield m.id;
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
}

/** Incremental sync — only messages added since startHistoryId. Throws HistoryIdExpiredError on a stale cursor. */
export async function* listNewMessageIds(mailbox: string, startHistoryId: string): AsyncGenerator<string> {
  const gmail = gmailClientFor(mailbox);
  let pageToken: string | undefined;
  do {
    let res;
    try {
      res = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded"],
        pageToken,
        maxResults: 500,
      });
    } catch (err: any) {
      if (err?.response?.status === 404) throw new HistoryIdExpiredError(mailbox);
      throw err;
    }
    for (const h of res.data.history ?? []) {
      for (const added of h.messagesAdded ?? []) {
        if (added.message?.id) yield added.message.id;
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
}

/** Current historyId for a mailbox — used to seed EmailSyncState after a full backfill. */
export async function getCurrentHistoryId(mailbox: string): Promise<string> {
  const gmail = gmailClientFor(mailbox);
  const res = await gmail.users.getProfile({ userId: "me" });
  return res.data.historyId!;
}
