-- Classificação geral das ofertas do ecossistema. Registros existentes eram
-- cursos/links acadêmicos e permanecem como Education + Curso.
ALTER TABLE cursos_inscricao
  ADD COLUMN IF NOT EXISTS nucleo TEXT NOT NULL DEFAULT 'EDUCATION',
  ADD COLUMN IF NOT EXISTS tipo_evento TEXT NOT NULL DEFAULT 'CURSO';

ALTER TABLE cursos_inscricao
  DROP CONSTRAINT IF EXISTS cursos_inscricao_nucleo_check,
  ADD CONSTRAINT cursos_inscricao_nucleo_check
    CHECK (nucleo IN ('EDUCATION', 'EXPERIENCES')),
  DROP CONSTRAINT IF EXISTS cursos_inscricao_tipo_evento_check,
  ADD CONSTRAINT cursos_inscricao_tipo_evento_check
    CHECK (tipo_evento IN ('CURSO', 'WORKSHOP', 'CONCERTO', 'VIVENCIA', 'RETIRO', 'CERIMONIA', 'OUTRO'));

CREATE INDEX IF NOT EXISTS cursos_inscricao_nucleo_tipo_idx
  ON cursos_inscricao (nucleo, tipo_evento);