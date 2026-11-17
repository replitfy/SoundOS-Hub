-- Arquivamento reversível e independente de pessoas. O valor NULL mantém todos
-- os registros preexistentes nas listas normais; uma data indica quando a ficha
-- foi arquivada sem remover nenhum relacionamento.
ALTER TABLE pessoas
  ADD COLUMN IF NOT EXISTS arquivado_em TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS pessoas_arquivado_em_idx
  ON pessoas (arquivado_em);