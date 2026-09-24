/**
 * Decides whether a candidate email is worth ingesting into the knowledge base, and if
 * so which org and topics it's tagged with. This is the privacy backstop for
 * src/ingestEmails.ts: an email is only ever persisted when it resolves to a known
 * partner org, or matches a configured topic and an LLM pass confirms it's genuinely
 * relevant to a partner org's work or to CG Charitable's own finances/operations.
 * Everything else — the bulk of 5 people's inboxes — is never written to disk.
 */

import { createHash } from "crypto";
import { AI, type AIProvider } from "./ai.ts";
import {
  buildOrgIndex,
  classifyCategories,
  matchOrg,
  type Category,
  type DocProvenance,
  type OrgIndex,
  type OrgRef,
} from "./documentMetadata.ts";
import type { gmail_v1 } from "googleapis";
import type { ParsedMessage } from "./gmail.ts";

// ── Noise filter (metadata-only, cheap) ─────────────────────────────────────

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

const AUTOMATED_SENDER_RE = /no-?reply|do-?not-?reply|notifications?@|calendar-notification@google\.com|mailer-daemon/i;
const CALENDAR_SUBJECT_RE = /^(invitation|accepted|declined|updated invitation|canceled event|new event):/i;

/** Cheap pre-filter on message metadata — skip obvious automated/bulk mail before paying for a full body fetch. */
export function isNoiseMessage(metadata: gmail_v1.Schema$Message): boolean {
  const headers = metadata.payload?.headers;
  if (headerValue(headers, "List-Id") || headerValue(headers, "List-Unsubscribe")) return true;
  if (/\b(bulk|list)\b/i.test(headerValue(headers, "Precedence"))) return true;
  if (AUTOMATED_SENDER_RE.test(headerValue(headers, "From"))) return true;
  if (CALENDAR_SUBJECT_RE.test(headerValue(headers, "Subject"))) return true;
  return false;
}

// ── Participant / domain parsing ────────────────────────────────────────────

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

function extractEmails(headerValue: string): string[] {
  return [...(headerValue.match(EMAIL_RE) ?? [])].map((e) => e.toLowerCase());
}

function domainOf(email: string): string {
  return email.slice(email.indexOf("@") + 1).toLowerCase();
}

// ── Fingerprint fallback (when Message-ID header is missing) ───────────────

/** Best-effort stable id when a message lacks an RFC822 Message-ID header (rare). */
export function fallbackFingerprint(msg: Pick<ParsedMessage, "from" | "date" | "subject" | "textBody">): string {
  const basis = `${msg.from}|${msg.date}|${msg.subject}|${msg.textBody.slice(0, 500)}`;
  return "sha256:" + createHash("sha256").update(basis).digest("hex");
}

// ── Classification ──────────────────────────────────────────────────────────

export interface ClassifyContext {
  orgIndex: OrgIndex;
  /** domain -> govId, from the hand-curated OrgEmailDomain table. */
  domainMap: Map<string, string>;
  /** govId -> current org name (fresh from getOrgs(), not the possibly-stale OrgEmailDomain.orgName). */
  orgNameByGovId: Map<string, string>;
  /** The org's own domain, e.g. "cgcharitable.org" — used to tell internal vs. external participants apart. */
  internalDomain: string;
}

export interface EmailClassification {
  ingest: boolean;
  orgGovId: string | null;
  orgName: string | null;
  categories: Category[];
  docProvenance: DocProvenance;
}

function createClassifierAI(): AI {
  const raw = (process.env.AI_CHAT_PROVIDER || "ollama").toLowerCase();
  const providerMap: Record<string, AIProvider> = { ollama: "Ollama", anthropic: "Anthropic", openai: "OpenAI" };
  const provider: AIProvider = providerMap[raw] ?? "Ollama";
  const defaultModel =
    provider === "Anthropic" ? "claude-sonnet-4-6"
    : provider === "OpenAI"  ? "gpt-4o"
    :                           "llama3.2";
  return new AI(provider, process.env.AI_CHAT_MODEL || defaultModel);
}

