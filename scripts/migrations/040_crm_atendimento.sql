-- CRM com lista, modal e WhatsApp. Tudo aditivo e repetível.
--
-- - informações livres no card; observações, tarefas e compromissos em tabelas próprias;
-- - quem enviou cada mensagem da conversa (a equipe vira role "staff"; o modelo de abertura fica
--   como "assistant" com kind = 'modelo_abertura', para a Sofia entender uma resposta como "sim");
-- - registro de autorização de contato e de "não quer receber", por pessoa (somente inserções).
-- A restrição de tipos de evento do histórico NÃO muda: as ações novas usam o tipo UPDATED.
BEGIN;

ALTER TABLE commercial_opportunities ADD COLUMN IF NOT EXISTS informacoes text;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_user_id integer REFERENCES soundos_users(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind text;

CREATE TABLE IF NOT EXISTS commercial_opportunity_notes (
  id serial PRIMARY KEY,
  opportunity_id integer NOT NULL REFERENCES commercial_opportunities(id) ON DELETE RESTRICT,
  text text NOT NULL CONSTRAINT commercial_opportunity_notes_text_not_blank CHECK (btrim(text) <> ''),
  author_user_id integer NOT NULL REFERENCES soundos_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commercial_opportunity_notes_opp_idx ON commercial_opportunity_notes (opportunity_id, created_at);

CREATE TABLE IF NOT EXISTS commercial_opportunity_tasks (
  id serial PRIMARY KEY,
  opportunity_id integer NOT NULL REFERENCES commercial_opportunities(id) ON DELETE RESTRICT,
  text text NOT NULL CONSTRAINT commercial_opportunity_tasks_text_not_blank CHECK (btrim(text) <> ''),
  due_at timestamptz,
  done_at timestamptz,
  done_by_user_id integer REFERENCES soundos_users(id),
  created_by_user_id integer NOT NULL REFERENCES soundos_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commercial_opportunity_tasks_opp_idx ON commercial_opportunity_tasks (opportunity_id, created_at);

CREATE TABLE IF NOT EXISTS commercial_opportunity_appointments (
  id serial PRIMARY KEY,
  opportunity_id integer NOT NULL REFERENCES commercial_opportunities(id) ON DELETE RESTRICT,
  title text NOT NULL CONSTRAINT commercial_opportunity_appointments_title_not_blank CHECK (btrim(title) <> ''),
  starts_at timestamptz NOT NULL,
  link text,
  created_by_user_id integer NOT NULL REFERENCES soundos_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commercial_opportunity_appointments_opp_idx ON commercial_opportunity_appointments (opportunity_id, starts_at);

CREATE TABLE IF NOT EXISTS pessoa_contato_registros (
  id serial PRIMARY KEY,
  pessoa_id integer NOT NULL REFERENCES pessoas(id),
  kind text NOT NULL CONSTRAINT pessoa_contato_registros_kind_check
    CHECK (kind IN ('AUTORIZOU', 'NAO_QUER_RECEBER', 'NAO_QUER_RECEBER_DESFEITO')),
  origem text NOT NULL CONSTRAINT pessoa_contato_registros_origem_check
    CHECK (origem IN ('FORMULARIO', 'CONVERSA_WHATSAPP', 'PRESENCIAL', 'OUTRO')),
  origem_texto text,
  registrado_por_user_id integer NOT NULL REFERENCES soundos_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pessoa_contato_registros_pessoa_idx ON pessoa_contato_registros (pessoa_id, created_at);

-- Mesma proteção das demais tabelas filhas de pessoa (migração 029): ninguém anexa
-- histórico a uma ficha que já foi mesclada.
DO $$
BEGIN
  IF to_regproc('prevent_merged_pessoa_child_mutation') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS pessoa_contato_registros_merged_pessoa_guard ON pessoa_contato_registros;
    CREATE TRIGGER pessoa_contato_registros_merged_pessoa_guard
      BEFORE INSERT OR UPDATE OR DELETE ON pessoa_contato_registros
      FOR EACH ROW EXECUTE FUNCTION prevent_merged_pessoa_child_mutation();
  END IF;
END $$;
COMMIT;
