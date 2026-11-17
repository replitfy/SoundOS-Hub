-- Migration 002: RAG knowledge base — pgvector extension + knowledge_chunks table
-- Applied via executeSql()

-- 1. Enable pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Alter knowledge_items: add RAG-specific columns (idempotent guards)
ALTER TABLE knowledge_items
  ADD COLUMN IF NOT EXISTS file_name     TEXT,
  ADD COLUMN IF NOT EXISTS file_size     INTEGER,
  ADD COLUMN IF NOT EXISTS chunk_count   INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS content_hash  TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT;

-- 3. Create knowledge_chunks table
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id                SERIAL PRIMARY KEY,
  knowledge_item_id INTEGER NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  user_id           TEXT    NOT NULL DEFAULT 'default',
  chunk_index       INTEGER NOT NULL,
  content           TEXT    NOT NULL,
  token_count       INTEGER NOT NULL DEFAULT 0,
  embedding         vector(1536),
  search_vector     tsvector GENERATED ALWAYS AS (to_tsvector('portuguese', content)) STORED,
  created_at        TIMESTAMP DEFAULT NOW() NOT NULL
);

-- 4. HNSW index for cosine similarity vector search
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw_idx
  ON knowledge_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 5. GIN index for full-text tsvector search (BM25 / Portuguese)
CREATE INDEX IF NOT EXISTS knowledge_chunks_search_vector_gin_idx
  ON knowledge_chunks
  USING gin (search_vector);

-- 6. Composite index for user_id + knowledge_item_id filtering
CREATE INDEX IF NOT EXISTS knowledge_chunks_user_item_idx
  ON knowledge_chunks (user_id, knowledge_item_id);
