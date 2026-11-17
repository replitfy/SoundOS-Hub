// Testes deterministas para determineConduta — não dependem de LLM nem de banco
// real. O módulo @workspace/db é mockado integralmente para que os testes
// possam controlar exatamente quais linhas de evidência estão disponíveis.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks declarados ANTES dos imports do módulo testado ─────────────────────

vi.mock("@workspace/db", () => {
  const dbMock = {
    select: vi.fn(),
  };
  return {
    db: dbMock,
    pessoaEvidencias: {
      nivelConfianca: "nivel_confianca",
      campo: "campo",
      tipoEvidencia: "tipo_evidencia",
      origem: "origem",
      pessoaId: "pessoa_id",
      createdAt: "created_at",
    },
    condutaConfigTable: {
      id: "id",
      triagemBlock: "triagem_block",
      comercialBlock: "comercial_block",
      forbiddenBlock: "forbidden_block",
      updatedAt: "updated_at",
    },
    NIVEL_CONFIANCA_POR_TIPO: {
      declarada: "alta",
      validada: "alta",
      transacional: "media",
      comportamental: "media",
      relacional: "media",
      inferida: "baixa",
    },
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ $and: args }),
  count: () => ({ $count: true }),
  desc: (col: unknown) => ({ $desc: col }),
  eq: (col: unknown, val: unknown) => ({ $eq: [col, val] }),
  inArray: (col: unknown, vals: unknown) => ({ $in: [col, vals] }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) =>
      ({ $sql: String.raw({ raw: strings as unknown as string[] }, ...vals) }),
    { raw: (s: string) => ({ $sql: s }) },
  ),
}));

// ── Imports APÓS os vi.mock() ────────────────────────────────────────────────
import { db } from "@workspace/db";
import {
  determineConduta,
  CONVERGENCIA_MINIMA_POR_CAMPO,
  needsHumanCommercialData,
} from "./conduta";
import type { PessoaConductSignals } from "./conduta";

// ── Utilitários ───────────────────────────────────────────────────────────────

/**
 * Cria um builder drizzle falso que devolve `rows` para qualquer
 * .select().from().where().limit() ou .select().from().where() (count path).
 *
 * where() retorna uma Promise real (para o path sem .limit()) com um método
 * .limit() adicional (para o path primário que encadeia .limit(1)).
 */
function queryBuilder(rows: unknown[]) {
  const terminal = Object.assign(Promise.resolve(rows), {
    limit: () => Promise.resolve(rows),
  });
  return {
    from: () => ({
      where: () => terminal,
    }),
  };
}

/**
 * Configura db.select para retornar uma sequência de resultados, um por chamada.
 * Chamadas além da lista retornam [].
 */
function mockSequence(...responseSets: unknown[][]) {
  let i = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const rows = responseSets[i] ?? [];
    i++;
    return queryBuilder(rows) as unknown as ReturnType<typeof db.select>;
  });
}

/** Sinais completos e favoráveis — só a evidência varia por teste. */
const SINAIS_COMPLETOS: PessoaConductSignals = {
  pessoaId: 42,
  perfilPrincipal: "buscador",
  intencaoPrincipal: "iniciar_jornada",
  temperatura: "morno",
};

// ── Testes ───────────────────────────────────────────────────────────────────

describe("determineConduta — sinais obrigatórios ausentes (sem consulta ao banco)", () => {
  beforeEach(() => vi.mocked(db.select).mockClear());

  it("retorna triagem quando pessoaId é null", async () => {
    expect(await determineConduta({ ...SINAIS_COMPLETOS, pessoaId: null })).toBe("triagem");
  });

  it("retorna triagem quando perfilPrincipal é null", async () => {
    expect(await determineConduta({ ...SINAIS_COMPLETOS, perfilPrincipal: null })).toBe("triagem");
  });

  it("retorna triagem quando intencaoPrincipal é null", async () => {
    expect(await determineConduta({ ...SINAIS_COMPLETOS, intencaoPrincipal: null })).toBe("triagem");
  });

  it("retorna triagem quando temperatura é null", async () => {
    expect(await determineConduta({ ...SINAIS_COMPLETOS, temperatura: null })).toBe("triagem");
  });

  it.each(["frio", "latente", "inativo"] as const)(
    "retorna triagem para temperatura '%s' (não qualificada para comercial)",
    async (temperatura) => {
      expect(await determineConduta({ ...SINAIS_COMPLETOS, temperatura })).toBe("triagem");
    },
  );
});

describe("needsHumanCommercialData — termos que nunca podem usar autoatendimento Wix", () => {
  it.each([
    "tem desconto para a tigela?",
    "existe cupom para esse produto?",
    "posso parcelar o instrumento?",
    "quais são as formas de pagamento?",
    "mande o checkout da tigela",
    "quero pagar agora",
    "quero fazer a inscrição",
    "quero realizar minha inscrição",
    "gostaria de comprar o curso",
    "pode fechar o curso para mim?",
    "adquira o próximo curso para mim",
  ])("exige atendimento humano em: %s", (message) => {
    expect(needsHumanCommercialData(message)).toBe(true);
  });

  it.each([
    "qual o preço da tigela?",
    "me mande o link do produto",
    "ainda tem vaga?",
    "qual o preço e tem estoque deste produto?",
    "qual o valor e a disponibilidade do curso?",
  ])("permite consulta Wix para preço/link simples em: %s", (message) => {
    expect(needsHumanCommercialData(message)).toBe(false);
  });
});

