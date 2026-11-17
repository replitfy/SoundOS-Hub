-- One-shot Airtable imports are auditable and repeatable without storing the
-- source payload. Source record IDs are durable natural keys; the field hash
-- lets a later run identify changed records without putting PII in reports.
CREATE TABLE IF NOT EXISTS airtable_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  base_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'execute')),
  source_sha256 TEXT NOT NULL,
  confirmation_digest TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  backup_path TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS airtable_sync_runs_base_started_idx
  ON airtable_sync_runs (base_id, started_at DESC);

CREATE TABLE IF NOT EXISTS airtable_source_links (
  id BIGSERIAL PRIMARY KEY,
  base_id TEXT NOT NULL,
  source_table_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('pessoa', 'course', 'class', 'curso_inscricao', 'enrollment')),
  entity_id BIGINT NOT NULL,
  source_fields_sha256 TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (base_id, source_table_id, source_record_id, entity_type)
);

CREATE INDEX IF NOT EXISTS airtable_source_links_entity_idx
  ON airtable_source_links (entity_type, entity_id);
