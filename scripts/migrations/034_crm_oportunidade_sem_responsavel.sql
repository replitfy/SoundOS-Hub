-- Cartão de interesse aberto pela Sofia entra no CRM sem responsável: o time assume.
-- A regra "toda oportunidade ativa tem responsável" continua valendo para tudo o mais;
-- só a origem SOFIA_INTERESSE pode ficar sem dono, e só enquanto ninguém assumiu.
-- Próxima ação, tipo, texto e data continuam obrigatórios para todas as origens.
--
-- ATENÇÃO (restrição com sufixo _v2): o Publish compara dev e produção por NOME de restrição.
-- Reescrever commercial_opportunities_active_fields mantendo o nome não chegou à produção, que
-- seguiu exigindo responsável e recusava todo cartão de formulário/Sofia (erro 23514 -> HTTP 500).
-- A regra nova vive em commercial_opportunities_active_fields_v2 e a antiga é removida aqui.
-- Idempotente: pode rodar a cada merge.

ALTER TABLE commercial_opportunities
  DROP CONSTRAINT IF EXISTS commercial_opportunities_active_fields;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commercial_opportunities_active_fields_v2') THEN
    ALTER TABLE commercial_opportunities
      ADD CONSTRAINT commercial_opportunities_active_fields_v2 CHECK (
        stage = 'CLOSED'
        OR (
          (owner_user_id IS NOT NULL OR source = 'SOFIA_INTERESSE')
          AND next_task_type IS NOT NULL
          AND next_task_type <> 'NONE'
          AND btrim(coalesce(next_task_text, '')) <> ''
          AND next_task_at IS NOT NULL
        )
      );
  END IF;
END
$$;
