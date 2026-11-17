-- Motor de decisão da Sofia (Documento 14A): registro auditável de cada
-- decisão relevante (evidências consideradas, elegibilidade avaliada, oferta
-- alvo e Next Best Action). Idempotent — safe to run multiple times.

CREATE TABLE IF NOT EXISTS sofia_decision_runs (
  id SERIAL PRIMARY KEY,
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  conduta TEXT,
  prompt_id INTEGER,
  model TEXT,
  evidencias_consideradas JSONB NOT NULL DEFAULT '[]',
  elegibilidade_status TEXT NOT NULL,
  elegibilidade_motivo TEXT,
  oferta_principal TEXT,
  oferta_alternativa TEXT,
  nba_categoria TEXT NOT NULL,
  nba_justificativa TEXT NOT NULL,
  nivel_confianca TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sofia_decision_runs_pessoa_idx ON sofia_decision_runs (pessoa_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sofia_decision_runs_conversation_idx ON sofia_decision_runs (conversation_id);
