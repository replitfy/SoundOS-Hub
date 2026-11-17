-- Associa links de inscrição pública ao curso operacional correspondente.
-- Nullable para não quebrar registros existentes.
ALTER TABLE cursos_inscricao
  ADD COLUMN IF NOT EXISTS course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL;