/**
 * Ambiguous case: a topic hit but no org resolved from participants/name-matching. Asks
 * the LLM to (a) confirm this is genuinely about a partner org's work, or about CG
 * Charitable's own finances/operations — not unrelated personal use of a topic word like
 * "my budget is tight" — and (b) attempt org attribution from the known org list when
 * it's (a) a partner org, leaving orgName null for CG's own internal content. Errs
 * toward excluding on any parse failure.
 */
async function llmConfirmAmbiguous(
  subject: string,
  body: string,
  orgs: OrgRef[],
): Promise<{ relevant: boolean; orgName: string | null }> {
  const orgNames = orgs.map((o) => o.name).join("; ");
  const ai = createClassifierAI();
  const prompt = `You triage internal emails for CG Charitable's knowledge base of itself and its partner organizations.
Known partner orgs: ${orgNames}

Email subject: ${subject}
Email body (may be truncated):
${body.slice(0, 3000)}

Is this email substantively about (a) one of the known partner orgs' work, finances, or programs, or (b) CG Charitable's own internal finances or operations — not just incidental use of a topic word (e.g. "my personal budget" doesn't count)? Reply with ONLY a JSON object, no prose: {"relevant": true|false, "orgName": "<exact partner org name from the list if (a), or null if (b) or not relevant>"}`;

  try {
    const raw = await ai.respond([{ role: "user", content: prompt }]);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { relevant: false, orgName: null };
    const parsed = JSON.parse(match[0]) as { relevant?: boolean; orgName?: string | null };
    return { relevant: !!parsed.relevant, orgName: parsed.orgName ?? null };
  } catch {
    return { relevant: false, orgName: null };
  }
}

export async function classifyEmail(
  email: Pick<ParsedMessage, "from" | "to" | "cc" | "subject" | "textBody">,
  ctx: ClassifyContext,
): Promise<EmailClassification> {
  const participants = [
    ...extractEmails(email.from),
    ...extractEmails(email.to),
    ...extractEmails(email.cc),
  ];
  const externalDomains = [...new Set(participants.map(domainOf).filter((d) => d !== ctx.internalDomain))];
  const allInternal = externalDomains.length === 0;
  const docProvenance: DocProvenance = allInternal ? "CG_INTERNAL" : "ORG_SUBMITTED";

  const haystack = `${email.subject}\n${email.textBody}`;
  const categories = classifyCategories(haystack);

  // (a) Domain-based org resolution — high confidence.
  for (const domain of externalDomains) {
    const govId = ctx.domainMap.get(domain);
    if (govId) {
      return {
        ingest: true,
        orgGovId: govId,
        orgName: ctx.orgNameByGovId.get(govId) ?? null,
        categories: [...new Set([...categories, "CORRESPONDENCE" as Category])],
        docProvenance,
      };
    }
  }

  // (b) Fuzzy name match against subject+body.
  const nameMatch = matchOrg(email.subject, ctx.orgIndex) ?? matchOrg(haystack, ctx.orgIndex);
  if (nameMatch) {
    return {
      ingest: true,
      orgGovId: nameMatch.govId,
      orgName: ctx.orgNameByGovId.get(nameMatch.govId) ?? nameMatch.name,
      categories: [...new Set([...categories, "CORRESPONDENCE" as Category])],
      docProvenance,
    };
  }

  // (c) No org resolved but a topic hit exists — bounded LLM fallback.
  if (categories.length > 0) {
    const orgs = ctx.orgIndex.orgs.map((o) => o.ref);
    const { relevant, orgName } = await llmConfirmAmbiguous(email.subject, email.textBody, orgs);
    if (relevant) {
      const resolved = orgName ? orgs.find((o) => o.name === orgName) : null;
      return {
        ingest: true,
        orgGovId: resolved?.govId ?? null,
        orgName: resolved ? (ctx.orgNameByGovId.get(resolved.govId) ?? resolved.name) : null,
        categories: [...new Set([...categories, "CORRESPONDENCE" as Category])],
        docProvenance,
      };
    }
  }

  // Neither org nor topic hit (or the LLM didn't confirm relevance) — never persisted.
  return { ingest: false, orgGovId: null, orgName: null, categories: [], docProvenance };
}

export { buildOrgIndex };
