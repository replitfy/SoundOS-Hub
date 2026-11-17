-- Configurable, versioned forms and idempotent event pre-registrations.
CREATE TABLE IF NOT EXISTS evento_formularios (
  id SERIAL PRIMARY KEY,
  evento_id INTEGER NOT NULL REFERENCES cursos_inscricao(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('INTERESSE','COMPLETO')),
  slug TEXT NOT NULL UNIQUE,
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS evento_formularios_evento_tipo_unique ON evento_formularios(evento_id,tipo);
CREATE TABLE IF NOT EXISTS evento_formulario_versoes (
  id SERIAL PRIMARY KEY,
  formulario_id INTEGER NOT NULL REFERENCES evento_formularios(id) ON DELETE CASCADE,
  numero INTEGER NOT NULL,
  campos JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(formulario_id,numero)
);
CREATE TABLE IF NOT EXISTS evento_formulario_submissoes (
  id SERIAL PRIMARY KEY,
  evento_id INTEGER NOT NULL REFERENCES cursos_inscricao(id) ON DELETE CASCADE,
  formulario_id INTEGER NOT NULL REFERENCES evento_formularios(id) ON DELETE CASCADE,
  versao_id INTEGER NOT NULL REFERENCES evento_formulario_versoes(id),
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id),
  respostas JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS evento_preinscricoes (
  id SERIAL PRIMARY KEY,
  evento_id INTEGER NOT NULL REFERENCES cursos_inscricao(id) ON DELETE CASCADE,
  pessoa_id INTEGER NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  ultima_submissao_id INTEGER REFERENCES evento_formulario_submissoes(id),
  status TEXT NOT NULL DEFAULT 'PREINSCRITO',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(evento_id,pessoa_id)
);
-- Existing events receive both forms and an initial version.
INSERT INTO evento_formularios(evento_id,tipo,slug)
SELECT id, t.tipo, slug || '-' || lower(t.tipo)
FROM cursos_inscricao CROSS JOIN (VALUES ('INTERESSE'),('COMPLETO')) t(tipo)
ON CONFLICT (evento_id,tipo) DO NOTHING;
INSERT INTO evento_formulario_versoes(formulario_id,numero,campos)
SELECT f.id, 1,
 CASE WHEN f.tipo='INTERESSE' THEN
 '[{"key":"nome","label":"Nome","type":"text","required":true},{"key":"celular","label":"Celular","type":"tel","required":true},{"key":"instagram","label":"Instagram","type":"text","required":true},{"key":"email","label":"E-mail","type":"email","required":true}]'::jsonb
 ELSE '[{"key":"nome","label":"Nome","type":"text","required":true},{"key":"celular","label":"Celular","type":"tel","required":true},{"key":"email","label":"E-mail","type":"email","required":true},{"key":"sobrenome","label":"Sobrenome","type":"text","required":true},{"key":"profissao","label":"Profissão","type":"text","required":true},{"key":"sexo","label":"Sexo","type":"text","required":true},{"key":"dataNascimento","label":"Data de nascimento","type":"date","required":true},{"key":"cpf","label":"cpf","type":"text","required":false},{"key":"enderecoRua","label":"Endereço","type":"text","required":false},{"key":"cidade","label":"cidade","type":"text","required":false},{"key":"estadoUf","label":"Estado","type":"text","required":false},{"key":"cep","label":"cep","type":"text","required":false},{"key":"comoFicouSabendo","label":"Como ficou sabendo","type":"text","required":false},{"key":"qualAmigoParceiro","label":"Qual amigo ou parceiro","type":"text","required":false},{"key":"conectadoProposito","label":"Conexão com o propósito","type":"text","required":false},{"key":"lugarMusicaSom","label":"Lugar da música e do som","type":"text","required":false},{"key":"participouTrabalhoSom","label":"Participou de trabalho com som","type":"text","required":false},{"key":"qualTrabalhoSom","label":"Qual trabalho com som","type":"text","required":false},{"key":"buscaEspiritual","label":"Busca espiritual","type":"text","required":false},{"key":"formacaoMusicaTerapia","label":"Formação em música e terapia","type":"text","required":false},{"key":"outroCurso","label":"Outro curso","type":"text","required":false},{"key":"terapeuta","label":"É terapeuta","type":"text","required":false},{"key":"objetivoCurso","label":"Objetivo no curso","type":"text","required":false},{"key":"intencaoPrincipal","label":"Intenção principal","type":"text","required":false},{"key":"cursoExpectativas","label":"Expectativas do curso","type":"text","required":false},{"key":"servicoInteresse","label":"Serviço de interesse","type":"text","required":false}]'::jsonb END
FROM evento_formularios f
WHERE NOT EXISTS (SELECT 1 FROM evento_formulario_versoes v WHERE v.formulario_id=f.id);

-- Legacy public registrations predate evento_preinscricoes. Preserve them in
-- the new event record as pre-registrations, deduplicated per person/event.
INSERT INTO evento_preinscricoes(evento_id,pessoa_id,status,created_at,updated_at)
SELECT DISTINCT ON (ci.id, ps.pessoa_id)
  ci.id,
  ps.pessoa_id,
  'PREINSCRITO',
  ps.created_at,
  ps.created_at
FROM cursos_inscricao ci
JOIN pessoa_servicos ps ON (
  ps.cursos_inscricao_id = ci.id
  OR (ps.cursos_inscricao_id IS NULL AND ps.servico_nome = ci.nome)
)
WHERE ps.obs = 'Inscrição via formulário público'
ORDER BY ci.id, ps.pessoa_id, ps.created_at DESC
ON CONFLICT (evento_id,pessoa_id) DO NOTHING;

-- Keep the invariant for events created outside the API as well.
CREATE OR REPLACE FUNCTION criar_formularios_evento() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f RECORD;
BEGIN
  INSERT INTO evento_formularios(evento_id,tipo,slug) VALUES
    (NEW.id,'INTERESSE',NEW.slug || '-interesse'),
    (NEW.id,'COMPLETO',NEW.slug || '-completo')
    ON CONFLICT DO NOTHING;
  FOR f IN SELECT id,tipo FROM evento_formularios WHERE evento_id=NEW.id LOOP
    INSERT INTO evento_formulario_versoes(formulario_id,numero,campos)
    VALUES (f.id,1,CASE WHEN f.tipo='INTERESSE' THEN
      '[{"key":"nome","label":"Nome","type":"text","required":true},{"key":"celular","label":"Celular","type":"tel","required":true},{"key":"instagram","label":"Instagram","type":"text","required":true},{"key":"email","label":"E-mail","type":"email","required":true}]'::jsonb
      ELSE '[{"key":"nome","label":"Nome","type":"text","required":true},{"key":"celular","label":"Celular","type":"tel","required":true},{"key":"email","label":"E-mail","type":"email","required":true},{"key":"sobrenome","label":"Sobrenome","type":"text","required":true},{"key":"profissao","label":"Profissão","type":"text","required":true},{"key":"sexo","label":"Sexo","type":"text","required":true},{"key":"dataNascimento","label":"Data de nascimento","type":"date","required":true},{"key":"cpf","label":"cpf","type":"text","required":false},{"key":"enderecoRua","label":"Endereço","type":"text","required":false},{"key":"cidade","label":"cidade","type":"text","required":false},{"key":"estadoUf","label":"Estado","type":"text","required":false},{"key":"cep","label":"cep","type":"text","required":false},{"key":"comoFicouSabendo","label":"Como ficou sabendo","type":"text","required":false},{"key":"qualAmigoParceiro","label":"Qual amigo ou parceiro","type":"text","required":false},{"key":"conectadoProposito","label":"Conexão com o propósito","type":"text","required":false},{"key":"lugarMusicaSom","label":"Lugar da música e do som","type":"text","required":false},{"key":"participouTrabalhoSom","label":"Participou de trabalho com som","type":"text","required":false},{"key":"qualTrabalhoSom","label":"Qual trabalho com som","type":"text","required":false},{"key":"buscaEspiritual","label":"Busca espiritual","type":"text","required":false},{"key":"formacaoMusicaTerapia","label":"Formação em música e terapia","type":"text","required":false},{"key":"outroCurso","label":"Outro curso","type":"text","required":false},{"key":"terapeuta","label":"É terapeuta","type":"text","required":false},{"key":"objetivoCurso","label":"Objetivo no curso","type":"text","required":false},{"key":"intencaoPrincipal","label":"Intenção principal","type":"text","required":false},{"key":"cursoExpectativas","label":"Expectativas do curso","type":"text","required":false},{"key":"servicoInteresse","label":"Serviço de interesse","type":"text","required":false}]'::jsonb END)
    ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cursos_inscricao_formularios_trigger ON cursos_inscricao;
CREATE TRIGGER cursos_inscricao_formularios_trigger AFTER INSERT ON cursos_inscricao FOR EACH ROW EXECUTE FUNCTION criar_formularios_evento();
