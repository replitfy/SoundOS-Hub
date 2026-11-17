-- Sofia atende o Instagram pelo Hablla. Tudo aditivo e idempotente.
--
-- 1) conversations ganha canal e @usuário (conversas antigas ficam "interno").
-- 2) canal_contatos liga o id externo do contato (IGSID) a uma única conversa.
-- 3) hablla_eventos guarda TODO evento recebido (payload bruto) e o desfecho.
-- 4) canal_envios registra cada resposta enviada (ou que falhou) ao contato.
-- 5) hablla_config: chave "Sofia responde no Instagram" (desligada) e hash do
--    token do webhook. A linha pode não existir: o código trata ausência como
--    "desligado, sem token" (a produção não recebe seeds pelo Publish).

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS canal text NOT NULL DEFAULT 'interno';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS canal_usuario text;
-- O nome termina em _v2 de propósito: o Publish compara os bancos por nome de restrição e não
-- percebe quando uma restrição de mesmo nome muda de conteúdo (foi o que deixou a produção
-- recusando conversas do WhatsApp). Ver a migração 038. Aceita 'whatsapp' desde já para que
-- reexecutar esta migração nunca volte a uma lista mais curta.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_canal_check_v2') THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_canal_check_v2 CHECK (canal IN ('interno', 'instagram', 'whatsapp'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS canal_contatos (
  id serial PRIMARY KEY,
  canal text NOT NULL,
  contato_externo_id text NOT NULL,
  usuario text,
  conversation_id integer NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canal_contatos_canal_contato_key UNIQUE (canal, contato_externo_id)
);
CREATE INDEX IF NOT EXISTS canal_contatos_conversation_idx ON canal_contatos (conversation_id);

CREATE TABLE IF NOT EXISTS hablla_eventos (
  id serial PRIMARY KEY,
  canal text NOT NULL DEFAULT 'instagram',
  externo_id text NOT NULL,
  tipo_evento text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'recebido',
  motivo text,
  conversation_id integer REFERENCES conversations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processado_em timestamptz,
  CONSTRAINT hablla_eventos_externo_id_key UNIQUE (externo_id),
  CONSTRAINT hablla_eventos_status_check CHECK (status IN ('recebido', 'respondido', 'ignorado', 'falhou'))
);
CREATE INDEX IF NOT EXISTS hablla_eventos_created_idx ON hablla_eventos (created_at DESC);

CREATE TABLE IF NOT EXISTS canal_envios (
  id serial PRIMARY KEY,
  conversation_id integer NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id integer REFERENCES messages(id) ON DELETE SET NULL,
  canal text NOT NULL,
  texto text,
  status text NOT NULL,
  erro text,
  externo_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canal_envios_status_check_v2 CHECK (status IN ('aceito', 'enviado', 'entregue', 'lido', 'falhou'))
);
CREATE INDEX IF NOT EXISTS canal_envios_conversation_idx ON canal_envios (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS canal_envios_message_idx ON canal_envios (message_id);

CREATE TABLE IF NOT EXISTS hablla_config (
  id integer PRIMARY KEY DEFAULT 1,
  instagram_responde boolean NOT NULL DEFAULT false,
  webhook_token_hash text,
  webhook_token_gerado_em timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hablla_config_singleton CHECK (id = 1)
);
