import { sql } from "drizzle-orm";

export const eventEnrolleeCountSql = sql<number>`(
  SELECT count(*)::int
  FROM (
    SELECT e.pessoa_id
    FROM enrollments e
    WHERE cursos_inscricao.class_id IS NOT NULL
      AND e.class_id = cursos_inscricao.class_id
    UNION
    SELECT ps.pessoa_id
    FROM pessoa_servicos ps
    WHERE (
      ps.cursos_inscricao_id = cursos_inscricao.id
      OR (
        ps.cursos_inscricao_id IS NULL
        AND ps.servico_nome = cursos_inscricao.nome
      )
    )
      AND ps.obs = 'Inscrição via formulário público'
  ) event_enrollees
)`;

export type EventEnrollee = {
  pessoaId: number;
  nome: string;
  sobrenome: string | null;
  email: string | null;
  celular: string | null;
  inscritoEm: Date;
};

export function mergeDistinctEventEnrollees(
  publicFormRows: EventEnrollee[],
  enrollmentRows: EventEnrollee[],
): EventEnrollee[] {
  const byPessoaId = new Map<number, EventEnrollee>();

  for (const row of publicFormRows) byPessoaId.set(row.pessoaId, row);
  for (const row of enrollmentRows) byPessoaId.set(row.pessoaId, row);

  return [...byPessoaId.values()].sort(
    (a, b) => b.inscritoEm.getTime() - a.inscritoEm.getTime(),
  );
}
