import { describe, expect, it } from "vitest";
import type { AirtableRecordLike } from "./airtableNovosClientesRules";
import {
  buildClassIndex,
  classMatchKey,
  exactDate,
  mapEventoRecord,
  mapInscricaoRecord,
  planEnrollments,
  type ClassLink,
  type ClassRow,
} from "./airtableNovosClientesMatriculasRules";

function record(id: string, fields: Record<string, unknown>): AirtableRecordLike {
  return { id, fields };
}

function evento(id: string, overrides: Record<string, unknown> = {}): AirtableRecordLike {
  return record(id, {
    Nome: "Formação Sound Healing",
    Curso: "Formação",
    "Turma TAG": "SH-01",
    "Local do evento": "São Paulo",
    "Data início": "2026-03-10",
    "Data fim": "2026-03-12",
    ...overrides,
  });
}

function turma(id: number, overrides: Partial<ClassRow> = {}): ClassRow {
  return {
    id, code: "SH-01", location: "São Paulo", startDate: "2026-03-10", endDate: "2026-03-12",
    courseName: "Formação", name: "Formação Sound Healing", ...overrides,
  };
}

function inscricao(id: string, person: string | string[], eventId: string | string[] | null, extra: Record<string, unknown> = {}) {
  return record(id, {
    "Nome Inscrito": Array.isArray(person) ? person : [person],
    ...(eventId === null ? {} : { "Inscrito para": Array.isArray(eventId) ? eventId : [eventId] }),
    ...extra,
  });
}

function plan(options: {
  inscricoes: AirtableRecordLike[];
  eventos?: AirtableRecordLike[];
  classes?: ClassRow[];
  links?: ClassLink[];
  newPeople?: string[];
  linkedInscricoes?: string[];
}) {
  return planEnrollments({
    inscricoes: options.inscricoes,
    eventos: options.eventos ?? [evento("recEvA")],
    newPersonRecordIds: new Set(options.newPeople ?? ["recP"]),
    classes: buildClassIndex(options.classes ?? [turma(10)], options.links ?? []),
    alreadyLinkedInscricaoIds: new Set(options.linkedInscricoes ?? []),
  });
}

describe("leitura dos campos do Airtable", () => {
  it("só aceita data com o dia completo", () => {
    expect(exactDate("2026-03-10")).toBe("2026-03-10");
    expect(exactDate("2026-03-10T09:00:00.000Z")).toBe("2026-03-10");
    expect(exactDate("2026-03")).toBeNull();
    expect(exactDate("2026-02-31")).toBeNull();
    expect(exactDate(null)).toBeNull();
  });

  it("evento sem nome não é turma candidata", () => {
    expect(mapEventoRecord(record("recEvX", { "Turma TAG": "X" }))).toBeNull();
    expect(mapEventoRecord(evento("recEvA"))).toMatchObject({ code: "SH-01", startDate: "2026-03-10", location: "São Paulo" });
  });

  it("contrato só é assinado quando o campo é verdadeiro", () => {
    expect(mapInscricaoRecord(inscricao("i1", "recP", "recEvA", { "Contrato Assinado": true })).contractStatus).toBe("Assinado");
    expect(mapInscricaoRecord(inscricao("i2", "recP", "recEvA", { "Contrato Assinado": false })).contractStatus).toBe("pending");
    expect(mapInscricaoRecord(inscricao("i3", "recP", "recEvA")).contractStatus).toBe("pending");
    expect(mapInscricaoRecord(inscricao("i4", "recP", "recEvA", { "Contrato Assinado": "Sim" })).contractStatus).toBe("pending");
  });

  it("a chave da turma ignora acentos, caixa e espaços", () => {
    const a = classMatchKey({ courseName: "Formação", code: "SH-01", name: "X", location: "São Paulo", startDate: "2026-03-10", endDate: null });
    const b = classMatchKey({ courseName: "formacao", code: "sh 01", name: "x", location: "SAO PAULO", startDate: "2026-03-10", endDate: null });
    expect(a).toBe(b);
    expect(classMatchKey({ courseName: "Formação", code: "SH-01", name: "X", location: "São Paulo", startDate: "2026-03-11", endDate: null })).not.toBe(a);
  });
});

