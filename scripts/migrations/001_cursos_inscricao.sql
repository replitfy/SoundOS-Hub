-- Migration: create cursos_inscricao table
-- Run this once per environment (dev, prod) if it does not already exist.
CREATE TABLE IF NOT EXISTS cursos_inscricao (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  nome        TEXT NOT NULL,
  descricao   TEXT,
  local       TEXT,
  data_inicio TEXT,
  data_fim    TEXT,
  observacoes TEXT,
  ativo       BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMP NOT NULL DEFAULT now(),
  updated_at  TIMESTAMP NOT NULL DEFAULT now()
);
