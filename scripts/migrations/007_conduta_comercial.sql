-- Migration 007: conduta comercial da Sofia (Documento 15 — Playbook Comercial)
-- Adds an audit column to `messages` recording which conduct (triagem/comercial)
-- was active when each message was produced.
-- See artifacts/api-server/src/services/conduta.ts and sofia.ts's /sofia/chat.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS conduta text;

-- Note: HANDOFF_REASONS gained "elegibilidade_insuficiente" and
-- "fechamento_comercial" — handoff_reason is a plain text column (no CHECK
-- constraint), so no migration is required for the new enum values.
