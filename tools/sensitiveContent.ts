/**
 * Keeps CG Charitable staff personnel data out of the knowledge base: payroll and
 * individual pay, health insurance, immigration/visa paperwork, personal travel documents
 * (tickets, visas, passports, medical) and tax-account credentials.
 *
 * Every ingest path checks these rules before persisting anything, and
 * scripts/purgeSensitiveDocuments.ts applies the same rules to what's already stored —
 * so a rule added here both blocks new content and (after a purge run) removes old.
 *
 * Grantee material is deliberately out of scope: partner orgs' salaries, payroll and
 * budgets are core due-diligence data, so path/filename/topic rules only apply to CG's own
 * folders and to email that isn't correspondence with a partner org. The hard identifiers
 * (an SSN or passport number written out) are excluded everywhere.
 */

// ── Files ───────────────────────────────────────────────────────────────────

const GRANTEE_PATH_RE = /04_grant_organizations/i;

/** CG folders whose contents are staff-personal by nature, matched against the full path. */
const SENSITIVE_DIRS: [string, RegExp][] = [
  // Per-person receipts: health premiums, prescriptions, flights, card statements.
  ["staff expense receipts", /[\\/]2_finance[\\/]1_expenses([\\/]|$)/i],
  ["payroll", /[\\/]payroll summaries([\\/]|$)/i],
  // Brokerage activity exports list each payroll transfer by employee name.
  ["payroll (bank activity)", /[\\/]ms main account activity([\\/]|$)/i],
  ["tax account credentials", /[\\/]fed and state accounts([\\/]|$)/i],
  [
    "personal travel documents",
    /[\\/]05_travel[\\/](.+[\\/])?(tickets|flights|trains|visas|accom+odations|medical|important documents|receipts and invoices|[^\\/]*confirmations|chris and sarah [^\\/]*)([\\/]|$)/i,
  ],
];

const SENSITIVE_FILENAMES: [string, RegExp][] = [
  ["payroll", /payroll|pay ?stub/i],
  ["staff budget", /actuals and budget|\d+\s*yr budget/i],
  ["tax forms", /\bw-?2\b|\bw-?4\b|\bi-?9\b|1095-?a/i],
  ["immigration", /\bh-?1b\b|\bi-?129\b|labor condition|expedited processing/i],
  ["employment agreement", /offer letter|employment agreement|confidential information agreement/i],
  ["health insurance", /\bu ?health|health ?ins/i],
  // "Utah TAP Account and Pin", "EFTPS Enrollment and Pin". Not a text rule: 990 e-file
  // signature blocks also say "Personal Identification Number (PIN)".
  ["tax account credentials", /\bpin\b/i],
  ["personal travel documents", /passport|\bvisas?\b|e-?ticket|boarding pass|vaccination/i],
];

/** Reason a file should never be ingested, judged from its path and name alone; null if it's fine. */
export function sensitiveFileReason(storageUrl: string, filename: string): string | null {
  if (GRANTEE_PATH_RE.test(storageUrl)) return null;
  for (const [reason, re] of SENSITIVE_DIRS) if (re.test(storageUrl)) return reason;
  for (const [reason, re] of SENSITIVE_FILENAMES) if (re.test(filename)) return reason;
  return null;
}

// ── Text ────────────────────────────────────────────────────────────────────

