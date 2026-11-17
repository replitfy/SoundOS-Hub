-- Pessoa identity merge primitives. Additive, but deliberately not run by this
-- change: operators apply numbered migrations after reviewing their database.
ALTER TABLE pessoas
  ADD COLUMN IF NOT EXISTS merged_into_pessoa_id INTEGER
    REFERENCES pessoas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS pessoas_merged_into_idx
  ON pessoas (merged_into_pessoa_id);

CREATE TABLE IF NOT EXISTS pessoa_notes (
  id SERIAL PRIMARY KEY,
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  source_pessoa_id INTEGER REFERENCES pessoas(id) ON DELETE SET NULL,
  note_type TEXT NOT NULL DEFAULT 'merge_contact',
  contact_type TEXT,
  value TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pessoa_notes_pessoa_idx
  ON pessoa_notes (pessoa_id, created_at);

CREATE TABLE IF NOT EXISTS pessoa_merge_audits (
  id SERIAL PRIMARY KEY,
  source_pessoa_id INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE RESTRICT,
  target_pessoa_id INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE RESTRICT,
  actor_user_id INTEGER REFERENCES soundos_users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  options JSONB NOT NULL,
  source_snapshot JSONB NOT NULL,
  target_snapshot JSONB NOT NULL,
  result_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pessoa_merge_audits_source_target_unique
    UNIQUE (source_pessoa_id, target_pessoa_id)
);

-- Notes are append-only except for re-homing their pessoa FK during the same
-- audited merge transaction. Audit events are immutable without exception.
CREATE OR REPLACE FUNCTION prevent_pessoa_note_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('app.allow_pessoa_merge', true) = 'on'
     AND NEW.pessoa_id IS DISTINCT FROM OLD.pessoa_id
     AND NEW.body = OLD.body
     AND NEW.value = OLD.value
     AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pessoa notes are append-only';
END $$;
DROP TRIGGER IF EXISTS pessoa_notes_append_only ON pessoa_notes;
CREATE TRIGGER pessoa_notes_append_only
  BEFORE UPDATE OR DELETE ON pessoa_notes
  FOR EACH ROW EXECUTE FUNCTION prevent_pessoa_note_mutation();
CREATE OR REPLACE FUNCTION prevent_pessoa_merge_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pessoa merge audit is immutable';
END $$;
DROP TRIGGER IF EXISTS pessoa_merge_audits_append_only ON pessoa_merge_audits;
CREATE TRIGGER pessoa_merge_audits_append_only
  BEFORE UPDATE OR DELETE ON pessoa_merge_audits
  FOR EACH ROW EXECUTE FUNCTION prevent_pessoa_merge_audit_mutation();

-- A merged pessoa is a permanent tombstone. Enforce this below the HTTP layer
-- so stale IDs from any writer (Sofia, public forms, education, staff UI) cannot
-- mutate the tombstone or attach fresh history to it after the merge commits.
CREATE OR REPLACE FUNCTION prevent_merged_pessoa_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.merged_into_pessoa_id IS NOT NULL THEN
    RAISE EXCEPTION 'merged pessoa tombstones are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS pessoas_merged_tombstone_immutable ON pessoas;
CREATE TRIGGER pessoas_merged_tombstone_immutable
  BEFORE UPDATE OR DELETE ON pessoas
  FOR EACH ROW EXECUTE FUNCTION prevent_merged_pessoa_mutation();

CREATE OR REPLACE FUNCTION prevent_merged_pessoa_child_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_pessoa_id INTEGER;
  new_pessoa_id INTEGER;
  merged_target_id INTEGER;
BEGIN
  -- Only the audited merge transaction may re-home/delete existing children
  -- after it has marked the source as a tombstone.
  IF current_setting('app.allow_pessoa_merge', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    old_pessoa_id := OLD.pessoa_id;
    SELECT merged_into_pessoa_id INTO merged_target_id
      FROM pessoas WHERE id = old_pessoa_id FOR KEY SHARE;
    IF merged_target_id IS NOT NULL THEN
      RAISE EXCEPTION 'cannot mutate history attached to a merged pessoa tombstone'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    new_pessoa_id := NEW.pessoa_id;
    IF TG_OP = 'INSERT' OR new_pessoa_id IS DISTINCT FROM old_pessoa_id THEN
      SELECT merged_into_pessoa_id INTO merged_target_id
        FROM pessoas WHERE id = new_pessoa_id FOR KEY SHARE;
      IF merged_target_id IS NOT NULL THEN
        RAISE EXCEPTION 'cannot attach history to a merged pessoa tombstone'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

DO $$
DECLARE
  child_table TEXT;
BEGIN
  FOREACH child_table IN ARRAY ARRAY[
    'pessoa_servicos', 'pessoa_participacoes', 'pessoa_instrumentos',
    'conversations', 'sofia_decision_runs', 'pessoa_evidencias',
    'pessoa_campos_confirmados', 'evento_formulario_submissoes',
    'evento_preinscricoes', 'enrollments', 'video_envios',
    'commercial_opportunities', 'pessoa_notes'
  ]
  LOOP
    IF to_regclass(child_table) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', child_table || '_merged_pessoa_guard', child_table);
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_merged_pessoa_child_mutation()',
        child_table || '_merged_pessoa_guard',
        child_table
      );
    END IF;
  END LOOP;
END $$;

-- Existing evidence is also append-only. Re-homing its pessoa FK is permitted
-- only inside the merge transaction, after the operation has been audited by
-- the caller's authenticated context.
CREATE OR REPLACE FUNCTION pessoa_evidencias_block_mutation()
RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_pessoa_merge', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND current_setting('app.allow_evidencia_cascade_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'pessoa_evidencias is append-only: % is not permitted (row id=%)', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;