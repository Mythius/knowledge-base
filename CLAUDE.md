# Pathmark — Claude Context

Multi-tenant AI coaching platform for non-profits. Beneficiaries receive coaching via WhatsApp, grounded in per-org knowledge documents through a RAG pipeline.

For full architecture detail see [architecture.md](architecture.md).

---

## Stack

- **Runtime / server:** Bun + Hono
- **Database:** PostgreSQL 16 (external at `db.cgcharitable.org`) + Prisma 7
- **Vector search:** pgvector on the same PostgreSQL instance — no separate vector DB
- **Queue:** BullMQ + Redis (Docker sidecar)
- **File storage:** Cloudflare R2 (or local disk in dev)
- **Embeddings:** Voyage AI `voyage-3` via Anthropic key, or local Ollama `rjmalagon/gte-qwen2-1.5b-instruct-embed-f16`
- **AI responses:** Anthropic Claude

## Directory Layout

```
tools/          # Generic, reusable utilities (no project-specific logic)
src/routes/     # Project-specific Hono route handlers
src/workers/    # Background job workers (BullMQ)
prisma/         # schema.prisma + raw SQL migrations
workers/        # (empty — superseded by src/workers/)
```

Routes are registered in [api.ts](api.ts) via `publicRoutes()` and `privateRoutes()`. All routes added to `privateRoutes` are automatically behind the auth middleware. Import route setup functions and call them there — see the knowledge routes at the bottom of `privateRoutes` as a pattern.

## Prisma Conventions

- **Never use `@map` or `@@map`** — tables use PascalCase model names, columns use camelCase field names (matches the rest of the schema)
- Schema changes: `bunx prisma db push` (no migrations)
- Client output: `tools/generated/prisma` — import from `tools/prisma.ts` which exports `prisma`
- New models with FKs to `Organization` must add back-relations to that model or store `orgId` as a plain `Int` without a Prisma relation (current approach for knowledge models)
- Raw SQL (pgvector, etc.) goes in `prisma/migrations/` and is applied manually with psql at `/opt/homebrew/Cellar/libpq/18.4/bin/psql`
- **Declare every index in schema.prisma**, even ones a raw-SQL migration creates (use `Unsupported(...)` fields + `@@index(..., type: Gin)` where needed). `entrypoint.sh` runs `prisma db push` on every container start, which drops indexes/columns that exist only in raw SQL — that's why the HNSW index from `add_vector_embedding` and the GIN index from `add_document_metadata` are missing in production. Triggers and functions are invisible to Prisma and survive db push.
- Because of that same startup `db push`, deploy schema changes **before** applying their raw-SQL migration: new columns added to the DB ahead of the code that declares them look like drift to the old container's db push, which then refuses (data loss) and exits under `set -e`.

## Auth Pattern

Sessions are stored in Redis. The middleware attaches the session to context — retrieve it with `c.get("session") as Session`. The `session.db` field is the User DB record; `session.db.role === "ADMIN"` for admins, `session.db.organizationId` for the user's org.

## Switchable Providers (env vars)

| Var | Options | Default |
|---|---|---|
| `EMBEDDING_PROVIDER` | `voyageai` / `ollama` | `voyageai` |
| `STORAGE_PROVIDER` | `s3` / `local` | `s3` |

For local dev: set both to `ollama` / `local`. Ollama runs on a Windows machine at `OLLAMA_BASE_URL=http://10.0.0.171:11434` with `rjmalagon/gte-qwen2-1.5b-instruct-embed-f16` already pulled. Local files go to `./uploads/knowledge/`.

## Running

```bash
bun run index.ts                        # API server
bun src/workers/documentProcessor.ts   # Document ingestion worker (separate process)
```

## Key Files

| File | Purpose |
|---|---|
| [api.ts](api.ts) | All route registrations |
| [tools/prisma.ts](tools/prisma.ts) | Prisma client init + CRUD helpers |
| [tools/auth.ts](tools/auth.ts) | Session types, auth middleware, OAuth |
| [tools/vectorSearch.ts](tools/vectorSearch.ts) | `embedText()` + `searchChunks()` |
| [src/routes/knowledge/upload.ts](src/routes/knowledge/upload.ts) | Document upload endpoint |
| [src/routes/knowledge/curate.ts](src/routes/knowledge/curate.ts) | Chunk curation endpoints |
| [src/workers/documentProcessor.ts](src/workers/documentProcessor.ts) | Extract → chunk → embed pipeline |
| [prisma/schema.prisma](prisma/schema.prisma) | Full DB schema |
| [example-env](example-env) | All supported env vars with comments |
