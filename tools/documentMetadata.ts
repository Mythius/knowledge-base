/**
 * Derives searchability metadata (org, year, category, provenance, ...) for a
 * KnowledgeDocument from its storageUrl and filename. Used by:
 *  - scripts/backfillDocumentMetadata.ts, to tag pre-existing rows
 *  - src/ingestFiles.ts, src/datarequest.ts, src/routes/knowledge/upload.ts, to tag new
 *    documents at ingestion time so the two never drift apart
 *
 * Three storageUrl conventions exist in the wild:
 *  - `datarequest://<govId>/<year>`               — annual data-request exports
 *  - `Y:\Shared\CG\04_Grant_Organizations\...`     — the grant-org shared drive
 *  - anything else (S3 keys/local upload paths)    — web-uploaded docs, no path signal
 */

export type FundingStatus = "CURRENT" | "DEFUNDED_POTENTIAL" | "DEFUNDED_UNLIKELY";
export type DocProvenance = "ORG_SUBMITTED" | "CG_INTERNAL" | "REFERENCE_MATERIAL";
export type ProcessingIssue = "NEEDS_OCR" | "NEEDS_PASSWORD" | "NEEDS_MANUAL_FIX" | "TRANSIENT_RETRY" | "TOO_LARGE";

/** Fixed vocabulary for `category`. Keep in sync with the MCP server's documented list. */
export const CATEGORY_VALUES = [
  "TAX_FILING",
  "FINANCIALS",
  "GOVERNANCE_LEGAL",
  "ANNUAL_REPORT",
  "DATA_REQUEST",
  "ASSESSMENT_CURRICULUM",
  "POLICY_HANDBOOK",
  "MEETING_NOTES",
  "MEDIA",
  "NEWSLETTER",
  "SURVEY",
  "CORRESPONDENCE",
] as const;
export type Category = (typeof CATEGORY_VALUES)[number];

export interface OrgRef {
  name: string;
  govId: string;
}

export interface DerivedMetadata {
  orgGovId: string | null;
  orgName: string | null;
  fundingStatus: FundingStatus | null;
  documentYear: number | null;
  documentDate: string | null; // YYYY-MM-DD
  category: Category[];
  language: string | null;
  docProvenance: DocProvenance | null;
  isTemplate: boolean;
  containsPii: boolean;
  processingIssue: ProcessingIssue | null;
  /** Set when the storageUrl named an org-like folder that didn't resolve to a govId. */
  unmatchedOrgLabel: string | null;
}

// ── Org name matching ───────────────────────────────────────────────────────

/**
 * Corrections for known folder-name variants that word-normalization can't bridge
 * (typos, unrelated abbreviations). Both keys and values must already be in
 * normalizeWords() form (lowercase, stopwords like "international"/"inc" stripped) —
 * they're compared/substituted *after* normalization, not before.
 */
const ORG_ALIASES: Record<string, string> = {
  "villiage schools": "village schools",
};

const ORG_STOPWORDS = new Set([
  "the", "inc", "incorporated", "intl", "international", "foundation", "trust",
  "fund", "project", "organization", "org", "ltd", "limited", "of", "and",
]);

function normalizeWords(name: string): string {
  const words = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w && !ORG_STOPWORDS.has(w));
  return words.join(" ");
}

function compact(normalized: string): string {
  return normalized.replace(/\s+/g, "");
}

export interface OrgIndex {
  orgs: { ref: OrgRef; normalized: string; compact: string }[];
}

export function buildOrgIndex(orgs: OrgRef[]): OrgIndex {
  return {
    orgs: orgs.map((ref) => {
      const normalized = normalizeWords(ref.name);
      return { ref, normalized, compact: compact(normalized) };
    }),
  };
}

/**
 * Resolve a raw folder/label string to a known org. Returns null (not a guess) when
 * zero or more than one org could plausibly match — a wrong govId on a financial or
 * PII-flagged document is worse than a missing one.
 */
export function matchOrg(rawLabel: string, index: OrgIndex): OrgRef | null {
  let normalized = normalizeWords(rawLabel);
  if (!normalized) return null;
  normalized = ORG_ALIASES[normalized] ?? normalized;
  const compacted = compact(normalized);

  const exact = index.orgs.find((o) => o.normalized === normalized || o.compact === compacted);
  if (exact) return exact.ref;

  if (normalized.length < 4) return null; // too short to substring-match safely

  const candidates = index.orgs.filter(
    (o) => o.normalized.includes(normalized) || normalized.includes(o.normalized),
  );
  return candidates.length === 1 ? candidates[0].ref : null;
}

// ── Path parsing (Grant_Organizations shared-drive convention) ─────────────

const YEAR_SEGMENT_RE = /^(19|20)\d{2}\b/;

function splitPath(storageUrl: string): string[] {
  return storageUrl.split(/[\\/]+/).filter(Boolean);
}

