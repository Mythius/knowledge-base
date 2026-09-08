-- Requires pgvector extension (already enabled)
ALTER TABLE "KnowledgeChunk" ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- HNSW index for fast approximate cosine similarity search
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_embedding_hnsw_idx"
  ON "KnowledgeChunk"
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
