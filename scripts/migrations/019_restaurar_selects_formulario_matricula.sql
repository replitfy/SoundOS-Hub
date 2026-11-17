-- Restore the select fields and exact choices from the legacy enrollment form.
-- Existing customized forms receive a new immutable version; unrelated fields,
-- order, required/active state, and custom fields are preserved.
CREATE OR REPLACE FUNCTION aplicar_selects_formulario_matricula(campos JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(jsonb_agg(
    CASE item->>'key'
      WHEN 'sexo' THEN item || jsonb_build_object(
        'label', 'Sexo', 'type', 'select',
        'options', jsonb_build_array('Feminino','Masculino','Prefiro não informar'))
      WHEN 'comoFicouSabendo' THEN item || jsonb_build_object(
        'label', 'Mídia de acesso', 'type', 'select',
        'options', jsonb_build_array('Facebook','Whatsapp','Instagram','Website','Youtube','Google','Amigo / Indicação','Outros'))
      WHEN 'conectadoProposito' THEN item || jsonb_build_object(
        'label', 'Você se sente conectado(a) ao seu propósito de vida?', 'type', 'select',
        'options', jsonb_build_array('Totalmente conectado','Em busca de sentido','Começando a despertar','Ainda não percebi'))
      WHEN 'lugarMusicaSom' THEN item || jsonb_build_object(
        'label', 'Qual é o lugar da música e do som na sua vida?', 'type', 'select',
        'options', jsonb_build_array('Central — música é minha vocação','Terapêutica — me cura e conecta','Recreativa — prazer e lazer','Espiritual — ferramenta de transcendência','Periférica — não é prioridade'))
      WHEN 'participouTrabalhoSom' THEN item || jsonb_build_object(
        'label', 'Já participou de trabalho com som ou terapia com sons?', 'type', 'select',
        'options', jsonb_build_array('Sim','Não'))
      WHEN 'outroCurso' THEN item || jsonb_build_object(
        'label', 'Realizou algum curso de Sound Healing?', 'type', 'select',
        'options', jsonb_build_array('Sim','Não'))
      WHEN 'terapeuta' THEN item || jsonb_build_object(
        'label', 'Você é terapeuta?', 'type', 'select',
        'options', jsonb_build_array('Sim','Não'))
      WHEN 'objetivoCurso' THEN item || jsonb_build_object(
        'label', 'Seu principal objetivo no curso', 'type', 'select',
        'options', jsonb_build_array('Desenvolvimento pessoal','Formação profissional como terapeuta','Aprofundar prática espiritual','Expandir conhecimento musical'))
      ELSE item
    END
    ORDER BY ordinalidade
  ), '[]'::jsonb)
  FROM jsonb_array_elements(campos) WITH ORDINALITY AS elementos(item, ordinalidade);
$$;

WITH latest AS (
  SELECT DISTINCT ON (v.formulario_id)
    v.formulario_id,
    v.numero,
    v.campos
  FROM evento_formulario_versoes v
  JOIN evento_formularios f ON f.id = v.formulario_id
  WHERE f.tipo = 'COMPLETO'
  ORDER BY v.formulario_id, v.numero DESC
),
changed AS (
  SELECT
    formulario_id,
    numero + 1 AS numero,
    aplicar_selects_formulario_matricula(campos) AS campos
  FROM latest
  WHERE aplicar_selects_formulario_matricula(campos) IS DISTINCT FROM campos
)
INSERT INTO evento_formulario_versoes(formulario_id, numero, campos)
SELECT formulario_id, numero, campos
FROM changed
ON CONFLICT (formulario_id, numero) DO NOTHING;

-- The trigger from migration 018 creates the initial form/version. This second
-- trigger runs afterwards and updates only that newly-created complete version.
CREATE OR REPLACE FUNCTION restaurar_selects_novo_evento()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE evento_formulario_versoes v
  SET campos = aplicar_selects_formulario_matricula(v.campos)
  FROM evento_formularios f
  WHERE f.id = v.formulario_id
    AND f.evento_id = NEW.id
    AND f.tipo = 'COMPLETO';
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS zz_cursos_inscricao_selects_trigger ON cursos_inscricao;
CREATE TRIGGER zz_cursos_inscricao_selects_trigger
AFTER INSERT ON cursos_inscricao
FOR EACH ROW EXECUTE FUNCTION restaurar_selects_novo_evento();