-- Migration 014: matrículas passam a apontar para `pessoas`, não para `students`.
--
-- O módulo Education mantinha a sua própria tabela `students`, desconectada do
-- CRM (`pessoas`). A mesma pessoa podia existir nos dois lugares sem nenhuma
-- ligação, e o menu Alunos mostrava um universo paralelo ao do CRM.
--
-- Esta migração cria uma pessoa para cada aluno existente (reaproveitando a
-- pessoa já cadastrada quando o e-mail bate), reaponta as matrículas e remove
-- a tabela `students`. Nenhuma matrícula é perdida.
--
-- Idempotente até o ponto do DROP: rodar de novo depois disso é no-op porque
-- `students` já não existe.

ALTER TABLE enrollments
  ADD COLUMN IF NOT EXISTS pessoa_id INTEGER;

DO $$
BEGIN
  -- Só executa o backfill enquanto a tabela antiga existir.
  IF to_regclass('public.students') IS NULL THEN
    RETURN;
  END IF;

  -- 1. Aluno cujo e-mail já existe no CRM: reaproveita a pessoa, não duplica.
  UPDATE enrollments e
  SET pessoa_id = p.id
  FROM students s
  JOIN pessoas p ON lower(p.email) = lower(s.email)
  WHERE e.student_id = s.id AND e.pessoa_id IS NULL;

  -- 1b. Trava: o reaproveitamento e a deduplicação são feitos por e-mail, então
  --     um aluno sem e-mail não teria como ser casado com uma pessoa. Aborta
  --     antes de qualquer escrita destrutiva em vez de perdê-lo no DROP.
  IF EXISTS (SELECT 1 FROM students WHERE email IS NULL OR btrim(email) = '') THEN
    RAISE EXCEPTION 'Existem alunos sem e-mail em `students`. Preencha o e-mail deles antes de rodar esta migração; nada foi removido.';
  END IF;

  -- 2. Demais alunos viram pessoas novas, preservando data de cadastro.
  --    Inclui alunos SEM matrícula: a tabela `students` é destruída no fim, e
  --    perder um cadastro só porque ele ainda não tinha turma seria perda de
  --    dado silenciosa.
  --    DISTINCT ON garante uma pessoa por e-mail quando dois alunos repetem o
  --    mesmo e-mail — as matrículas de ambos convergem para a mesma pessoa.
  WITH faltantes AS (
    SELECT DISTINCT ON (lower(s.email)) s.*
    FROM students s
    WHERE NOT EXISTS (
      SELECT 1 FROM pessoas p WHERE lower(p.email) = lower(s.email)
    )
    ORDER BY lower(s.email), s.id
  ),
  base AS (
    SELECT COALESCE(MAX(NULLIF(regexp_replace(codigo, '\D', '', 'g'), ''))::bigint, 0) AS ultimo
    FROM pessoas
    WHERE codigo ~ '^PS-'
  ),
  novos AS (
    SELECT
      f.*,
      'PS-' || lpad(((SELECT ultimo FROM base) + row_number() OVER (ORDER BY f.id))::text, 6, '0') AS novo_codigo
    FROM faltantes f
  ),
  inseridos AS (
    INSERT INTO pessoas (
      codigo, nome, sobrenome, email, celular, celular_normalizado,
      cpf, como_ficou_sabendo, created_at, updated_at
    )
    SELECT
      n.novo_codigo,
      split_part(n.name, ' ', 1),
      NULLIF(substr(n.name, strpos(n.name, ' ') + 1), n.name),
      lower(n.email),
      n.phone,
      NULLIF(regexp_replace(COALESCE(n.phone, ''), '\D', '', 'g'), ''),
      n.cpf,
      n.origin,
      n.created_at,
      now()
    FROM novos n
    RETURNING id, lower(email) AS email
  )
  UPDATE enrollments e
  SET pessoa_id = i.id
  FROM students s
  JOIN inseridos i ON i.email = lower(s.email)
  WHERE e.student_id = s.id AND e.pessoa_id IS NULL;

  -- 3. Travas de segurança: aborta antes de destruir nada se sobrou matrícula
  --    sem pessoa, ou se algum aluno não tem pessoa correspondente.
  IF EXISTS (SELECT 1 FROM enrollments WHERE pessoa_id IS NULL) THEN
    RAISE EXCEPTION 'Backfill incompleto: existem matrículas sem pessoa_id. Nada foi removido.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM students s
    WHERE NOT EXISTS (SELECT 1 FROM pessoas p WHERE lower(p.email) = lower(s.email))
  ) THEN
    RAISE EXCEPTION 'Backfill incompleto: existem alunos sem pessoa correspondente. Nada foi removido.';
  END IF;

  ALTER TABLE enrollments ALTER COLUMN pessoa_id SET NOT NULL;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_enrollments_pessoa_id') THEN
    ALTER TABLE enrollments ADD CONSTRAINT fk_enrollments_pessoa_id
      FOREIGN KEY (pessoa_id) REFERENCES pessoas(id) ON DELETE RESTRICT;
  END IF;

  ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS fk_enrollments_student_id;
  ALTER TABLE enrollments DROP COLUMN IF EXISTS student_id;
  DROP TABLE students;
END
$$;