function parseGrantOrgPath(segments: string[]): {
  fundingStatus: FundingStatus | null;
  orgLabel: string | null;
  yearSegmentIndex: number;
  documentYear: number | null;
} {
  const fundedIdx = segments.findIndex((s) => /funded orgs$/i.test(s));
  if (fundedIdx === -1 || fundedIdx + 1 >= segments.length) {
    return { fundingStatus: null, orgLabel: null, yearSegmentIndex: -1, documentYear: null };
  }

  const bucket = segments[fundedIdx + 1]; // "2 Current orgs" | "1 Defunded Orgs"
  let fundingStatus: FundingStatus | null = null;
  let orgIdx = fundedIdx + 2;

  if (/current orgs/i.test(bucket)) {
    fundingStatus = "CURRENT";
  } else if (/defunded orgs/i.test(bucket)) {
    const subBucket = segments[fundedIdx + 2] ?? "";
    fundingStatus = /not likely/i.test(subBucket) ? "DEFUNDED_UNLIKELY" : "DEFUNDED_POTENTIAL";
    orgIdx = fundedIdx + 3;
  }

  const orgLabel = segments[orgIdx] ?? null;

  let yearSegmentIndex = -1;
  let documentYear: number | null = null;
  for (let i = orgIdx + 1; i < segments.length - 1; i++) {
    const match = segments[i].match(YEAR_SEGMENT_RE);
    if (match) {
      yearSegmentIndex = i;
      documentYear = parseInt(match[0], 10);
      break;
    }
  }

  return { fundingStatus, orgLabel, yearSegmentIndex, documentYear };
}

// ── Category / provenance / language / PII heuristics ──────────────────────

const CATEGORY_RULES: [Category, RegExp][] = [
  ["TAX_FILING", /\b990\b|irs form|tax return|tax filing|e-return/i],
  ["FINANCIALS", /audit|financial statement|balance sheet|\bp&l\b|profit.{0,3}loss|income statement|statement of financial position/i],
  ["GOVERNANCE_LEGAL", /bylaw|articles of incorp|constitution|501\s?\(?c\)?\s?3|certificate of registration|determination letter|conflict of interest/i],
  ["ANNUAL_REPORT", /annual report|program review|impact report|impact note/i],
  ["DATA_REQUEST", /data request/i],
  ["ASSESSMENT_CURRICULUM", /assessment|exam|marking guide|kcse|necta|nesa|curriculum|end of term|\beot\b/i],
  ["POLICY_HANDBOOK", /handbook|\bpolic(y|ies)\b|procedure|code of conduct|protection policy/i],
  ["MEETING_NOTES", /meeting notes|interview|minutes|notes -|notes-/i],
  ["NEWSLETTER", /newsletter/i],
  ["SURVEY", /\bsurvey\b/i],
];

