-- Migration 013: cada turma passa a ter o seu próprio link de inscrição.
--
-- Até aqui um link de inscrição apontava no máximo para um `course` (o curso
-- do catálogo), então todas as turmas de um mesmo curso compartilhavam o
-- mesmo formulário e não dava para saber para qual turma a pessoa se
-- inscreveu. Agora o link aponta para a turma (`class_id`), herdando dela o
-- local e as datas; `course_id` continua preenchido para não quebrar o que
-- já lia por curso.
--
-- `class_id` é nullable de propósito: links avulsos (sem turma) continuam
-- válidos. O índice único é parcial para permitir vários links sem turma,
-- mas no máximo um link por turma.
--
-- Idempotente.

ALTER TABLE cursos_inscricao
  ADD COLUMN IF NOT EXISTS class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cursos_inscricao_class_id_unique
  ON cursos_inscricao (class_id)
  WHERE class_id IS NOT NULL;

-- Backfill: gera o link das turmas que ainda não têm um.
-- Slug derivado do código da turma (FBS-JUL-2026 -> fbs-jul-2026), que é
-- estável e legível. Turmas cujo slug já esteja ocupado são ignoradas aqui e
-- ganham o link pela aplicação, que sabe desambiguar.
INSERT INTO cursos_inscricao (slug, nome, local, data_inicio, data_fim, course_id, class_id, ativo)
SELECT
  btrim(regexp_replace(lower(cl.code), '[^a-z0-9]+', '-', 'g'), '-'),
  co.name || ' — ' || cl.code,
  cl.location,
  cl.start_date,
  cl.end_date,
  cl.course_id,
  cl.id,
  true
FROM classes cl
JOIN courses co ON co.id = cl.course_id
WHERE NOT EXISTS (SELECT 1 FROM cursos_inscricao ci WHERE ci.class_id = cl.id)
ON CONFLICT (slug) DO NOTHING;