describe("determineConduta — critério primário (evidência média/alta existente)", () => {
  it.each(["morno", "quente", "muito_quente"] as const)(
    "retorna comercial com temperatura '%s' quando há evidência de confiança alta",
    async (temperatura) => {
      mockSequence([{ nivelConfianca: "alta" }]);
      expect(await determineConduta({ ...SINAIS_COMPLETOS, temperatura })).toBe("comercial");
    },
  );

  it("retorna comercial com evidência de confiança 'media'", async () => {
    mockSequence([{ nivelConfianca: "media" }]);
    expect(await determineConduta(SINAIS_COMPLETOS)).toBe("comercial");
  });

  it("não executa as queries de convergência quando o critério primário já resolve", async () => {
    let calls = 0;
    vi.mocked(db.select).mockImplementation(() => {
      calls++;
      return queryBuilder(calls === 1 ? [{ nivelConfianca: "alta" }] : []) as unknown as ReturnType<typeof db.select>;
    });
    expect(await determineConduta(SINAIS_COMPLETOS)).toBe("comercial");
    // apenas 1 select (critério primário) — safety-net (2 selects) não foi acionada
    expect(calls).toBe(1);
  });
});

describe("determineConduta — safety-net de convergência (inferências Sofia)", () => {
  it("retorna triagem quando nenhum campo tem inferências Sofia suficientes", async () => {
    mockSequence(
      [],              // primária: 0 linhas media/alta
      [{ total: 0 }], // perfilPrincipal: 0 inferências sofia
      [{ total: 0 }], // intencaoPrincipal: 0 inferências sofia
    );
    expect(await determineConduta(SINAIS_COMPLETOS)).toBe("triagem");
  });

  it("retorna triagem quando apenas perfilPrincipal atinge o mínimo, intencaoPrincipal não", async () => {
    mockSequence(
      [],
      [{ total: CONVERGENCIA_MINIMA_POR_CAMPO }],
      [{ total: 0 }],
    );
    expect(await determineConduta(SINAIS_COMPLETOS)).toBe("triagem");
  });

  it("retorna triagem quando apenas intencaoPrincipal atinge o mínimo, perfilPrincipal não", async () => {
    mockSequence(
      [],
      [{ total: 0 }],
      [{ total: CONVERGENCIA_MINIMA_POR_CAMPO }],
    );
    expect(await determineConduta(SINAIS_COMPLETOS)).toBe("triagem");
  });

  it("retorna triagem quando um campo tem exatamente mínimo-1 inferências", async () => {
    mockSequence(
      [],
      [{ total: CONVERGENCIA_MINIMA_POR_CAMPO }],
      [{ total: CONVERGENCIA_MINIMA_POR_CAMPO - 1 }],
    );
    expect(await determineConduta(SINAIS_COMPLETOS)).toBe("triagem");
  });

  it("retorna comercial quando ambos os campos atingem exatamente o mínimo", async () => {
    mockSequence(
      [],
      [{ total: CONVERGENCIA_MINIMA_POR_CAMPO }],
      [{ total: CONVERGENCIA_MINIMA_POR_CAMPO }],
    );
    expect(await determineConduta(SINAIS_COMPLETOS)).toBe("comercial");
  });

  it("retorna comercial quando ambos os campos superam o mínimo", async () => {
    mockSequence(
      [],
      [{ total: CONVERGENCIA_MINIMA_POR_CAMPO + 10 }],
      [{ total: CONVERGENCIA_MINIMA_POR_CAMPO + 5 }],
    );
    expect(await determineConduta(SINAIS_COMPLETOS)).toBe("comercial");
  });

  it("retorna comercial com >20 inferências totais — COUNT separado por campo não tem LIMIT global", async () => {
    // Garante que o bug original (LIMIT 20 global escondendo linhas de um campo
    // quando o outro tem muitas entradas recentes) não pode acontecer: os COUNTs
    // são queries independentes, sem limite de linhas.
    mockSequence(
      [],
      [{ total: 50 }],
      [{ total: 50 }],
    );
    expect(await determineConduta(SINAIS_COMPLETOS)).toBe("comercial");
  });

  it("retorna triagem quando o banco retorna 0 para inferências Sofia — outras origens não contam", async () => {
    // A query de convergência filtra origem LIKE 'sofia%': evidências de
    // humanos ou outras origens não aparecem nesse COUNT.
    mockSequence(
      [],           // nenhuma media/alta (critério primário falha)
      [{ total: 0 }], // perfilPrincipal sofia: 0 mesmo que haja outras origens
      [{ total: 0 }], // intencaoPrincipal sofia: 0
    );
    expect(await determineConduta(SINAIS_COMPLETOS)).toBe("triagem");
  });
});
