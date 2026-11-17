-- Log do motor cognitivo por conversa: o painel de auditoria lê as decisões de
-- uma conversa ordenadas por created_at. O índice antigo cobria apenas
-- conversation_id, deixando a ordenação para um sort em memória.
-- O índice composto abaixo atende filtro + ordenação de uma vez e torna o
-- antigo redundante (conversation_id é seu prefixo).
-- Idempotent — safe to run multiple times.

CREATE INDEX IF NOT EXISTS sofia_decision_runs_conversation_created_idx
  ON sofia_decision_runs (conversation_id, created_at DESC);

DROP INDEX IF EXISTS sofia_decision_runs_conversation_idx;
