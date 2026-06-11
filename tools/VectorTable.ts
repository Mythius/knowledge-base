import { getEncoding } from "js-tiktoken";
import type { Sql } from "postgres";
import { sql } from "./db.ts";

// ── Embedding providers ────────────────────────────────────────────────────

const OLLAMA_MODEL = "rjmalagon/gte-qwen2-1.5b-instruct-embed-f16";
const OPENAI_MODEL = "text-embedding-3-small";
const VOYAGE_MODEL = "voyage-3";

async function embedOpenAI(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: text, model: OPENAI_MODEL }),
  });
  if (!res.ok) throw new Error(`OpenAI embedding error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}

async function embedVoyage(text: string, inputType: "document" | "query"): Promise<number[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: [text], model: VOYAGE_MODEL, input_type: inputType }),
  });
  if (!res.ok) throw new Error(`Voyage AI embedding error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}

async function embedOllama(text: string): Promise<number[]> {
  const base = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  const res = await fetch(`${base}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama embedding error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
}

export async function embedText(
  text: string,
  inputType: "document" | "query" = "document",
  provider?: "openai" | "voyageai" | "ollama",
): Promise<number[]> {
  const p = provider ?? process.env.EMBEDDING_PROVIDER ?? "openai";
  if (p === "ollama") return embedOllama(text);
  if (p === "voyageai") return embedVoyage(text, inputType);
  return embedOpenAI(text);
}

/**
 * Run a pgvector similarity query against any table.
 * The callback receives the shared sql tagged-template and the pre-formatted
 * vector literal so callers can write typed queries without their own connection.
 */
export async function vectorQuery<T extends object>(
  embedding: number[],
  query: (sql: Sql, vec: string) => Promise<T[]>,
): Promise<T[]> {
  return query(sql, `[${embedding.join(",")}]`);
}

/**
 * Simple similarity search: SELECT * from any table with an `embedding` column,
 * ordered closest-first. Use VectorTable for filtering, joins, and inserts.
 */
export async function vectorSearch<T extends object>(
  table: string,
  embedding: number[],
  limit = 5,
): Promise<(T & { similarity: number })[]> {
  const vec = `[${embedding.join(",")}]`;
  return sql<(T & { similarity: number })[]>`
    SELECT *, 1 - (embedding <=> ${vec}::vector) AS similarity
    FROM ${sql(table)}
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${vec}::vector
    LIMIT ${limit}
  `;
}

// ── VectorTable class ──────────────────────────────────────────────────────

export interface VectorTableOptions {
  /** Column holding the pgvector embedding. Default: "embedding" */
  embeddingColumn?: string;
  /** Column holding the plain text that was embedded. Default: "content" */
  contentColumn?: string;
  /** Override the EMBEDDING_PROVIDER env var for this table. */
  provider?: "openai" | "voyageai" | "ollama";
  /** Table to JOIN in findDetailed (e.g. "KnowledgeDocument"). */
  sourceTable?: string;
  /**
   * FK column in the main table pointing to sourceTable's id.
   * Defaults to a derived name: "KnowledgeDocument" → "documentId".
   */
  sourceKey?: string;
  /** WHERE conditions always applied to every query (e.g. { enabled: true }). */
  defaultWhere?: Record<string, unknown>;
  /** Max tokens per chunk in addSource. Default: 500 */
  chunkSize?: number;
  /** Overlap tokens between adjacent chunks. Default: 60 */
  chunkOverlap?: number;
}

export interface FindOptions {
  limit?: number;
  /** Merged with defaultWhere; per-query values take precedence. */
  where?: Record<string, unknown>;
}

export class VectorTable {
  readonly table: string;
  private readonly embeddingCol: string;
  private readonly contentCol: string;
  private readonly provider?: "openai" | "voyageai" | "ollama";
  private readonly sourceTable?: string;
  private readonly sourceKey?: string;
  private readonly defaultWhere: Record<string, unknown>;
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;

  constructor(table: string, options: VectorTableOptions = {}) {
    this.table = table;
    this.embeddingCol = options.embeddingColumn ?? "embedding";
    this.contentCol = options.contentColumn ?? "content";
    this.provider = options.provider;
    this.sourceTable = options.sourceTable;
    this.sourceKey = options.sourceKey ?? deriveKey(options.sourceTable);
    this.defaultWhere = options.defaultWhere ?? {};
    this.chunkSize = options.chunkSize ?? 500;
    this.chunkOverlap = options.chunkOverlap ?? 60;
  }

  /** Embed text using this table's configured provider. */
  embed(text: string, inputType: "document" | "query" = "document"): Promise<number[]> {
    return embedText(text, inputType, this.provider);
  }

  /**
   * Semantic search on the main table.
   * Returns matching rows (embedding column stripped) with a `similarity` score.
   */
  async find<T extends object>(
    query: string,
    options: FindOptions = {},
  ): Promise<(T & { similarity: number })[]> {
    const { limit = 5, where = {} } = options;
    const vec = await this.toVec(query, "query");
    const extra = this.buildConditions({ ...this.defaultWhere, ...where });

    const rows = await sql<(T & { similarity: number })[]>`
      SELECT *,
             1 - (${sql(this.embeddingCol)} <=> ${vec}::vector) AS similarity
      FROM   ${sql(this.table)}
      WHERE  ${sql(this.embeddingCol)} IS NOT NULL
      ${extra ? sql`AND ${extra}` : sql``}
      ORDER  BY ${sql(this.embeddingCol)} <=> ${vec}::vector
      LIMIT  ${limit}
    `;
    return rows.map(r => dropKey(r, this.embeddingCol)) as (T & { similarity: number })[];
  }

  /**
   * Semantic search with a JOIN to the configured sourceTable.
   * Source row is returned under `.source` to avoid column-name collisions.
   *
   * @example
   * const hits = await kb.findDetailed<ChunkRow, DocRow>(q, { where: { orgId } });
   * hits[0].content      // from main table
   * hits[0].source.filename  // from sourceTable
   */
  async findDetailed<T extends object, S extends object = Record<string, unknown>>(
    query: string,
    options: FindOptions = {},
  ): Promise<(T & { source: S; similarity: number })[]> {
    if (!this.sourceTable || !this.sourceKey) {
      return this.find<T>(query, options) as unknown as (T & { source: S; similarity: number })[];
    }

    const { limit = 5, where = {} } = options;
    const vec = await this.toVec(query, "query");
    const extra = this.buildConditions({ ...this.defaultWhere, ...where }, "c");

    const rows = await sql<(T & { source: S; similarity: number })[]>`
      SELECT c.*,
             to_json(s) AS source,
             1 - (c.${sql(this.embeddingCol)} <=> ${vec}::vector) AS similarity
      FROM   ${sql(this.table)} c
      JOIN   ${sql(this.sourceTable)} s ON s.id = c.${sql(this.sourceKey)}
      WHERE  c.${sql(this.embeddingCol)} IS NOT NULL
      ${extra ? sql`AND ${extra}` : sql``}
      ORDER  BY c.${sql(this.embeddingCol)} <=> ${vec}::vector
      LIMIT  ${limit}
    `;
    return rows.map(r => dropKey(r, this.embeddingCol)) as (T & { source: S; similarity: number })[];
  }

  /**
   * Embed a single piece of text and insert it as one row.
   * Pass extra column values via `data` (e.g. `{ orgId: 1, chunkIndex: 0 }`).
   */
  async insert(text: string, data: Record<string, unknown> = {}): Promise<void> {
    const vec = await this.toVec(text, "document");
    const row = { [this.contentCol]: text, ...data };
    const cols = Object.keys(row).map(k => `"${k}"`).join(", ");
    const placeholders = Object.keys(row).map((_, i) => `$${i + 1}`).join(", ");
    const vecIdx = Object.keys(row).length + 1;
    await sql.unsafe(
      `INSERT INTO "${this.table}" (${cols}, "${this.embeddingCol}") ` +
      `VALUES (${placeholders}, $${vecIdx}::vector)`,
      [...Object.values(row) as any[], vec],
    );
  }

  /**
   * Split `text` into overlapping chunks, embed each, and insert all rows.
   * Pass shared column values via `data` (e.g. `{ orgId: 1, documentId: "abc" }`).
   */
  async addSource(text: string, data: Record<string, unknown> = {}): Promise<void> {
    const chunks = chunkText(text, this.chunkSize, this.chunkOverlap);
    for (let i = 0; i < chunks.length; i++) {
      await this.insert(chunks[i], { ...data, chunkIndex: i });
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async toVec(text: string, inputType: "document" | "query"): Promise<string> {
    const embedding = await this.embed(text, inputType);
    return `[${embedding.join(",")}]`;
  }

  private buildConditions(where: Record<string, unknown>, alias?: string) {
    const entries = Object.entries(where);
    if (!entries.length) return null;
    const parts = entries.map(([k, v]) =>
      alias
        ? sql`${sql(alias)}.${sql(k)} = ${v as any}`
        : sql`${sql(k)} = ${v as any}`,
    );
    return parts.reduce((a, b) => sql`${a} AND ${b}`);
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────

function dropKey<T extends object>(obj: T, key: string): object {
  const copy = { ...obj };
  delete (copy as any)[key];
  return copy;
}

/** "KnowledgeDocument" → "documentId", "User" → "userId" */
function deriveKey(sourceTable?: string): string | undefined {
  if (!sourceTable) return undefined;
  const name = sourceTable.replace(/^Knowledge/, "");
  return name.charAt(0).toLowerCase() + name.slice(1) + "Id";
}

/**
 * Split text into overlapping token-based chunks using the cl100k_base encoding
 * (same tokenizer used by OpenAI and Voyage AI models).
 * Exported so ingestion pipelines can chunk text before storing it.
 */
export function chunkText(text: string, chunkSize = 500, overlapTokens = 60): string[] {
  const enc = getEncoding("cl100k_base");
  const tokens = enc.encode(text);
  const chunks: string[] = [];
  const step = Math.max(1, chunkSize - overlapTokens);

  let start = 0;
  while (start < tokens.length) {
    const end = Math.min(start + chunkSize, tokens.length);
    chunks.push(enc.decode(tokens.slice(start, end)));
    if (end >= tokens.length) break;
    start += step;
  }

  return chunks;
}
