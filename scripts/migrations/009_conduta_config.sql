-- Migration 009: configuração editável da conduta comercial da Sofia
-- (Documento 14 — Triagem / Documento 15 — Playbook Comercial).
-- Linha única (id fixo = 1) com os blocos de instrução que services/conduta.ts
-- injeta no system prompt — antes eram constantes fixas no código, agora
-- podem ser editados pelo admin (ver GET/PUT /sofia/conduta). Campos nulos
-- significam "usar o texto padrão embutido no código". Idempotent.

CREATE TABLE IF NOT EXISTS conduta_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  triagem_block TEXT,
  comercial_block TEXT,
  forbidden_block TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
