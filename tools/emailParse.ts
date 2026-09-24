/**
 * Pure helpers for turning an ingested email into structured, thread-aware fields
 * (KnowledgeDocument.email* columns). Used at ingestion time by src/ingestEmails.ts and
 * for pre-existing rows by scripts/backfillEmailFields.ts.
 *
 * cg-mcp (../cg-mcp/src/kb/emailParse.js) carries a JS port of stripQuotedReply,
 * normalizeSubject and classifyDirection as a fallback for rows that haven't been
 * backfilled yet — keep the two in sync when changing the rules here.
 */

export type EmailDirection = "INBOUND" | "OUTBOUND" | "INTERNAL";

// "Re:", "Fwd:", "FW:", localized variants ("AW:", "SV:", "RV:", "RES:", "ENC:", "TR:"),
// counters like "Re[2]:", and bracketed tags like "[EXTERNAL]" — possibly repeated.
const SUBJECT_PREFIX = /^\s*(?:(?:re|fw|fwd|aw|sv|tr|rv|res|enc)\s*(?:\[\d+\])?\s*:\s*|\[[^\]]{1,30}\]\s*)+/i;

/** Thread-grouping key from a subject: prefixes stripped, lowercased, whitespace collapsed. */
export function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? "").replace(SUBJECT_PREFIX, "").replace(/\s+/g, " ").trim().toLowerCase();
}

const FORWARD_SUBJECT = /^\s*(?:\[[^\]]{1,30}\]\s*)*(?:fw|fwd|tr|rv|enc)\s*:/i;

// Where a client starts quoting the previous message. Each is anchored to a line start;
// the Gmail/Apple form allows the attribution to wrap onto up to 2 more lines (long
// names/addresses get hard-wrapped, e.g. "... Opiyo <\r\njopiyo@efac.org> wrote:").
const REPLY_MARKERS: RegExp[] = [
  /^On\b[^\n]{0,300}(?:\n[^\n]{0,300}){0,2}?\bwrote:[ \t]*$/m,
  /^El\b[^\n]{0,300}(?:\n[^\n]{0,300}){0,2}?\bescribi[oó]:[ \t]*$/m,
  /^Le\b[^\n]{0,300}(?:\n[^\n]{0,300}){0,2}?\ba écrit\s*:[ \t]*$/m,
  /^-{2,}\s*On\b[^\n]{0,300}\bwrote\s*-{2,}/m, // Zoho: "---- On <date> <name> wrote ----"
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^_{10,}[ \t]*\n+[ \t]*From:/m,
  /^From:[^\n]*\n(?:[^\n]*\n)?Sent:[^\n]*\n/m,
];

const SIGNATURE_MARKERS: RegExp[] = [/^-- ?$/m, /^Sent from my (?:iPhone|iPad|Android|mobile)/im, /^Get Outlook for /im];

function firstMarkerIndex(text: string, markers: RegExp[], from = 0): number {
  let best = -1;
  for (const re of markers) {
    const m = re.exec(text.slice(from));
    if (m && (best === -1 || m.index + from < best)) best = m.index + from;
  }
  return best;
}

/**
 * The part of an email body that's new in this message: quoted reply history, ">"-quoted
 * lines, and trailing signatures removed. For forwards (subject starts with Fw/Fwd), the
 * first quoted block IS the content being forwarded, so it's kept and only history below
 * it is cut. Heuristic by nature — callers that need certainty should fall back to rawText.
 */
export function stripQuotedReply(body: string | null | undefined, subject?: string | null): string {
  let text = (body ?? "").replace(/\r\n?/g, "\n");

  let cut = firstMarkerIndex(text, REPLY_MARKERS);
  if (cut !== -1 && subject && FORWARD_SUBJECT.test(subject)) {
    // Skip past the forwarded message's own header block, then cut at the next marker.
    const next = firstMarkerIndex(text, REPLY_MARKERS, cut + 1);
    cut = next;
  }
  if (cut !== -1) text = text.slice(0, cut);

  text = text
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");

  const sig = firstMarkerIndex(text, SIGNATURE_MARKERS);
  if (sig > 0) text = text.slice(0, sig);

  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function extractAddresses(header: string | null | undefined): string[] {
  return [...(header ?? "").matchAll(/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g)].map((m) => m[0].toLowerCase());
}

/**
 * INTERNAL = sent by and only to the internal domain; OUTBOUND = sent by the internal
 * domain to anyone outside it; INBOUND = sent from outside. Null when the sender has no
 * parseable address.
 */
export function classifyDirection(
  from: string | null | undefined,
  to: string | null | undefined,
  cc: string | null | undefined,
  internalDomain: string,
): EmailDirection | null {
  const domain = internalDomain.toLowerCase().replace(/^@/, "");
  const isInternal = (addr: string) => addr.endsWith(`@${domain}`);
  const sender = extractAddresses(from)[0];
  if (!sender) return null;
  if (!isInternal(sender)) return "INBOUND";
  const recipients = [...extractAddresses(to), ...extractAddresses(cc)];
  return recipients.length > 0 && recipients.every(isInternal) ? "INTERNAL" : "OUTBOUND";
}

/**
 * Mailbox-independent thread id: the root Message-ID of the conversation (first entry of
 * References, else In-Reply-To, else the message's own Message-ID). Gmail's threadId is
 * NOT used because it differs per mailbox, and this pipeline dedups one conversation's
 * messages across several staff mailboxes.
 */
export function threadRootId(
  messageId: string | null | undefined,
  inReplyTo: string | null | undefined,
  references: string | null | undefined,
): string | null {
  const ids = (s: string | null | undefined) => (s ?? "").match(/<[^<>\s]+>/g) ?? [];
  return ids(references)[0] ?? ids(inReplyTo)[0] ?? ids(messageId)[0] ?? null;
}

export interface RawTextHeaders {
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  body: string;
}

/** Inverse of ingestEmails.ts's formatRawText — for backfilling rows ingested before the email* columns existed. */
export function parseRawText(rawText: string): RawTextHeaders {
  const splitAt = rawText.indexOf("\n\n");
  const head = splitAt === -1 ? rawText : rawText.slice(0, splitAt);
  const body = splitAt === -1 ? "" : rawText.slice(splitAt + 2);
  const field = (name: string) => head.match(new RegExp(`^${name}: ?(.*)$`, "m"))?.[1]?.trim() ?? "";
  return { from: field("From"), to: field("To"), cc: field("Cc"), subject: field("Subject"), date: field("Date"), body };
}

export function parseEmailDate(date: string | null | undefined): Date | null {
  if (!date) return null;
  const parsed = new Date(date);
  return isNaN(parsed.getTime()) ? null : parsed;
}

export interface EmailFields {
  emailThreadId: string | null;
  emailThreadKey: string;
  emailFrom: string;
  emailTo: string;
  emailCc: string;
  emailSentAt: Date | null;
  emailDirection: EmailDirection | null;
  emailBody: string;
}

export function deriveEmailFields(
  msg: { from: string; to: string; cc: string; subject: string; date: string; textBody: string; messageId?: string | null; inReplyTo?: string | null; references?: string | null },
  internalDomain: string,
): EmailFields {
  return {
    emailThreadId: threadRootId(msg.messageId, msg.inReplyTo, msg.references),
    emailThreadKey: normalizeSubject(msg.subject),
    emailFrom: msg.from,
    emailTo: msg.to,
    emailCc: msg.cc,
    emailSentAt: parseEmailDate(msg.date),
    emailDirection: classifyDirection(msg.from, msg.to, msg.cc, internalDomain),
    emailBody: stripQuotedReply(msg.textBody, msg.subject),
  };
}
