BEGIN;

ALTER TABLE sofia_entity_registry
  ADD COLUMN IF NOT EXISTS runtime_aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS superseded_by_stable_key text;

INSERT INTO sofia_entity_registry (
  entity_type,
  stable_key,
  display_name,
  source_table,
  source_id,
  approved_facts,
  runtime_aliases,
  source_refs,
  sensitive,
  review_status,
  capabilities
) VALUES
(
  'offer',
  'OFR_EDU_CICLO_AGUA_PRESENCIAL',
  'Ciclo Água Presencial',
  'official_documents',
  1,
  '{
    "name": "Ciclo Água Presencial",
    "description": "Ciclo presencial da trilha Education, também identificado como Sound Healing Individual.",
    "modality": "presencial",
    "prerequisites": "Sem pré-requisito de entrada.",
    "status": "active"
  }'::jsonb,
  '["Ciclo Água", "Água Presencial", "Sound Healing Individual"]'::jsonb,
  '[
    {
      "type": "controlled_document",
      "sourceType": "document",
      "ref": "Biblioteca Unificada de Ofertas",
      "url": "attached_assets/03_-_Biblioteca_Unificada_de_Ofertas_v1.1_-_CANDIDATA_1789472929153.md",
      "checkedAt": "2026-09-15T12:00:00.000Z",
      "version": "1.1",
      "status": "candidate",
      "ingestedContentSha256": "105708960da05e8f82c578538da5ca5d3ca4942c189489a847452da522761122",
      "manifestRef": "attached_assets/MANIFESTO_SHA256_TERCEIRA_ENTREGA_v3.0_1789474142886.md",
      "manifestLinkageStatus": "unavailable_in_summary"
    },
    {
      "type": "controlled_document",
      "sourceType": "document",
      "ref": "15A Education - Matriz Comercial Cognitiva",
      "url": "attached_assets/15A-Education_-_Matriz_Comercial_Cognitiva_v1.2_-_CANDIDATA_1789472929156.md",
      "checkedAt": "2026-09-15T12:00:00.000Z",
      "version": "1.2",
      "status": "candidate",
      "ingestedContentSha256": "e7dd0b80d92cb5549d8dac79e9338e152fbc30bb311899b05d4a0d8476b044dc",
      "manifestRef": "attached_assets/MANIFESTO_SHA256_TERCEIRA_ENTREGA_v3.0_1789474142886.md",
      "manifestLinkageStatus": "unavailable_in_summary"
    }
  ]'::jsonb,
  false,
  'approved',
  '{"informPrice":false,"sendCheckout":false,"checkAvailability":false,"sendCheckoutLink":false}'::jsonb
),
(
  'offer',
  'OFR_EDU_CICLO_FOGO_PRESENCIAL',
  'Ciclo Fogo Presencial',
  'official_documents',
  2,
  '{
    "name": "Ciclo Fogo Presencial",
    "description": "Ciclo presencial da trilha Education.",
    "modality": "presencial",
    "prerequisites": "Sem pré-requisito de entrada.",
    "status": "active"
  }'::jsonb,
  '["Ciclo Fogo", "Fogo Presencial"]'::jsonb,
  '[
    {
      "type": "controlled_document",
      "sourceType": "document",
      "ref": "Biblioteca Unificada de Ofertas",
      "url": "attached_assets/03_-_Biblioteca_Unificada_de_Ofertas_v1.1_-_CANDIDATA_1789472929153.md",
      "checkedAt": "2026-09-15T12:00:00.000Z",
      "version": "1.1",
      "status": "candidate",
      "ingestedContentSha256": "105708960da05e8f82c578538da5ca5d3ca4942c189489a847452da522761122",
      "manifestRef": "attached_assets/MANIFESTO_SHA256_TERCEIRA_ENTREGA_v3.0_1789474142886.md",
      "manifestLinkageStatus": "unavailable_in_summary"
    },
    {
      "type": "controlled_document",
      "sourceType": "document",
      "ref": "15A Education - Matriz Comercial Cognitiva",
      "url": "attached_assets/15A-Education_-_Matriz_Comercial_Cognitiva_v1.2_-_CANDIDATA_1789472929156.md",
      "checkedAt": "2026-09-15T12:00:00.000Z",
      "version": "1.2",
      "status": "candidate",
      "ingestedContentSha256": "e7dd0b80d92cb5549d8dac79e9338e152fbc30bb311899b05d4a0d8476b044dc",
      "manifestRef": "attached_assets/MANIFESTO_SHA256_TERCEIRA_ENTREGA_v3.0_1789474142886.md",
      "manifestLinkageStatus": "unavailable_in_summary"
    }
  ]'::jsonb,
  false,
  'approved',
  '{"informPrice":false,"sendCheckout":false,"checkAvailability":false,"sendCheckoutLink":false}'::jsonb
)
ON CONFLICT (stable_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  source_table = EXCLUDED.source_table,
  source_id = EXCLUDED.source_id,
  approved_facts = EXCLUDED.approved_facts,
  runtime_aliases = EXCLUDED.runtime_aliases,
  source_refs = EXCLUDED.source_refs,
  sensitive = EXCLUDED.sensitive,
  capabilities = EXCLUDED.capabilities,
  updated_at = now();

UPDATE sofia_entity_registry
SET superseded_by_stable_key = 'OFR_EDU_CICLO_AGUA_PRESENCIAL',
    updated_at = now()
WHERE source_table = 'cursos_inscricao'
  AND source_id IN (3, 11)
  AND stable_key <> 'OFR_EDU_CICLO_AGUA_PRESENCIAL';

UPDATE sofia_entity_registry
SET superseded_by_stable_key = 'OFR_EDU_CICLO_FOGO_PRESENCIAL',
    updated_at = now()
WHERE source_table = 'cursos_inscricao'
  AND source_id IN (5, 13)
  AND stable_key <> 'OFR_EDU_CICLO_FOGO_PRESENCIAL';

COMMIT;