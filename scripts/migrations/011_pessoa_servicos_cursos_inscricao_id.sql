-- Migration 011: add cursos_inscricao_id FK to pessoa_servicos
-- Allows inscription counts and inscritos lists to survive link renames.
-- New rows written by POST /public/inscricao will carry the FK; existing
-- rows fall back to name-matching (servico_nome) until backfilled.
-- Idempotent.

ALTER TABLE pessoa_servicos
  ADD COLUMN IF NOT EXISTS cursos_inscricao_id INTEGER
    REFERENCES cursos_inscricao(id) ON DELETE SET NULL;
