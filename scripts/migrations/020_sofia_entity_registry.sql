CREATE TABLE IF NOT EXISTS sofia_entity_registry (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('offer','instrument_family','event')),
  stable_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  approved_facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  sensitive BOOLEAN NOT NULL DEFAULT false,
  review_status TEXT NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft','approved','rejected')),
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_type, source_table, source_id)
);
ALTER TABLE conduta_config ADD COLUMN IF NOT EXISTS fast_path_enabled BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS sofia_entity_registry_type_idx ON sofia_entity_registry(entity_type, review_status);
CREATE TABLE IF NOT EXISTS sofia_registry_gap_reports (
  id SERIAL PRIMARY KEY,
  entity_id INTEGER REFERENCES sofia_entity_registry(id) ON DELETE CASCADE,
  gap_code TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sofia_registry_gap_unique_idx ON sofia_registry_gap_reports(entity_id, gap_code);
-- Conservative backfill: identity only; no commercial capability and no factual
-- approval is inferred from legacy rows.
INSERT INTO sofia_entity_registry (entity_type, stable_key, display_name, source_table, source_id, approved_facts, source_refs)
SELECT 'offer', 'course:' || id, name, 'courses', id,
       jsonb_build_object('description', description, 'modality', modality, 'workload', workload, 'cycle', cycle),
       jsonb_build_array('courses:' || id)
FROM courses WHERE active = true ON CONFLICT (stable_key) DO NOTHING;
INSERT INTO sofia_entity_registry (entity_type, stable_key, display_name, source_table, source_id, approved_facts, source_refs)
SELECT 'instrument_family', 'instrument:' || id, nome, 'instrumentos_catalogo', id,
       jsonb_build_object('description', descricao), jsonb_build_array('instrumentos_catalogo:' || id)
FROM instrumentos_catalogo WHERE ativo = true ON CONFLICT (stable_key) DO NOTHING;
INSERT INTO sofia_entity_registry (entity_type, stable_key, display_name, source_table, source_id, approved_facts, source_refs)
SELECT 'event', 'event:' || id, nome, 'cursos_inscricao', id,
       jsonb_build_object('description', descricao, 'modality', local, 'eventType', tipo_evento),
       jsonb_build_array('cursos_inscricao:' || id)
FROM cursos_inscricao WHERE ativo = true ON CONFLICT (stable_key) DO NOTHING;
INSERT INTO sofia_registry_gap_reports (entity_id, gap_code, details)
SELECT id, 'SOURCE_REVIEW_REQUIRED', jsonb_build_object('sourceTable', source_table, 'sourceId', source_id)
FROM sofia_entity_registry WHERE review_status <> 'approved'
ON CONFLICT (entity_id, gap_code) DO NOTHING;
ALTER TABLE sofia_decision_runs ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_handoff_reason_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_handoff_reason_check CHECK (
  handoff_reason IS NULL OR handoff_reason IN (
   'pedido_explicito','confianca_baixa','sinais_contraditorios','tema_sensivel',
   'duvida_financeira','especialista_necessario','elegibilidade_insuficiente',
   'fechamento_comercial','informacao_comercial_bloqueada','oferta_sensivel'
  )
);