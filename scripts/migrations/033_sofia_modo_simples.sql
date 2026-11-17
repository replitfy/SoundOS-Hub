-- Sofia modo simples: flag de modo, aliases de eventos, vínculo vídeo ↔ evento
-- e idade declarada. Tudo idempotente; não apaga nem reescreve dado existente.

-- 1) Flag de modo. A env SOFIA_MODE, quando definida, vence esta coluna.
-- O modo simples é o padrão (decisão do dono em 2026-10-06).
ALTER TABLE conduta_config
  ADD COLUMN IF NOT EXISTS sofia_mode text NOT NULL DEFAULT 'simple';
ALTER TABLE conduta_config ALTER COLUMN sofia_mode SET DEFAULT 'simple';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conduta_config_sofia_mode_check'
  ) THEN
    ALTER TABLE conduta_config
      ADD CONSTRAINT conduta_config_sofia_mode_check CHECK (sofia_mode IN ('legacy', 'simple'));
  END IF;
END $$;

-- 2) Aliases de eventos. O código já traz a mesma lista como padrão (a produção
-- não recebe seeds pelo Publish); linhas desta tabela acrescentam ou corrigem,
-- e ativo=false desliga um alias padrão.
CREATE TABLE IF NOT EXISTS sofia_event_aliases (
  id serial PRIMARY KEY,
  alias text NOT NULL UNIQUE,
  evento_chave text NOT NULL,
  nome_like text,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO sofia_event_aliases (alias, evento_chave, nome_like) VALUES
  ('workshop agua', 'ciclo-agua', 'ciclo agua'),
  ('formacao agua', 'ciclo-agua', 'ciclo agua'),
  ('agua', 'ciclo-agua', 'ciclo agua'),
  ('sound healing individual', 'ciclo-agua', 'ciclo agua'),
  ('fogo', 'ciclo-fogo', 'ciclo fogo'),
  ('ritual de som', 'ciclo-fogo', 'ciclo fogo'),
  ('terra', 'ciclo-terra', 'ciclo terra'),
  ('sound healing avancado', 'ciclo-terra', 'ciclo terra'),
  ('ar', 'ciclo-ar', 'ciclo ar'),
  ('retiro ciclo ar', 'ciclo-ar', 'ciclo ar'),
  ('arte cerimonial', 'ciclo-ar', 'ciclo ar'),
  ('concerto', 'concerto-meditativo', 'concerto meditativo'),
  ('banho de gongs', 'concerto-meditativo', 'concerto meditativo'),
  ('cacau', 'concerto-meditativo', 'concerto meditativo')
ON CONFLICT (alias) DO NOTHING;

-- 3) Vínculo vídeo ↔ evento. Semeado só com vídeos aprovados e com link real;
-- nenhum é marcado como principal (escolha do dono).
CREATE TABLE IF NOT EXISTS video_eventos (
  video_id integer NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  evento_chave text NOT NULL,
  principal boolean NOT NULL DEFAULT false,
  ordem integer NOT NULL DEFAULT 0,
  PRIMARY KEY (video_id, evento_chave)
);

INSERT INTO video_eventos (video_id, evento_chave)
SELECT v.id,
       CASE TRANSLATE(LOWER(TRIM(v.curso)), 'áàâãéêíóôõúç', 'aaaaeeiooouc')
         WHEN 'agua' THEN 'ciclo-agua'
         WHEN 'fogo' THEN 'ciclo-fogo'
         WHEN 'terra' THEN 'ciclo-terra'
       END
FROM videos v
WHERE v.aprovado_para_sofia = true
  AND v.tem_link_real = true
  AND v.link IS NOT NULL
  AND TRANSLATE(LOWER(TRIM(v.curso)), 'áàâãéêíóôõúç', 'aaaaeeiooouc') IN ('agua', 'fogo', 'terra')
ON CONFLICT (video_id, evento_chave) DO NOTHING;

-- 4) Idade declarada. Nunca derivar data_nascimento de uma idade.
ALTER TABLE pessoas ADD COLUMN IF NOT EXISTS idade_declarada integer;
ALTER TABLE pessoas ADD COLUMN IF NOT EXISTS idade_declarada_em date;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pessoas_idade_declarada_check'
  ) THEN
    ALTER TABLE pessoas
      ADD CONSTRAINT pessoas_idade_declarada_check CHECK (idade_declarada BETWEEN 0 AND 120);
  END IF;
END $$;