/** Hard identifiers — excluded wherever they appear, grantee material included. */
const IDENTIFIER_TEXT: [string, RegExp][] = [
  ["SSN", /\b(ssn|social security (number|no\.?))\s*[:#]?\s*\d{3}-?\d{2}-?\d{4}\b/i],
  ["passport number", /\bpassport (no\.?|number|#)\s*[:#]?\s*[A-Z0-9]{6,9}\b/i],
];

/** Documents that only exist about CG's own staff/accounts. */
const INTERNAL_TEXT: [string, RegExp][] = [
  ["payroll", /payroll (summary|register)|pay ?stub|earnings statement/i],
  ["health insurance tax form", /form 1095-a/i],
  ["immigration", /\bform i-129\b|labor condition application|petition for (a )?nonimmigrant worker/i],
];

/** Reason extracted document text should not be kept; null if it's fine. */
export function sensitiveTextReason(storageUrl: string, text: string): string | null {
  for (const [reason, re] of IDENTIFIER_TEXT) if (re.test(text)) return reason;
  if (GRANTEE_PATH_RE.test(storageUrl) || storageUrl.startsWith("datarequest://")) return null;
  for (const [reason, re] of INTERNAL_TEXT) if (re.test(text)) return reason;
  return null;
}

/** Combined file check for ingest paths that have both the path and the extracted text. */
export function sensitiveDocumentReason(storageUrl: string, filename: string, text: string): string | null {
  return sensitiveFileReason(storageUrl, filename) ?? sensitiveTextReason(storageUrl, text);
}

// ── Email ───────────────────────────────────────────────────────────────────

/** Payroll provider, immigration counsel, health-insurance broker, USCIS. Extend via GMAIL_INGEST_EXCLUDE_DOMAINS. */
const STAFF_HR_DOMAINS = new Set([
  "justworks.com",
  "raneaung.com",
  "switchinsuranceutah.com",
  "uscis.dhs.gov",
  ...(process.env.GMAIL_INGEST_EXCLUDE_DOMAINS || "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
]);

const STAFF_HR_SUBJECT_RE =
  /\bpayroll\b|\bw-?2\b|\bw-?4\b|\bi-?9\b|\bh-?1b\b|visa application|health insurance|medical insurance|\w's insurance|benefits quote|open enrollment|\bpeo\b|inflation adjustment|cost of living|salary (increase|adjustment)|\bpay raise\b|performance review|offer letter|employment agreement|confidential information agreement|passport/i;

const STAFF_HR_BODY_RE = /\b(ssn|social security number)\b|\bpassport (no\.?|number)\b|\bpay ?stub\b|\bpayroll (summary|register|total)\b/i;

/**
 * Cheap gate for the LLM staff-personnel check in emailClassify.ts: wording that could be
 * about someone's pay or job performance. Matching alone doesn't exclude — internal mail
 * about a partner org's compensation data uses the same words.
 */
export const STAFF_PERSONNEL_GATE_RE =
  /\b(salar(y|ies)|compensation|pay (raise|increase|cut|rate|scale)|raises?|bonus(es)?|performance (review|evaluation|issues?|concerns?|improvement)|promotion|reporting structures?|job title|terminat(e|ed|ion)|let go)\b/i;

export interface EmailForScreening {
  from: string;
  to: string;
  cc: string;
  subject: string;
  textBody: string;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/**
 * Reason an email is staff-personnel material that must not be ingested; null if it's fine.
 * `partnerDomains` are participant domains that resolve to a partner org — when present
 * the email is grantee correspondence, where salary/payroll talk is legitimate, so only
 * the hard-identifier and HR-vendor rules apply.
 */
export function sensitiveEmailReason(email: EmailForScreening, partnerDomains: string[] = []): string | null {
  const participants = `${email.from} ${email.to} ${email.cc}`.match(EMAIL_RE) ?? [];
  for (const addr of participants) {
    const domain = addr.slice(addr.indexOf("@") + 1).toLowerCase();
    if (STAFF_HR_DOMAINS.has(domain)) return `HR vendor (${domain})`;
  }

  // Staff mark restricted mail "CLASSIFIED" (as a Gmail label, checked in ingestEmails.ts, or in the subject).
  if (/\bCLASSIFIED\b/.test(email.subject)) return "marked CLASSIFIED";

  const text = `${email.subject}\n${email.textBody}`;
  for (const [reason, re] of IDENTIFIER_TEXT) if (re.test(text)) return reason;

  if (partnerDomains.length) return null;
  if (STAFF_HR_SUBJECT_RE.test(email.subject)) return "staff HR subject";
  if (STAFF_HR_BODY_RE.test(email.textBody)) return "staff HR content";
  return null;
}
