// Ligação pedido → ficha com fichas de verdade. Tudo roda dentro de uma transação desfeita no fim:
// nenhuma ficha de teste fica no banco. Nomes, e-mails e telefones são sintéticos e únicos por teste,
// para não colidir com as ~30 mil fichas reais do desenvolvimento.
import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, pessoasTable } from "@workspace/db";
import { findOrdersOfPessoa, linkOrdersToPessoas } from "./storeOrderPessoa";
import type { StoreOrder } from "./wixOrders";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const rollback = new Error("ROLLBACK_STORE_ORDER_FIXTURE");

async function inTransaction(test: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async tx => {
      await test(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

/** Palavra só com letras, improvável em nomes reais. */
function uniqueWord(prefix = "Qzx"): string {
  const letters = randomUUID().replace(/[^a-f]/g, "").slice(0, 6) || "abcdef";
  return `${prefix}${letters}${String.fromCharCode(97 + randomInt(0, 26))}`;
}

function uniquePhone(): { national: string; withCountry: string } {
  const middle = String(randomInt(10_000_000, 99_999_999));
  return { national: `119${middle}`, withCountry: `55119${middle}` };
}

interface FichaInput {
  nome: string;
  sobrenome?: string | null;
  email?: string | null;
  celular?: string | null;
  ativo?: boolean;
  arquivado?: boolean;
  mergedInto?: number;
}

async function createFicha(tx: Tx, input: FichaInput): Promise<number> {
  const [row] = await tx
    .insert(pessoasTable)
    .values({
      codigo: `ped-test-${randomUUID()}`,
      nome: input.nome,
      sobrenome: input.sobrenome ?? null,
      email: input.email ?? null,
      celular: input.celular ?? null,
      ativo: input.ativo ?? true,
      arquivadoEm: input.arquivado ? new Date() : null,
      mergedIntoPessoaId: input.mergedInto ?? null,
    })
    .returning({ id: pessoasTable.id });
  return row!.id;
}

function order(id: string, overrides: Partial<StoreOrder> = {}): StoreOrder {
  return {
    id,
    number: id,
    createdAt: "2026-11-01T12:00:00.000Z",
    customerName: null,
    status: "APPROVED",
    paymentStatus: "PAID",
    fulfillmentStatus: "FULFILLED",
    total: 100,
    shipping: 0,
    email: null,
    phone: null,
    city: null,
    region: null,
    country: null,
    items: [],
    ...overrides,
  };
}

async function linkOne(tx: Tx, candidate: StoreOrder) {
  return (await linkOrdersToPessoas([candidate], tx)).get(candidate.id)!;
}

describe("ligação por e-mail e telefone", () => {
  it("e-mail único liga, ignorando caixa e espaços", async () => {
    await inTransaction(async tx => {
      const email = `${uniqueWord("ana").toLowerCase()}@teste-pedido.invalid`;
      const id = await createFicha(tx, { nome: uniqueWord(), email });
      const link = await linkOne(tx, order("o1", { email: `  ${email.toUpperCase()} ` }));
      expect(link).toMatchObject({ state: "linked", mode: "email", person: { id } });
    });
  });

  it("telefone único liga, com e sem o 55", async () => {
    await inTransaction(async tx => {
      const phone = uniquePhone();
      const id = await createFicha(tx, { nome: uniqueWord(), celular: phone.national });
      for (const raw of [phone.national, `+${phone.withCountry}`, `(11) 9${phone.national.slice(3, 7)}-${phone.national.slice(7)}`]) {
        expect(await linkOne(tx, order("o", { phone: raw }))).toMatchObject({
          state: "linked",
          mode: "phone",
          person: { id },
        });
      }
    });
  });

  it("e-mail e telefone na mesma ficha ligam como 'both'", async () => {
    await inTransaction(async tx => {
      const phone = uniquePhone();
      const email = `${uniqueWord("bia").toLowerCase()}@teste-pedido.invalid`;
      const id = await createFicha(tx, { nome: uniqueWord(), email, celular: phone.withCountry });
      expect(await linkOne(tx, order("o", { email, phone: phone.national }))).toMatchObject({
        state: "linked",
        mode: "both",
        person: { id },
      });
    });
  });

  it("e-mail de uma ficha e telefone de outra é contraditório e não liga", async () => {
    await inTransaction(async tx => {
      const phone = uniquePhone();
      const email = `${uniqueWord("cris").toLowerCase()}@teste-pedido.invalid`;
      const byEmail = await createFicha(tx, { nome: uniqueWord(), email });
      const byPhone = await createFicha(tx, { nome: uniqueWord(), celular: phone.national });
      const link = await linkOne(tx, order("o", { email, phone: phone.national }));
      expect(link).toMatchObject({ state: "review", source: "contact", reason: "contradictory" });
      if (link.state !== "review") throw new Error("esperava conferência");
      expect(link.candidates.map(candidate => candidate.id).sort()).toEqual([byEmail, byPhone].sort());
    });
  });

  it("e-mail repetido em duas fichas e telefone compartilhado não escolhem nenhuma", async () => {
    await inTransaction(async tx => {
      const phone = uniquePhone();
      const email = `${uniqueWord("dani").toLowerCase()}@teste-pedido.invalid`;
      await createFicha(tx, { nome: uniqueWord(), email });
      await createFicha(tx, { nome: uniqueWord(), email });
      await createFicha(tx, { nome: uniqueWord(), celular: phone.national });
      await createFicha(tx, { nome: uniqueWord(), celular: phone.national });
      expect(await linkOne(tx, order("o1", { email }))).toMatchObject({ state: "review", reason: "ambiguous" });
      expect(await linkOne(tx, order("o2", { phone: phone.national }))).toMatchObject({
        state: "review",
        reason: "ambiguous",
      });
    });
  });

  it("ficha arquivada, inativa ou já fundida em outra não entra", async () => {
    await inTransaction(async tx => {
      const email = `${uniqueWord("edu").toLowerCase()}@teste-pedido.invalid`;
      const survivor = await createFicha(tx, { nome: uniqueWord() });
      await createFicha(tx, { nome: uniqueWord(), email, arquivado: true });
      await createFicha(tx, { nome: uniqueWord(), email, ativo: false });
      await createFicha(tx, { nome: uniqueWord(), email, mergedInto: survivor });
      expect(await linkOne(tx, order("o", { email }))).toEqual({ state: "none" });
    });
  });

  it("várias ligações numa só chamada: cada pedido acha a sua ficha", async () => {
    await inTransaction(async tx => {
      const emailA = `${uniqueWord("fa").toLowerCase()}@teste-pedido.invalid`;
      const phoneB = uniquePhone();
      const idA = await createFicha(tx, { nome: uniqueWord(), email: emailA });
      const idB = await createFicha(tx, { nome: uniqueWord(), celular: phoneB.national });
      const links = await linkOrdersToPessoas(
        [order("a", { email: emailA }), order("b", { phone: phoneB.withCountry }), order("c", { email: "ninguem@teste-pedido.invalid" })],
        tx,
      );
      expect(links.get("a")).toMatchObject({ state: "linked", person: { id: idA } });
      expect(links.get("b")).toMatchObject({ state: "linked", person: { id: idB } });
      expect(links.get("c")).toEqual({ state: "none" });
    });
  });
});

describe("ligação por nome (só quando e-mail e telefone não acham nenhuma ficha)", () => {
  it("nome igual, sem acento e em outra caixa, liga com o percentual", async () => {
    await inTransaction(async tx => {
      const first = uniqueWord();
      const last = uniqueWord("Mül");
      const id = await createFicha(tx, { nome: first, sobrenome: last });
      const link = await linkOne(tx, order("o", { customerName: `${first.toUpperCase()} ${last.replace("ü", "u").toUpperCase()}` }));
      expect(link).toMatchObject({ state: "linked", mode: "name", person: { id }, similarity: 100 });
    });
  });

  it("ficha com o nome completo no primeiro campo e sem sobrenome liga", async () => {
    await inTransaction(async tx => {
      const first = uniqueWord();
      const last = uniqueWord();
      const id = await createFicha(tx, { nome: `${first} de ${last}`, sobrenome: null });
      expect(await linkOne(tx, order("o", { customerName: `${first} ${last}` }))).toMatchObject({
        state: "linked",
        mode: "name",
        person: { id },
        similarity: 100,
      });
    });
  });

  it("nome parecido com primeira palavra diferente (Maria x Mario) não liga", async () => {
    await inTransaction(async tx => {
      const last = uniqueWord();
      const base = uniqueWord("Mari");
      await createFicha(tx, { nome: `${base}a`, sobrenome: last });
      expect(await linkOne(tx, order("o", { customerName: `${base}o ${last}` }))).toEqual({ state: "none" });
    });
  });

  it("duas fichas que passam nas regras viram conferência com o percentual de cada uma", async () => {
    await inTransaction(async tx => {
      const first = uniqueWord();
      const middle = uniqueWord();
      const last = uniqueWord();
      const exact = await createFicha(tx, { nome: first, sobrenome: `${middle} ${last}` });
      const shorter = await createFicha(tx, { nome: first, sobrenome: last });
      const link = await linkOne(tx, order("o", { customerName: `${first} ${middle} ${last}` }));
      expect(link).toMatchObject({ state: "review", source: "name", reason: "ambiguous" });
      if (link.state !== "review") throw new Error("esperava conferência");
      expect(link.candidates[0]).toMatchObject({ id: exact, similarity: 100 });
      expect(link.candidates[1]!.id).toBe(shorter);
      expect(link.candidates[1]!.similarity).toBeGreaterThanOrEqual(75);
      expect(link.candidates[1]!.similarity).toBeLessThan(100);
    });
  });

  it("nome de uma palavra só não liga", async () => {
    await inTransaction(async tx => {
      const only = uniqueWord();
      await createFicha(tx, { nome: only });
      expect(await linkOne(tx, order("o", { customerName: only }))).toEqual({ state: "none" });
    });
  });

  it("fichas arquivadas não entram na comparação por nome", async () => {
    await inTransaction(async tx => {
      const first = uniqueWord();
      const last = uniqueWord();
      await createFicha(tx, { nome: first, sobrenome: last, arquivado: true });
      expect(await linkOne(tx, order("o", { customerName: `${first} ${last}` }))).toEqual({ state: "none" });
    });
  });

  it("o nome nunca é usado quando e-mail ou telefone já acharam fichas, mesmo ambíguas", async () => {
    await inTransaction(async tx => {
      const first = uniqueWord();
      const last = uniqueWord();
      const email = `${uniqueWord("gi").toLowerCase()}@teste-pedido.invalid`;
      await createFicha(tx, { nome: uniqueWord(), email });
      await createFicha(tx, { nome: uniqueWord(), email });
      const byName = await createFicha(tx, { nome: first, sobrenome: last });
      const link = await linkOne(tx, order("o", { customerName: `${first} ${last}`, email }));
      expect(link).toMatchObject({ state: "review", source: "contact", reason: "ambiguous" });
      if (link.state !== "review") throw new Error("esperava conferência");
      expect(link.candidates.map(candidate => candidate.id)).not.toContain(byName);
    });
  });

  it("e-mail que acha uma ficha liga por e-mail, mesmo com outra ficha de nome igual", async () => {
    await inTransaction(async tx => {
      const first = uniqueWord();
      const last = uniqueWord();
      const email = `${uniqueWord("hu").toLowerCase()}@teste-pedido.invalid`;
      const byEmail = await createFicha(tx, { nome: uniqueWord(), email });
      await createFicha(tx, { nome: first, sobrenome: last });
      expect(await linkOne(tx, order("o", { customerName: `${first} ${last}`, email }))).toMatchObject({
        state: "linked",
        mode: "email",
        person: { id: byEmail },
      });
    });
  });
});

describe("pedidos sem como ligar", () => {
  it("sem e-mail, telefone nem nome: não há como identificar", async () => {
    await inTransaction(async tx => {
      expect(await linkOne(tx, order("o"))).toEqual({ state: "unidentifiable" });
      expect(await linkOne(tx, order("o", { phone: "12345" }))).toEqual({ state: "unidentifiable" });
    });
  });

  it("retrato antigo (sem e-mail/telefone guardados): o nome ainda liga; sem ligação fica aguardando a atualização", async () => {
    await inTransaction(async tx => {
      const first = uniqueWord();
      const last = uniqueWord();
      const id = await createFicha(tx, { nome: first, sobrenome: last });
      const { email: _email, phone: _phone, ...legacy } = order("o", { customerName: `${first} ${last}` });
      expect(await linkOne(tx, legacy)).toMatchObject({ state: "linked", mode: "name", person: { id } });

      const { email: _e, phone: _p, ...legacyUnknown } = order("o2", { customerName: `${uniqueWord()} ${uniqueWord()}` });
      expect(await linkOne(tx, legacyUnknown)).toEqual({ state: "contact_pending" });
      const { email: _e2, phone: _p2, ...legacyNoName } = order("o3");
      expect(await linkOne(tx, legacyNoName)).toEqual({ state: "contact_pending" });
    });
  });

  it("pedido com contato e sem ficha nenhuma: nenhuma ficha encontrada", async () => {
    await inTransaction(async tx => {
      const link = await linkOne(
        tx,
        order("o", { email: `${uniqueWord("nin").toLowerCase()}@teste-pedido.invalid`, customerName: `${uniqueWord()} ${uniqueWord()}` }),
      );
      expect(link).toEqual({ state: "none" });
    });
  });
});

describe("pedidos de uma ficha (caminho inverso)", () => {
  async function idsOf(tx: Tx, pessoaId: number, orders: StoreOrder[]): Promise<string[]> {
    return (await findOrdersOfPessoa(pessoaId, orders, tx)).map(link => link.order.id).sort();
  }

  it("traz pedidos por e-mail, por telefone e por nome, com o modo de cada ligação", async () => {
    await inTransaction(async tx => {
      const first = uniqueWord();
      const last = uniqueWord();
      const email = `${uniqueWord("rev").toLowerCase()}@teste-pedido.invalid`;
      const phone = uniquePhone();
      const id = await createFicha(tx, { nome: first, sobrenome: last, email, celular: phone.national });
      const orders = [
        order("por-email", { email: ` ${email.toUpperCase()} ` }),
        order("por-telefone", { phone: phone.withCountry }),
        order("por-ambos", { email, phone: phone.national }),
        order("por-nome", { customerName: `${first} ${last}` }),
        order("de-outra-pessoa", { email: `${uniqueWord("out").toLowerCase()}@teste-pedido.invalid`, customerName: `${uniqueWord()} ${uniqueWord()}` }),
      ];
      const links = await findOrdersOfPessoa(id, orders, tx);
      const modes = Object.fromEntries(links.map(link => [link.order.id, link.mode]));
      expect(modes).toEqual({
        "por-email": "email",
        "por-telefone": "phone",
        "por-ambos": "both",
        "por-nome": "name",
      });
      expect(links.find(link => link.order.id === "por-nome")?.similarity).toBe(100);
    });
  });

  it("tem de concordar com a tela de Pedidos: o que liga a outra ficha não aparece aqui", async () => {
    await inTransaction(async tx => {
      const first = uniqueWord();
      const last = uniqueWord();
      const email = `${uniqueWord("dono").toLowerCase()}@teste-pedido.invalid`;
      const other = await createFicha(tx, { nome: uniqueWord(), email });
      const byName = await createFicha(tx, { nome: first, sobrenome: last });
      // Nome igual ao da ficha, mas o e-mail é de outra ficha: o contato vence o nome.
      const stolenByContact = order("contato-vence", { customerName: `${first} ${last}`, email });
      expect(await idsOf(tx, byName, [stolenByContact])).toEqual([]);
      expect(await idsOf(tx, other, [stolenByContact])).toEqual(["contato-vence"]);
    });
  });

  it("nome que serve a duas fichas, ou e-mail e telefone de fichas diferentes, não aparece em nenhuma", async () => {
    await inTransaction(async tx => {
      const first = uniqueWord();
      const last = uniqueWord();
      const twinA = await createFicha(tx, { nome: first, sobrenome: last });
      const twinB = await createFicha(tx, { nome: first, sobrenome: last });
      const ambiguousName = order("nome-ambiguo", { customerName: `${first} ${last}` });
      expect(await idsOf(tx, twinA, [ambiguousName])).toEqual([]);
      expect(await idsOf(tx, twinB, [ambiguousName])).toEqual([]);

      const email = `${uniqueWord("mix").toLowerCase()}@teste-pedido.invalid`;
      const phone = uniquePhone();
      const byEmail = await createFicha(tx, { nome: uniqueWord(), email });
      const byPhone = await createFicha(tx, { nome: uniqueWord(), celular: phone.national });
      const contradictory = order("contraditorio", { email, phone: phone.national });
      expect(await idsOf(tx, byEmail, [contradictory])).toEqual([]);
      expect(await idsOf(tx, byPhone, [contradictory])).toEqual([]);
    });
  });

  it("ficha arquivada, inativa, fundida ou inexistente não recebe pedidos", async () => {
    await inTransaction(async tx => {
      const email = `${uniqueWord("arq").toLowerCase()}@teste-pedido.invalid`;
      const target = await createFicha(tx, { nome: uniqueWord() });
      const archived = await createFicha(tx, { nome: uniqueWord(), email, arquivado: true });
      const inactive = await createFicha(tx, { nome: uniqueWord(), email, ativo: false });
      const merged = await createFicha(tx, { nome: uniqueWord(), email, mergedInto: target });
      const bought = [order("o", { email })];
      expect(await idsOf(tx, archived, bought)).toEqual([]);
      expect(await idsOf(tx, inactive, bought)).toEqual([]);
      expect(await idsOf(tx, merged, bought)).toEqual([]);
      expect(await idsOf(tx, 2_147_000_000, bought)).toEqual([]);
    });
  });

  it("telefone inválido ou ficha sem contato nem nome completo não liga pedido nenhum", async () => {
    await inTransaction(async tx => {
      const id = await createFicha(tx, { nome: uniqueWord() });
      const orders = [
        order("sem-nada"),
        order("telefone-curto", { phone: "12345" }),
        order("so-primeiro-nome", { customerName: "Maria" }),
      ];
      expect(await idsOf(tx, id, orders)).toEqual([]);
    });
  });
});

describe("desempenho com a base real", () => {
  it("uma página de 20 pedidos (todos precisando do nome) resolve rápido", async () => {
    const orders = Array.from({ length: 20 }, (_, index) =>
      order(`p${index}`, { customerName: `${uniqueWord()} ${uniqueWord()}` }),
    );
    const started = Date.now();
    const links = await linkOrdersToPessoas(orders);
    expect(links.size).toBe(20);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
