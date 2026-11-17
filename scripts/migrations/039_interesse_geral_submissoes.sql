-- Formulário de interesse genérico, embarcado nas páginas do Wix. Tudo aditivo e idempotente.
--
-- Cada envio fica numa tabela própria, sem evento: o grupo do curso (água, terra, fogo, ar...)
-- vem da variável do código de embed e a página de origem vem do iframe. As tabelas de
-- formulários por evento não mudam; os links antigos continuam gravando nelas.
BEGIN;
CREATE TABLE IF NOT EXISTS interesse_geral_submissoes (
  id serial PRIMARY KEY,
  pessoa_id integer NOT NULL REFERENCES pessoas(id),
  grupo text,
  pagina_origem text,
  respostas jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS interesse_geral_submissoes_pessoa_idx ON interesse_geral_submissoes (pessoa_id, created_at);
CREATE INDEX IF NOT EXISTS interesse_geral_submissoes_created_idx ON interesse_geral_submissoes (created_at);

-- Mesma proteção das demais tabelas filhas de pessoa (migração 029): ninguém anexa
-- histórico a uma ficha que já foi mesclada. A função nasce na 029; sem ela, não há guarda.
DO $$
BEGIN
  IF to_regproc('prevent_merged_pessoa_child_mutation') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS interesse_geral_submissoes_merged_pessoa_guard ON interesse_geral_submissoes;
    CREATE TRIGGER interesse_geral_submissoes_merged_pessoa_guard
      BEFORE INSERT OR UPDATE OR DELETE ON interesse_geral_submissoes
      FOR EACH ROW EXECUTE FUNCTION prevent_merged_pessoa_child_mutation();
  END IF;
END $$;
COMMIT;
