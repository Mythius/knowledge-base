# Pathmark — System Architecture

Pathmark is a multi-tenant AI coaching platform built for non-profits. Each organization onboards beneficiaries, uploads its own knowledge base, and delivers AI-assisted coaching through conversational channels (WhatsApp today, web/mobile on the roadmap). Responses are grounded in org-specific documents via retrieval-augmented generation, keeping advice accurate and contextually relevant without retraining a model.

---

## API Server

**Runtime:** Bun · **Framework:** Hono

A single Hono app handles all HTTP traffic. Routes are split into public (unauthenticated) and private (session-required) layers, with the auth middleware acting as the gate between them. Business logic lives in `tools/`, project-specific routes in `src/routes/`, and background workers in `src/workers/`.

Authentication is provided through CAS (Central Authentication Service) as the primary provider, with Google and Microsoft OAuth as alternatives. Sessions are stored in Redis with a 7-day TTL so the API server stays stateless and horizontally scalable.

---

## Database

**Engine:** PostgreSQL 16 (hosted at `db.cgcharitable.org`) · **ORM:** Prisma 7

The relational schema covers:

| Domain | Key models |
|---|---|
| Identity | `User`, `Organization`, `AdminOrgAssignment` |
| Surveys | `Survey`, `Question`, `Response`, `SurveySession`, `SurveySend` |
| Beneficiaries | `Beneficiary`, `UnknownMessage` |
| Knowledge base | `KnowledgeDocument`, `KnowledgeChunk` |

Multi-tenancy is enforced at the application layer — every knowledge document and chunk carries an `orgId` so data never crosses org boundaries. The Prisma client is generated into `tools/generated/prisma` and initialized with the `@prisma/adapter-pg` driver.

---

## Vector Database

**Extension:** pgvector (enabled on the existing PostgreSQL 16 instance)

Rather than running a separate vector database, pgvector extends PostgreSQL so embeddings live in the same ACID-compliant store as the rest of the data. Each `KnowledgeChunk` row gains an `embedding vector(1536)` column populated by the document ingestion pipeline.

Two indexes are maintained on `KnowledgeChunk`:

- **HNSW** (`vector_cosine_ops`, m = 16, ef\_construction = 64) — approximate nearest-neighbour search for sub-millisecond similarity queries at scale.
- **Composite** `(orgId, enabled)` — fast pre-filtering so the ANN scan only touches the calling org's active chunks.

Similarity search is executed via raw SQL through `postgres.js` (bypassing Prisma, which does not support pgvector operators) using the `<=>` cosine distance operator.

---

## Document Ingestion Pipeline

Uploaded files (PDF, DOCX, PPTX) travel through an async pipeline managed by BullMQ:

```
Upload → S3/R2 storage → "extract" job → text extraction (officeparser)
       → token-based chunking (js-tiktoken, cl100k_base, 500 tok / 60 tok overlap)
       → bulk insert KnowledgeChunks → "embed-chunks" job
       → Voyage AI embeddings (voyage-3, 1536-d) → pgvector UPDATE
```

Document status transitions: `PENDING → EXTRACTING → CHUNKING → READY` (or `FAILED` on any error). Embedding is processed in batches of 10 with a 500 ms inter-batch delay to stay within rate limits.

Edited chunks have their embedding cleared automatically and are re-queued for re-embedding, so curated content stays in sync.

---

## Message Queue

**Broker:** Redis · **Queue library:** BullMQ

Redis serves two roles: session store (via ioredis, existing) and job broker (via BullMQ, new). The `document-processing` queue carries two job types — `extract` and `embed-chunks`. The worker (`src/workers/documentProcessor.ts`) runs as a separate process (`bun src/workers/documentProcessor.ts`) so CPU-intensive parsing does not block the HTTP server.

The vision adds further queue lanes for:
- Outbound coaching message delivery (WhatsApp, email, push)
- Scheduled survey dispatches
- Analytics aggregation jobs

---

## AI Layer

| Concern | Provider | Model |
|---|---|---|
| Embeddings | Voyage AI (via Anthropic key) | `voyage-3` (1536-d) |
| Coaching responses | Anthropic Claude | `claude-sonnet-4-6` |

The coaching loop: incoming beneficiary message → embed query → top-k chunk retrieval from org's knowledge base → context-augmented prompt → Claude response → outbound delivery. This keeps the model grounded in the organization's actual materials rather than general web knowledge.

---

## File Storage

**Provider:** Cloudflare R2 (S3-compatible) — can be swapped for AWS S3 by changing `S3_ENDPOINT` and `S3_REGION`.

Uploaded documents are stored at `knowledge/{orgId}/{uuid}/{filename}` using the AWS SDK v3 with path-style addressing. The document worker downloads from R2 at job time, processes the file in a temp directory, then discards the local copy.

---

## Docker & Deployment

```
┌─────────────────────────────────────┐
│  Docker Compose                     │
│                                     │
│  ┌─────────┐   ┌──────────────────┐ │
│  │   app   │──▶│  redis:alpine    │ │
│  │  :3000  │   │  (sessions +     │ │
│  │  (Bun)  │   │   job broker)    │ │
│  └────┬────┘   └──────────────────┘ │
│       │                             │
└───────┼─────────────────────────────┘
        │ external
        ▼
  db.cgcharitable.org:5432  (PostgreSQL 16 + pgvector)
  *.r2.cloudflarestorage.com (Cloudflare R2)
  api.voyageai.com           (Voyage AI embeddings)
  api.anthropic.com          (Claude — planned)
```

The app container is built from `oven/bun:1` in a multi-stage Dockerfile (deps → build/prisma-generate → runner). PostgreSQL runs externally (managed instance); the Postgres container in `docker-compose.yml` is commented out. Redis runs as a sidecar container with a persistent volume.

The document worker is not yet a separate Docker service — the vision is to add a `worker` service to the compose file pointing at `src/workers/documentProcessor.ts`, allowing independent scaling of ingestion throughput.

---

## Integrations

| Integration | Purpose |
|---|---|
| WhatsApp Business API | Primary beneficiary coaching channel — incoming messages trigger survey sessions and AI coaching replies |
| Google Sheets | Export survey responses; import beneficiary contact lists |
| CAS / Google / Microsoft OAuth | Staff and admin authentication |
| Nodemailer | Transactional email (notifications, exports) |