const REFERENCE_MATERIAL_RE = /nesa exams|ordinary level assessment|advanced level assessment|ministry assessment|sample assessment|formal-?standardised assessment/i;
const CG_INTERNAL_PATH_RE = /trip media|\btrips?\b|our stuff|interviews? and questions|grant documentation process/i;
const CG_INTERNAL_FILENAME_RE = /^\d{6}\s|brian files -|jim eval -|notes -|interview notes|talking points/i;
const TEMPLATE_RE = /\b(blank|template)\b/i;
/** Heuristic only — see containsPii doc comment on the schema field. */
const PII_FILENAME_RE = /(assessment|application|beneficiary|interview)[^.]*[-–]\s*[A-Z][a-zA-Z'.]+/i;

const LANGUAGE_MARKERS: [string, RegExp][] = [
  ["es", /an[aá]lisis|evaluaci[oó]n|matem[aá]ticas?|lenguaje|primaria|secundaria|grado|periodo|prueba diagn[oó]stica|escuela/i],
  ["fr", /fran[cç]ais/i],
  ["rw", /kinyarwanda|ikinyarwanda/i],
  ["sw", /kiswahili/i],
];

export function classifyCategories(haystack: string): Category[] {
  const found = new Set<Category>();
  for (const [cat, re] of CATEGORY_RULES) if (re.test(haystack)) found.add(cat);
  if (/\bmp4\b|\bmov\b|video|\bphotos?\b/i.test(haystack)) found.add("MEDIA");
  return [...found];
}

function classifyProvenance(pathLower: string, filename: string): DocProvenance {
  if (REFERENCE_MATERIAL_RE.test(pathLower)) return "REFERENCE_MATERIAL";
  if (CG_INTERNAL_PATH_RE.test(pathLower) || CG_INTERNAL_FILENAME_RE.test(filename)) return "CG_INTERNAL";
  return "ORG_SUBMITTED";
}

function detectLanguage(filename: string): string | null {
  for (const [code, re] of LANGUAGE_MARKERS) if (re.test(filename)) return code;
  return null;
}

/** YYMMDD-prefixed internal memos (e.g. "220628 Impact Hope first visit.docx") -> ISO date. */
function extractDateFromFilename(filename: string): string | null {
  const m = filename.match(/^(\d{2})(\d{2})(\d{2})[ _-]/);
  if (!m) return null;
  const [, yy, mm, dd] = m;
  const month = parseInt(mm, 10);
  const day = parseInt(dd, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const year = 2000 + parseInt(yy, 10);
  return `${year}-${mm}-${dd}`;
}

function extractYearFromFilename(filename: string): number | null {
  const m = filename.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : null;
}

// ── errorMessage -> ProcessingIssue ─────────────────────────────────────────

const PROCESSING_ISSUE_RULES: [ProcessingIssue, RegExp][] = [
  ["NEEDS_OCR", /no extractable text/i],
  ["NEEDS_PASSWORD", /no password given/i],
  ["NEEDS_MANUAL_FIX", /invalid zip data|is not an object|pdf file is empty/i],
  ["TRANSIENT_RETRY", /50\d\b|rate limit|econnrefused|timeout/i],
  ["TOO_LARGE", /exceeds .*hard cap/i],
];

export function classifyProcessingIssue(status: string, errorMessage: string | null): ProcessingIssue | null {
  if (status !== "FAILED" || !errorMessage) return null;
  for (const [issue, re] of PROCESSING_ISSUE_RULES) if (re.test(errorMessage)) return issue;
  return null;
}

/**
 * Prisma's client (unlike raw SQL) requires a full Date/ISO-datetime for a DateTime
 * field even when it's `@db.Date` — DerivedMetadata.documentDate is a bare "YYYY-MM-DD"
 * string, so callers writing via `prisma.knowledgeDocument.create/update` must convert
 * through this first. Raw-SQL callers (e.g. scripts/backfillDocumentMetadata.ts) don't
 * need it — Postgres accepts the plain string directly.
 */
export function toPrismaDate(documentDate: string | null): Date | null {
  return documentDate ? new Date(documentDate) : null;
}

// ── Main entry point ─────────────────────────────────────────────────────

export interface DocumentInput {
  storageUrl: string;
  filename: string;
  status: string;
  errorMessage: string | null;
}

export function deriveDocumentMetadata(doc: DocumentInput, orgIndex: OrgIndex): DerivedMetadata {
  const base: DerivedMetadata = {
    orgGovId: null,
    orgName: null,
    fundingStatus: null,
    documentYear: null,
    documentDate: extractDateFromFilename(doc.filename),
    category: [],
    language: null,
    docProvenance: null,
    isTemplate: TEMPLATE_RE.test(doc.filename),
    containsPii: PII_FILENAME_RE.test(doc.filename),
    processingIssue: classifyProcessingIssue(doc.status, doc.errorMessage),
    unmatchedOrgLabel: null,
  };

  const dataRequestMatch = doc.storageUrl.match(/^datarequest:\/\/([^/]+)\/(\d{4})$/);
  if (dataRequestMatch) {
    const [, govId, year] = dataRequestMatch;
    const org = orgIndex.orgs.find((o) => o.ref.govId === govId)?.ref;
    return {
      ...base,
      orgGovId: govId,
      orgName: org?.name ?? null,
      documentYear: parseInt(year, 10),
      category: ["DATA_REQUEST"],
      language: "en",
      docProvenance: "ORG_SUBMITTED",
    };
  }

  const segments = splitPath(doc.storageUrl);
  const pathLower = doc.storageUrl.toLowerCase();
  const haystack = `${pathLower} ${doc.filename.toLowerCase()}`;

  base.category = classifyCategories(haystack);
  base.docProvenance = classifyProvenance(pathLower, doc.filename);
  base.language = detectLanguage(doc.filename) ?? (segments.length > 1 ? "en" : null);

  if (/grant_organizations/i.test(doc.storageUrl)) {
    const { fundingStatus, orgLabel, documentYear } = parseGrantOrgPath(segments);
    base.fundingStatus = fundingStatus;
    base.documentYear = documentYear ?? extractYearFromFilename(doc.filename);

    if (orgLabel) {
      const org = matchOrg(orgLabel, orgIndex);
      if (org) {
        base.orgGovId = org.govId;
        base.orgName = org.name;
      } else {
        base.orgName = orgLabel;
        base.unmatchedOrgLabel = orgLabel;
      }
    }
    return base;
  }

  if (/trip media|05_travel/i.test(doc.storageUrl)) {
    base.docProvenance = "CG_INTERNAL";
    if (!base.category.includes("MEDIA") && /\.(mp4|mov)$/i.test(doc.filename)) base.category.push("MEDIA");
    base.documentYear = extractYearFromFilename(segments.find((s) => YEAR_SEGMENT_RE.test(s)) ?? doc.filename);
    // Subfolders under a year (e.g. "09 Komera") often name a program, not the legal
    // grantee entity — don't force a govId match here, just carry the raw label.
    const yearIdx = segments.findIndex((s) => YEAR_SEGMENT_RE.test(s));
    const labelSeg = yearIdx >= 0 ? segments[yearIdx + 1] : null;
    if (labelSeg) {
      const cleaned = labelSeg.replace(/^\d+\s+/, "");
      const org = matchOrg(cleaned, orgIndex);
      if (org) {
        base.orgGovId = org.govId;
        base.orgName = org.name;
      } else {
        base.orgName = cleaned;
      }
    }
    return base;
  }

  // Unknown convention (web upload, S3 key, ...): no path signal, filename-only best effort.
  base.documentYear = extractYearFromFilename(doc.filename);
  base.language = detectLanguage(doc.filename);
  return base;
}
