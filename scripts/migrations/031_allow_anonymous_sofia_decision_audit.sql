-- Public factual questions can be answered before a conversation is linked to
-- a pessoa. Keep those decisions auditable through conversation_id.
ALTER TABLE sofia_decision_runs
  ALTER COLUMN pessoa_id DROP NOT NULL;