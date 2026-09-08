# api-lib
 Express Boilerplate witth authentication for apis

run the server with `node index.js`

create new api user with `node cli.js`

## Document metadata (org / year / category / provenance)

`KnowledgeDocument` carries searchability columns — `orgGovId`, `orgName`,
`fundingStatus`, `documentYear`, `documentDate`, `category` (multi-value), `language`,
`docProvenance`, `isTemplate`, `containsPii`, `processingIssue` — derived from
`storageUrl`/`filename` by [`tools/documentMetadata.ts`](tools/documentMetadata.ts).
That module is the single source of truth for the derivation rules; `src/ingestFiles.ts`,
`src/datarequest.ts`, and `src/routes/knowledge/upload.ts` all call into it so new
documents get tagged the same way as backfilled ones.

`orgGovId` matches `Organization.govId` in the cg_data_requests database (the `dr`
connection in cg-mcp) — that's the join key for reasoning across both databases.

To (re-)tag existing rows, see [`scripts/backfillDocumentMetadata.ts`](scripts/backfillDocumentMetadata.ts):

```bash
bun scripts/backfillDocumentMetadata.ts              # dry run — prints a report, writes nothing
bun scripts/backfillDocumentMetadata.ts --apply       # writes the changes
bun scripts/backfillDocumentMetadata.ts --apply --force   # also recompute already-tagged rows
```

Known limitations (see comments in `tools/documentMetadata.ts` for detail):
- `containsPii` and `isTemplate` are filename/path heuristics, not a real PII scan —
  treat `false` as "not flagged," not as a verified absence of PII.
- Org-name matching only resolves folder labels that fuzzy-match an org already known to
  `dr`'s `Organization` table (via the `/api/organization` endpoint). Defunded orgs that
  never submitted a data request, and informal labels under Trip Media, will legitimately
  have no `orgGovId` — check the backfill script's "unmatched org label" report before
  assuming it's a bug, and add real typos/aliases to `ORG_ALIASES`.
- `documentYear` for a bundled folder like "2019 and earlier" is an upper bound, not exact.
