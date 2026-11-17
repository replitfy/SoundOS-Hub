-- Sofia atende o WhatsApp pelo Hablla. Tudo aditivo e idempotente.
--
-- ATENÇÃO (restrições com sufixo _v2): o Publish compara dev e produção por NOME de restrição.
-- Quando esta migração só trocou o conteúdo de conversations_canal_check e canal_envios_status_check,
-- o Publish levou as colunas novas e deixou as restrições antigas na produção, que passou a recusar
-- conversas e envios do WhatsApp (erro 23514). Nomes novos fazem o Publish remover as antigas e criar
-- as novas. Não volte a editar uma restrição mantendo o nome: crie um nome novo.
--
-- 1) conversations aceita o canal 'whatsapp'.
-- 2) hablla_config ganha a chave "Sofia responde no WhatsApp" (desligada) e o hash do
--    token do webhook do WhatsApp, separado do token do Instagram. A linha pode não
--    existir: o código trata ausência como "desligado, sem token".
-- 3) hablla_eventos (que já tem a coluna canal) ganha índice por canal, para a lista
--    de eventos de cada canal não misturar com a do outro.
-- 4) canal_envios ganha o estado de entrega (aceito/enviado/entregue/lido/falhou), o id
--    da fila do Hablla e o id da mensagem na Meta, com índices para casar os eventos
--    de status com o envio. 'enviado' continua válido (Instagram).

DO $$
BEGIN
  ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_canal_check;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_canal_check_v2') THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_canal_check_v2 CHECK (canal IN ('interno', 'instagram', 'whatsapp'));
  END IF;
END $$;

ALTER TABLE hablla_config ADD COLUMN IF NOT EXISTS whatsapp_responde boolean NOT NULL DEFAULT false;
ALTER TABLE hablla_config ADD COLUMN IF NOT EXISTS whatsapp_webhook_token_hash text;
ALTER TABLE hablla_config ADD COLUMN IF NOT EXISTS whatsapp_webhook_token_gerado_em timestamptz;

CREATE INDEX IF NOT EXISTS hablla_eventos_canal_created_idx ON hablla_eventos (canal, created_at DESC);

ALTER TABLE canal_envios ADD COLUMN IF NOT EXISTS fila_id text;
ALTER TABLE canal_envios ADD COLUMN IF NOT EXISTS meta_message_id text;
ALTER TABLE canal_envios ADD COLUMN IF NOT EXISTS entrega_atualizada_em timestamptz;
DO $$
BEGIN
  ALTER TABLE canal_envios DROP CONSTRAINT IF EXISTS canal_envios_status_check;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'canal_envios_status_check_v2') THEN
    ALTER TABLE canal_envios
      ADD CONSTRAINT canal_envios_status_check_v2
      CHECK (status IN ('aceito', 'enviado', 'entregue', 'lido', 'falhou'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS canal_envios_fila_idx ON canal_envios (canal, fila_id) WHERE fila_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS canal_envios_meta_message_idx ON canal_envios (canal, meta_message_id) WHERE meta_message_id IS NOT NULL;
