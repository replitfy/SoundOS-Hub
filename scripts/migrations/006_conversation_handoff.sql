-- Migration 006: handoff automático da Sofia para atendimento humano
-- Adds status + handoff metadata to `conversations` (Documento 14A, cap. 13).
-- See artifacts/api-server/src/services/handoff.ts and sofia.ts's /sofia/chat.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ativa',
  ADD COLUMN IF NOT EXISTS handoff_reason text,
  ADD COLUMN IF NOT EXISTS handoff_summary text,
  ADD COLUMN IF NOT EXISTS handoff_triggered_at timestamptz,
  ADD COLUMN IF NOT EXISTS handoff_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS handoff_resolved_by text;

CREATE INDEX IF NOT EXISTS conversations_status_idx ON conversations (status);
