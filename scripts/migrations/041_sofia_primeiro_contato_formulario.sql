-- Sofia inicia a conversa com quem preenche o formulário de interesse e marcou o consentimento.
-- Tudo aditivo e repetível:
--   * pessoa_contato_registros passa a aceitar um registro feito pelo próprio sistema (formulário ou Sofia),
--     sem usuário da equipe como autor; os registros existentes continuam com autor e não mudam;
--   * os dois formulários públicos guardam a caixa de consentimento e o texto exato exibido;
--   * hablla_config ganha a chave "Sofia inicia conversa com quem preenche o formulário" (desligada);
--   * primeiro_contato_automatico registra cada tentativa (ou o motivo de não enviar), uma por card, e
--     garante um único modelo automático por pessoa e por telefone mesmo com envios simultâneos.
BEGIN;

ALTER TABLE pessoa_contato_registros ALTER COLUMN registrado_por_user_id DROP NOT NULL;
ALTER TABLE pessoa_contato_registros ADD COLUMN IF NOT EXISTS registrado_pelo_sistema boolean NOT NULL DEFAULT false;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pessoa_contato_registros_autor_check') THEN
    ALTER TABLE pessoa_contato_registros ADD CONSTRAINT pessoa_contato_registros_autor_check
      CHECK ((registrado_por_user_id IS NOT NULL) <> registrado_pelo_sistema);
  END IF;
END $$;

ALTER TABLE interesse_geral_submissoes ADD COLUMN IF NOT EXISTS consentimento_whatsapp boolean NOT NULL DEFAULT false;
ALTER TABLE interesse_geral_submissoes ADD COLUMN IF NOT EXISTS consentimento_texto text;
ALTER TABLE evento_formulario_submissoes ADD COLUMN IF NOT EXISTS consentimento_whatsapp boolean NOT NULL DEFAULT false;
ALTER TABLE evento_formulario_submissoes ADD COLUMN IF NOT EXISTS consentimento_texto text;

ALTER TABLE hablla_config ADD COLUMN IF NOT EXISTS sofia_inicia_conversa boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS primeiro_contato_automatico (
  id serial PRIMARY KEY,
  pessoa_id integer NOT NULL REFERENCES pessoas(id),
  opportunity_id integer NOT NULL REFERENCES commercial_opportunities(id),
  -- Chave do telefone (sem o 55), quando o telefone era válido: um modelo automático por número.
  telefone_chave text,
  resultado text NOT NULL CONSTRAINT primeiro_contato_automatico_resultado_check
    CHECK (resultado IN ('EM_ANDAMENTO', 'ENVIADO', 'FALHOU', 'NAO_ENVIADO')),
  -- Código do motivo (nunca texto de erro do provedor).
  motivo text,
  conversation_id integer REFERENCES conversations(id),
  message_id integer REFERENCES messages(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Uma tentativa por card.
CREATE UNIQUE INDEX IF NOT EXISTS primeiro_contato_automatico_card_uq ON primeiro_contato_automatico (opportunity_id);
-- Um modelo automático por pessoa e por telefone (as linhas "não enviado" não contam).
CREATE UNIQUE INDEX IF NOT EXISTS primeiro_contato_automatico_pessoa_uq ON primeiro_contato_automatico (pessoa_id)
  WHERE resultado <> 'NAO_ENVIADO';
CREATE UNIQUE INDEX IF NOT EXISTS primeiro_contato_automatico_telefone_uq ON primeiro_contato_automatico (telefone_chave)
  WHERE resultado <> 'NAO_ENVIADO' AND telefone_chave IS NOT NULL;
CREATE INDEX IF NOT EXISTS primeiro_contato_automatico_created_idx ON primeiro_contato_automatico (created_at)
  WHERE resultado <> 'NAO_ENVIADO';

COMMIT;
