import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  eventEnrolleeCountSql,
  mergeDistinctEventEnrollees,
  type EventEnrollee,
} from "./event-enrollees";

function enrollee(pessoaId: number, inscritoEm: string): EventEnrollee {
  return {
    pessoaId,
    nome: `Pessoa ${pessoaId}`,
    sobrenome: null,
    email: null,
    celular: null,
    inscritoEm: new Date(inscritoEm),
  };
}

describe("mergeDistinctEventEnrollees", () => {
  it("combina inscrições públicas e matrículas sem duplicar a mesma pessoa", () => {
    const result = mergeDistinctEventEnrollees(
      [enrollee(1, "2026-01-01"), enrollee(2, "2026-01-02")],
      [enrollee(2, "2026-02-01"), enrollee(3, "2026-02-02")],
    );

    expect(result.map(row => row.pessoaId)).toEqual([3, 2, 1]);
    expect(result).toHaveLength(3);
    expect(result.find(row => row.pessoaId === 2)?.inscritoEm).toEqual(new Date("2026-02-01"));
  });

  it("mantém as condições de matrícula correlacionadas ao evento", () => {
    const generated = new PgDialect().sqlToQuery(eventEnrolleeCountSql).sql;

    expect(generated).toContain("e.class_id = cursos_inscricao.class_id");
    expect(generated).toContain("ps.cursos_inscricao_id = cursos_inscricao.id");
    expect(generated).not.toContain('"class_id" = "class_id"');
  });
});
