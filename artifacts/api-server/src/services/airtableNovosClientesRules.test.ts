import { describe, expect, it } from "vitest";
import {
  buildExistingIndex,
  creationDigest,
  evidenceField,
  mapClienteRecord,
  minimumExpectedRecords,
  planClientes,
  sourceDigest,
  type AirtableRecordLike,
  type ExistingPessoa,
} from "./airtableNovosClientesRules";

function record(id: string, fields: Record<string, unknown>): AirtableRecordLike {
  return { id, fields };
}

function plan(records: AirtableRecordLike[], existing: ExistingPessoa[] = [], linked: string[] = []) {
  return planClientes(records, buildExistingIndex(existing), new Set(linked));
}

const maria = record("rec1", { Nome: "Maria Souza", Email: "Maria@Example.com", Celular: "+55 11 98765-4321" });

describe("mapeamento do cliente do Airtable", () => {
  it("normaliza e-mail e telefone como o banco guarda (sem o 55)", () => {
    const candidate = mapClienteRecord(maria);
    expect(candidate.email).toBe("maria@example.com");
    expect(candidate.phoneKey).toBe("11987654321");
    expect(candidate.values.nome).toBe("Maria");
    expect(candidate.values.sobrenome).toBe("Souza");
  });

  it("não copia o consentimento do Airtable", () => {
    const candidate = mapClienteRecord(record("rec2", { Nome: "Ana", Email: "ana@example.com", Consentimento: "sim" }));
    expect(Object.keys(candidate.values)).not.toContain("consent_status");
    expect(JSON.stringify(candidate.values)).not.toContain("sim");
  });

  it("descarta telefone curto demais e e-mail inválido", () => {
    const candidate = mapClienteRecord(record("rec3", { Nome: "Ana", Email: "sem-arroba", Celular: "1234" }));
    expect(candidate.email).toBeNull();
    expect(candidate.phoneKey).toBeNull();
    expect(candidate.values.celular).toBeUndefined();
  });
});

describe("quem é cliente novo", () => {
  it("cria quando nem e-mail nem telefone existem", () => {
    const result = plan([maria], [{ id: 1, email: "outra@example.com", celularNormalizado: "21999990000" }]);
    expect(result.totals.toCreate).toBe(1);
    expect(result.creates[0]?.sourceRecordId).toBe("rec1");
  });

  it("ignora quem já existe pelo e-mail, sem diferenciar maiúsculas", () => {
    const result = plan([maria], [{ id: 1, email: " MARIA@example.com ", celularNormalizado: null }]);
    expect(result.totals).toMatchObject({ toCreate: 0, alreadyExist: 1, alreadyExistBy: { email: 1 } });
  });

  it("ignora quem já existe pelo telefone: +55 no Airtable contra número sem 55 no banco", () => {
    const result = plan([maria], [{ id: 1, email: null, celularNormalizado: "11987654321" }]);
    expect(result.totals).toMatchObject({ toCreate: 0, alreadyExist: 1, alreadyExistBy: { phone: 1 } });
  });

  it("ignora quem já existe pelo telefone mesmo escrito de outro jeito no Airtable", () => {
    for (const phone of ["11987654321", "(11) 98765-4321", "5511987654321", "+55 (11) 9 8765-4321"]) {
      const result = plan(
        [record("recX", { Nome: "Maria", Email: "nova@example.com", Celular: phone })],
        [{ id: 1, email: null, celularNormalizado: "11987654321" }],
      );
      expect(result.totals.toCreate, phone).toBe(0);
    }
  });

  it("e-mail e telefone da mesma ficha contam como uma só pessoa existente", () => {
    const result = plan([maria], [{ id: 7, email: "maria@example.com", celularNormalizado: "11987654321" }]);
    expect(result.totals).toMatchObject({ toCreate: 0, alreadyExist: 1, alreadyExistBy: { both: 1 } });
  });

  it("a identidade de fichas arquivadas, inativas ou unidas continua ocupada", () => {
    // O índice recebe todas as fichas; o estado delas não importa para a comparação.
    const existing: ExistingPessoa[] = [
      { id: 1, email: "arquivada@example.com", celularNormalizado: null },
      { id: 2, email: null, celularNormalizado: "21955551111" },
    ];
    const result = plan([
      record("a", { Nome: "A", Email: "arquivada@example.com" }),
      record("b", { Nome: "B", Celular: "21 95555-1111" }),
    ], existing);
    expect(result.totals).toMatchObject({ toCreate: 0, alreadyExist: 2 });
  });

  it("registro já ligado por uma carga anterior é ignorado mesmo que a ficha tenha mudado de contato", () => {
    const result = plan([maria], [], ["rec1"]);
    expect(result.totals).toMatchObject({ toCreate: 0, alreadyExist: 1, alreadyExistBy: { previousLoad: 1 } });
  });
});