describe("matrícula de cliente novo em turma existente", () => {
  it("liga a inscrição à turma pela chave curso + código + nome + local + datas", () => {
    const result = plan({ inscricoes: [inscricao("i1", "recP", "recEvA")] });
    expect(result.enrollments).toEqual([
      { sourceRecordId: "i1", personRecordId: "recP", eventRecordId: "recEvA", classId: 10, contractStatus: "pending" },
    ]);
    expect(result.totals).toEqual({
      sourceRecords: 1,
      eventRecords: 1,
      forNewClients: 1,
      toCreate: 1,
      clientsWithEnrollment: 1,
      review: { total: 0, byReason: { turma_ausente: 0, turma_ambigua: 0, duplicada: 0, pessoa_ambigua: 0 } },
    });
  });

  it("o vínculo durável do evento decide a turma, mesmo que a chave tenha mudado", () => {
    const result = plan({
      inscricoes: [inscricao("i1", "recP", "recEvA")],
      classes: [turma(10, { code: "OUTRO" }), turma(11, { code: "OUTRO-2" })],
      links: [{ eventRecordId: "recEvA", classId: 11 }],
    });
    expect(result.enrollments[0]?.classId).toBe(11);
  });

  it("vínculo para uma turma que não existe mais não cria nada", () => {
    const result = plan({
      inscricoes: [inscricao("i1", "recP", "recEvA")],
      links: [{ eventRecordId: "recEvA", classId: 999 }],
    });
    expect(result.totals.toCreate).toBe(0);
    expect(result.totals.review.byReason.turma_ausente).toBe(1);
  });

  it("só considera inscrições de clientes que a carga cria", () => {
    const result = plan({
      inscricoes: [inscricao("i1", "recP", "recEvA"), inscricao("i2", "recExistente", "recEvA")],
    });
    expect(result.totals).toMatchObject({ sourceRecords: 2, forNewClients: 1, toCreate: 1 });
    expect(result.enrollments.map((item) => item.sourceRecordId)).toEqual(["i1"]);
  });

  it("conta clientes distintos com matrícula", () => {
    const result = plan({
      inscricoes: [inscricao("i1", "recP", "recEvA"), inscricao("i2", "recQ", "recEvA"), inscricao("i3", "recQ", "recEvB")],
      eventos: [evento("recEvA"), evento("recEvB", { "Turma TAG": "SH-02" })],
      classes: [turma(10), turma(11, { code: "SH-02" })],
      newPeople: ["recP", "recQ"],
    });
    expect(result.totals).toMatchObject({ toCreate: 3, clientsWithEnrollment: 2 });
  });

  it("sem vínculo no campo, usa o código do evento e depois o nome, só quando é único", () => {
    const byCode = plan({ inscricoes: [inscricao("i1", "recP", null, { "Código do Evento": "SH-01" })] });
    expect(byCode.enrollments).toHaveLength(1);

    const byName = plan({ inscricoes: [record("i2", { "Nome Inscrito": ["recP"], "Inscrito para": "Formação Sound Healing" })] });
    expect(byName.enrollments).toHaveLength(1);

    const ambiguousCode = plan({
      inscricoes: [inscricao("i3", "recP", null, { "Código do Evento": "SH-01" })],
      eventos: [evento("recEvA"), evento("recEvB", { "Data início": "2026-04-10" })],
    });
    expect(ambiguousCode.totals.review.byReason.turma_ambigua).toBe(1);
    expect(ambiguousCode.totals.toCreate).toBe(0);
  });
});

describe("o que fica para revisão sem criar nada", () => {
  it("turma ausente: evento sem turma correspondente no SoundOS, evento desconhecido ou inscrição sem evento", () => {
    const result = plan({
      inscricoes: [
        inscricao("i1", "recP", "recEvA"),
        inscricao("i2", "recP", "recEvDesconhecido"),
        inscricao("i3", "recP", null),
      ],
      classes: [turma(10, { code: "OUTRA" })],
      newPeople: ["recP"],
    });
    expect(result.enrollments).toEqual([]);
    expect(result.totals.review).toEqual({
      total: 3, byReason: { turma_ausente: 3, turma_ambigua: 0, duplicada: 0, pessoa_ambigua: 0 },
    });
  });

  it("turma ambígua: duas turmas com a mesma chave, dois eventos com a mesma chave ou dois eventos na inscrição", () => {
    const duasTurmas = plan({ inscricoes: [inscricao("i1", "recP", "recEvA")], classes: [turma(10), turma(11)] });
    expect(duasTurmas.totals.review.byReason.turma_ambigua).toBe(1);

    const doisEventos = plan({
      inscricoes: [inscricao("i2", "recP", "recEvA")],
      eventos: [evento("recEvA"), evento("recEvB")],
    });
    expect(doisEventos.totals.review.byReason.turma_ambigua).toBe(1);

    const doisNaInscricao = plan({
      inscricoes: [inscricao("i3", "recP", ["recEvA", "recEvB"])],
      eventos: [evento("recEvA"), evento("recEvB", { "Turma TAG": "SH-02" })],
      classes: [turma(10), turma(11, { code: "SH-02" })],
    });
    expect(doisNaInscricao.totals.review.byReason.turma_ambigua).toBe(1);
    expect(doisNaInscricao.totals.toCreate).toBe(0);
  });

  it("a mesma turma duas vezes para a mesma pessoa: nenhuma das linhas é criada", () => {
    const result = plan({ inscricoes: [inscricao("i1", "recP", "recEvA"), inscricao("i2", "recP", "recEvA")] });
    expect(result.totals.toCreate).toBe(0);
    expect(result.totals.review.byReason.duplicada).toBe(2);
  });

  it("dois eventos do Airtable que apontam para a mesma turma também contam como duplicada", () => {
    const result = plan({
      inscricoes: [inscricao("i1", "recP", "recEvA"), inscricao("i2", "recP", "recEvB")],
      eventos: [evento("recEvA"), evento("recEvB")],
      links: [{ eventRecordId: "recEvA", classId: 10 }, { eventRecordId: "recEvB", classId: 10 }],
    });
    expect(result.totals.toCreate).toBe(0);
    expect(result.totals.review.byReason.duplicada).toBe(2);
  });

  it("inscrição que já tem matrícula ligada por uma carga anterior não é repetida", () => {
    const result = plan({ inscricoes: [inscricao("i1", "recP", "recEvA")], linkedInscricoes: ["i1"] });
    expect(result.totals.toCreate).toBe(0);
    expect(result.totals.review.byReason.duplicada).toBe(1);
  });

  it("inscrição ligada a mais de uma pessoa vai para revisão", () => {
    const result = plan({ inscricoes: [inscricao("i1", ["recP", "recQ"], "recEvA")] });
    expect(result.totals.toCreate).toBe(0);
    expect(result.totals.review.byReason.pessoa_ambigua).toBe(1);
  });

  it("os totais não carregam nomes nem contatos", () => {
    const result = plan({
      inscricoes: [inscricao("i1", "recP", "recEvA", { "Nome do aluno": "Maria Souza", Email: "maria@example.com" })],
    });
    expect(JSON.stringify(result.totals)).not.toMatch(/Maria|@|Souza/);
  });
});
