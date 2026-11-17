-- Migration 005: pessoa_evidencias + pessoa_campos_confirmados (CRM evidence mechanism)
-- Applied: 2026-08-06 via executeSql() / scripts/post-merge.sh
--
-- Append-only evidence log for every write to a tracked pessoa field (human or Sofia),
-- plus a marker table for fields a human has confirmed (which the Sofia updatePessoa
-- tool must never silently overwrite). See artifacts/api-server/src/services/evidencias.ts.

CREATE TABLE IF NOT EXISTS pessoa_evidencias (
  id serial PRIMARY KEY,
  pessoa_id integer NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  campo text NOT NULL,
  valor text,
  tipo_evidencia text NOT NULL,
  origem text NOT NULL,
  nivel_confianca text NOT NULL,
  aplicada text NOT NULL DEFAULT 'sim',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pessoa_evidencias_pessoa_id_idx ON pessoa_evidencias (pessoa_id);
CREATE INDEX IF NOT EXISTS pessoa_evidencias_pessoa_campo_idx ON pessoa_evidencias (pessoa_id, campo);

CREATE TABLE IF NOT EXISTS pessoa_campos_confirmados (
  id serial PRIMARY KEY,
  pessoa_id integer NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  campo text NOT NULL,
  confirmado_por text NOT NULL,
  confirmado_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pessoa_campos_confirmados_pessoa_campo_idx ON pessoa_campos_confirmados (pessoa_id, campo);

-- Append-only enforcement: pessoa_evidencias is an audit trail. No application
-- code path, maintenance script, or future direct-SQL access should ever be
-- able to alter or erase a recorded evidence row — only INSERT is allowed.
-- This is enforced at the database level (not just by convention) so that even
-- a compromised app credential or an ad-hoc `UPDATE`/`DELETE` cannot silently
-- rewrite history.
--
-- UPDATE is unconditionally rejected — evidence rows are never edited.
--
-- DELETE is rejected UNLESS the current transaction explicitly opts in via the
-- session-local flag `app.allow_evidencia_cascade_delete = 'on'`. This flag is
-- set for exactly one legitimate case: permanently deleting a whole pessoa
-- record (which cascades into this table via ON DELETE CASCADE above) — see
-- `DELETE /pessoas/:id` in pessoas.ts, which sets it right before the delete.
-- Any other DELETE (ad-hoc SQL, a maintenance script, a future code path that
-- forgets to reason about this) is rejected by default.
CREATE OR REPLACE FUNCTION pessoa_evidencias_block_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_evidencia_cascade_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'pessoa_evidencias is append-only: % is not permitted (row id=%)', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pessoa_evidencias_no_update ON pessoa_evidencias;
CREATE TRIGGER pessoa_evidencias_no_update
  BEFORE UPDATE ON pessoa_evidencias
  FOR EACH ROW EXECUTE FUNCTION pessoa_evidencias_block_mutation();

DROP TRIGGER IF EXISTS pessoa_evidencias_no_delete ON pessoa_evidencias;
CREATE TRIGGER pessoa_evidencias_no_delete
  BEFORE DELETE ON pessoa_evidencias
  FOR EACH ROW EXECUTE FUNCTION pessoa_evidencias_block_mutation();