describe("casos duvidosos não são criados", () => {
  it("telefone de mais de uma pessoa vai para revisão", () => {
    const result = plan([maria], [
      { id: 1, email: null, celularNormalizado: "11987654321" },
      { id: 2, email: null, celularNormalizado: "11987654321" },
    ]);
    expect(result.totals.toCreate).toBe(0);
    expect(result.totals.review.byReason.ambiguo).toBe(1);
  });

  it("e-mail de uma pessoa e telefone de outra vão para revisão", () => {
    const result = plan([maria], [
      { id: 1, email: "maria@example.com", celularNormalizado: null },
      { id: 2, email: null, celularNormalizado: "11987654321" },
    ]);
    expect(result.totals.review.byReason.contraditorio).toBe(1);
    expect(result.totals.toCreate).toBe(0);
  });

  it("e-mail repetido dentro do Airtable vai para revisão (todos os repetidos)", () => {
    const result = plan([
      record("a", { Nome: "A", Email: "x@example.com" }),
      record("b", { Nome: "B", Email: "X@example.com" }),
    ]);
    expect(result.totals).toMatchObject({ toCreate: 0, review: { total: 2, byReason: { duplicado_no_airtable: 2 } } });
  });

  it("telefone repetido dentro do Airtable vai para revisão mesmo com formatos diferentes", () => {
    const result = plan([
      record("a", { Nome: "A", Celular: "+55 11 98765-4321" }),
      record("b", { Nome: "B", Celular: "11987654321" }),
    ]);
    expect(result.totals.review.byReason.duplicado_no_airtable).toBe(2);
    expect(result.totals.toCreate).toBe(0);
  });

  it("sem nome, ou sem e-mail e telefone, vai para revisão", () => {
    const result = plan([
      record("a", { Email: "so-email@example.com" }),
      record("b", { Nome: "Sem Contato" }),
      record("c", { Nome: "Email Ruim", Email: "ruim" }),
    ]);
    expect(result.totals.review.byReason.dados_insuficientes).toBe(3);
    expect(result.totals.toCreate).toBe(0);
  });

  it("duplicado no Airtable que já existe no SoundOS é só 'já existe'", () => {
    const result = plan([
      record("a", { Nome: "A", Email: "x@example.com" }),
      record("b", { Nome: "B", Email: "x@example.com" }),
    ], [{ id: 1, email: "x@example.com", celularNormalizado: null }]);
    expect(result.totals).toMatchObject({ toCreate: 0, alreadyExist: 2, review: { total: 0 } });
  });
});

describe("totais e resumo da prévia", () => {
  it("conta tudo e não carrega dados de pessoas", () => {
    const result = plan([
      maria,
      record("rec9", { Nome: "Beto", Email: "beto@example.com" }),
      record("rec8", { Nome: "Existente", Email: "existente@example.com" }),
      record("rec7", { Nome: "Sem contato" }),
    ], [{ id: 1, email: "existente@example.com", celularNormalizado: null }]);
    expect(result.totals).toEqual({
      sourceRecords: 4,
      toCreate: 2,
      alreadyExist: 1,
      alreadyExistBy: { email: 1, phone: 0, both: 0, previousLoad: 0 },
      review: {
        total: 1,
        byReason: { duplicado_no_airtable: 0, ambiguo: 0, contraditorio: 0, dados_insuficientes: 1 },
      },
    });
    expect(JSON.stringify(result.totals)).not.toMatch(/@|Maria|Beto/);
  });

  it("o resumo de criação muda quando quem seria criado ou seus valores mudam, mas não com a ordem", () => {
    const a = plan([maria, record("rec9", { Nome: "Beto", Email: "beto@example.com" })]);
    const reversed = plan([record("rec9", { Nome: "Beto", Email: "beto@example.com" }), maria]);
    expect(creationDigest(a.creates, [])).toBe(creationDigest(reversed.creates, []));

    const changed = plan([maria, record("rec9", { Nome: "Beto", Email: "beto@example.com", Cidade: "Santos" })]);
    expect(creationDigest(changed.creates, [])).not.toBe(creationDigest(a.creates, []));

    const fewer = plan([maria]);
    expect(creationDigest(fewer.creates, [])).not.toBe(creationDigest(a.creates, []));
  });

  it("o resumo também muda quando uma matrícula muda (turma, contrato, inscrição), mas não com a ordem", () => {
    const { creates } = plan([maria]);
    const base = { sourceRecordId: "insc1", personRecordId: "rec1", classId: 10, contractStatus: "pending" };
    const other = { sourceRecordId: "insc2", personRecordId: "rec1", classId: 11, contractStatus: "Assinado" };
    const digest = creationDigest(creates, [base, other]);
    expect(creationDigest(creates, [other, base])).toBe(digest);
    expect(creationDigest(creates, [base])).not.toBe(digest);
    expect(creationDigest(creates, [base, { ...other, classId: 12 }])).not.toBe(digest);
    expect(creationDigest(creates, [base, { ...other, contractStatus: "pending" }])).not.toBe(digest);
    expect(creationDigest(creates, [base, { ...other, sourceRecordId: "insc3" }])).not.toBe(digest);
  });

  it("mudanças em quem seria ignorado não alteram o resumo de criação", () => {
    const existing = [{ id: 1, email: "existente@example.com", celularNormalizado: null }];
    const before = plan([maria, record("rec8", { Nome: "Existente", Email: "existente@example.com" })], existing);
    const after = plan([maria, record("rec8", { Nome: "Existente Editado", Email: "existente@example.com", Cidade: "Rio" })], existing);
    expect(creationDigest(after.creates, [])).toBe(creationDigest(before.creates, []));
    expect(sourceDigest([maria])).not.toBe(sourceDigest([maria, record("x", {})]));
  });
});

describe("limite de leitura plausível", () => {
  it("usa a referência quando nunca houve leitura boa e a última leitura boa depois", () => {
    expect(minimumExpectedRecords(null)).toBe(Math.floor(4829 * 0.9));
    expect(minimumExpectedRecords(6000)).toBe(5400);
  });
});

describe("evidências", () => {
  it("usa o nome do campo em camelCase, como o restante do sistema", () => {
    expect(evidenceField("estado_uf")).toBe("estadoUf");
    expect(evidenceField("id_aluno_cliente")).toBe("idAlunoCliente");
    expect(evidenceField("nome")).toBe("nome");
  });
});
