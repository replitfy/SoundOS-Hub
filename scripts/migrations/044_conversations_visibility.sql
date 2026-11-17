-- Ocultar conversas de teste sem apagar mensagens, pessoas ou vínculos do CRM.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
