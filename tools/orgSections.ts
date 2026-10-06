/**
 * Splits a multi-org staff document (the "FY20xx Org Notes" Google Docs: one section per
 * grantee, each headed by the org's name on its own line) into per-org sections, so each
 * section can be stored as its own KnowledgeDocument with the org's govId.
 *
 * A line only counts as a heading if it resolves to a known org name — formatting varies
 * by year (`**Bridge2Rwanda:**`, `**AYOI**`, plain `Child Aid`), so it can't be relied on.
 * Matching is stricter than matchOrg(): whole-word only, and a heading may abbreviate an
 * org ("Crosby Fund", "Mentors International (MI)") but a line that merely *contains* an
 * org name ("Total for Child Aid") is not a heading.
 */
import { aliasOrg, normalizeWords } from "./documentMetadata.ts";

export interface SectionOrg {
  name: string;
  /** null for orgs CG has no data-request record for (e.g. defunded orgs). */
  govId: string | null;
}

export interface OrgSection {
  org: SectionOrg | null; // null = text before the first org heading
  heading: string | null;
  text: string;
}

interface IndexedOrg {
  org: SectionOrg;
  normalized: string;
}

function index(orgs: SectionOrg[]): IndexedOrg[] {
  return orgs.map((org) => ({ org, normalized: normalizeWords(org.name) })).filter((o) => o.normalized);
}

/** Google's Markdown export escapes punctuation (`\-`, `\$`, `\.`) and wraps bold in `**`. */
function cleanLine(line: string): string {
  return line
    .replace(/\\(.)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/, "")
    .trim()
    .replace(/[\s:\-–—]+$/, "")
    .trim();
}

/** The whole heading, plus its parts: "Remade (Formerly Made in the Streets / MITS)" -> ... */
function headingVariants(heading: string): string[] {
  const parens = [...heading.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  const outside = heading.replace(/\([^)]*\)/g, " ");
  const variants = [heading, outside, ...parens].flatMap((v) => [v, ...v.split("/")]);
  return [...new Set(variants.map((v) => v.trim().replace(/^formerly\s+/i, "")).filter(Boolean))];
}

function containsWords(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

function matchIn(normalized: string, orgs: IndexedOrg[]): SectionOrg | null {
  const exact = orgs.filter((o) => o.normalized === normalized);
  if (exact.length === 1) return exact[0].org;
  if (exact.length > 1 || normalized.length < 4) return null;
  const partial = orgs.filter((o) => containsWords(o.normalized, normalized));
  return partial.length === 1 ? partial[0].org : null;
}

function matchHeading(line: string, primary: IndexedOrg[], secondary: IndexedOrg[]): SectionOrg | null {
  const heading = cleanLine(line);
  if (heading.length < 3 || heading.length > 70 || /^[\d·•*]/.test(heading) || /[:?$%]/.test(heading)) return null;
  const variants = headingVariants(heading).map((v) => aliasOrg(normalizeWords(v)));
  // Data-request orgs win over the fallback list, whichever variant matched.
  for (const orgs of [primary, secondary]) {
    for (const v of variants) {
      const org = v && matchIn(v, orgs);
      if (org) return org;
    }
  }
  return null;
}

/**
 * @param orgs      orgs with a data-request record (govId set)
 * @param fallback  other known org names (no govId) — still split on, so their notes
 *                  aren't attributed to the previous org's section
 */
export function splitByOrgHeadings(text: string, orgs: SectionOrg[], fallback: SectionOrg[] = []): OrgSection[] {
  const primary = index(orgs);
  const secondary = index(fallback);
  const sections: OrgSection[] = [];
  let current: OrgSection = { org: null, heading: null, text: "" };
  const lines = text.split("\n");

  lines.forEach((line, i) => {
    // Headings start a paragraph, except a fully bold line can follow a soft line break.
    const startsBlock = i === 0 || !lines[i - 1].trim() || /^\s*\*\*.+\*\*\s*$/.test(line);
    const org = startsBlock ? matchHeading(line, primary, secondary) : null;
    if (org) {
      sections.push(current);
      current = { org, heading: cleanLine(line), text: "" };
    }
    current.text += `${line}\n`;
  });
  sections.push(current);

  return sections
    .map((s) => ({ ...s, text: s.text.trim() }))
    .filter((s) => s.org || s.text.length > 0);
}
