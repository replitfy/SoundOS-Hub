import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { conversations, db, pessoaEvidencias, pessoasTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { decidirIdentificacaoWhatsapp, identificarOuCriarPessoaDoWhatsapp, nomeEhPlaceholder } from "./sofiaPessoa";

// Tudo roda dentro de uma transação que é desfeita no fim: nada fica no banco.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const rollback = new Error("ROLLBACK_WHATSAPP_FIXTURE");

/** Celular brasileiro sintético com um miolo aleatório, para não colidir com fichas reais. */
function celularSintetico() {
  const miolo = String(randomInt(10_000_000, 99_999_999));
  return { nacional: `119${miolo}`, comPais: `55119${miolo}` };
}

async function emTransacaoDesfeita(teste: (tx: Tx, celular: ReturnType<typeof celularSintetico>) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async tx => {
      await teste(tx, celularSintetico());
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function criarConversa(tx: Tx, valores: { canal?: "interno" | "instagram" | "whatsapp"; canalUsuario?: string | null; pessoaId?: number | null }) {
  const [conversa] = await tx.insert(conversations).values({
    title: "Teste WhatsApp",
    canal: valores.canal ?? "whatsapp",
    canalUsuario: valores.canalUsuario ?? null,
    pessoaId: valores.pessoaId ?? null,
  }).returning({ id: conversations.id });
  return conversa!.id;
}

async function criarFicha(tx: Tx, valores: { celular: string; nome?: string; arquivado?: boolean; ativo?: boolean; mergedInto?: number }) {
  const [ficha] = await tx.insert(pessoasTable).values({
    codigo: `wa-test-${randomUUID()}`,
    nome: valores.nome ?? "Maria Teste",
    celular: valores.celular,
    ativo: valores.ativo ?? true,
    arquivadoEm: valores.arquivado ? new Date() : null,
    mergedIntoPessoaId: valores.mergedInto ?? null,
  }).returning({ id: pessoasTable.id });
  return ficha!.id;
}

async function fichasComOMiolo(tx: Tx, nacional: string): Promise<number> {
  const { rows } = await tx.execute(sql`SELECT count(*)::int AS total FROM pessoas WHERE celular_normalizado = ${nacional}`);
  return Number((rows[0] as { total: number }).total);
}

async function pessoaDaConversa(tx: Tx, conversationId: number): Promise<number | null> {
  const [conversa] = await tx.select({ pessoaId: conversations.pessoaId }).from(conversations).where(eq(conversations.id, conversationId));
  return conversa?.pessoaId ?? null;
}

describe("decidirIdentificacaoWhatsapp (regra pura)", () => {
  const ativa = { id: 1, ativo: true, arquivado_em: null };
  it.each([
    ["nenhuma ficha: cria", [], { status: "criar" }],
    ["uma ficha ativa: reconhece", [ativa], { status: "reconhecida", pessoaId: 1 }],
    ["duas fichas: celular compartilhado, nunca a primeira", [ativa, { ...ativa, id: 2 }], { status: "celular_compartilhado" }],
    ["ficha arquivada: sem ficha segura", [{ ...ativa, arquivado_em: "2026-01-01" }], { status: "ficha_inativa" }],
    ["ficha inativa: sem ficha segura", [{ ...ativa, ativo: false }], { status: "ficha_inativa" }],
  ])("%s", (_nome, linhas, esperado) => {
    expect(decidirIdentificacaoWhatsapp(linhas)).toEqual(esperado);
  });
});

describe.sequential("ficha de quem conversa pelo WhatsApp (banco real, transação desfeita)", () => {
  it("sem ficha com o telefone: cria uma, ligada à conversa, com o telefone do WhatsApp e sem nome; a segunda chamada reaproveita", async () => {
    await emTransacaoDesfeita(async (tx, { nacional, comPais }) => {
      const conversationId = await criarConversa(tx, { canalUsuario: comPais });

      const primeira = await identificarOuCriarPessoaDoWhatsapp({ conversationId }, tx);
      expect(primeira.status).toBe("criada");
      expect(primeira.pessoaId).not.toBeNull();
      expect(await pessoaDaConversa(tx, conversationId)).toBe(primeira.pessoaId);

      const [ficha] = await tx.select().from(pessoasTable).where(eq(pessoasTable.id, primeira.pessoaId!));
      expect(ficha!.celularNormalizado).toBe(nacional);
      // Sem nome de perfil, o nome provisório é só o telefone do WhatsApp; nunca um nome confirmado.
      expect(ficha!.nome).toBe(`WhatsApp +${comPais}`);

      const evidencias = await tx.select({ campo: pessoaEvidencias.campo, origem: pessoaEvidencias.origem })
        .from(pessoaEvidencias)
        .where(and(eq(pessoaEvidencias.pessoaId, primeira.pessoaId!), eq(pessoaEvidencias.campo, "celular")));
      expect(evidencias).toEqual([{ campo: "celular", origem: "sofia:canal-whatsapp" }]);

      const segunda = await identificarOuCriarPessoaDoWhatsapp({ conversationId }, tx);
      expect(segunda).toEqual({ status: "vinculada", pessoaId: primeira.pessoaId });
      expect(await fichasComOMiolo(tx, nacional)).toBe(1);
    });
  });

  it("com nome de perfil: a ficha nasce com um nome provisório marcado como WhatsApp, que conta como placeholder", async () => {
    await emTransacaoDesfeita(async (tx, { comPais }) => {
      const conversationId = await criarConversa(tx, { canalUsuario: comPais });
      const resultado = await identificarOuCriarPessoaDoWhatsapp({ conversationId, perfilWhatsapp: "Maria Souza" }, tx);
      expect(resultado.status).toBe("criada");
      const [ficha] = await tx.select().from(pessoasTable).where(eq(pessoasTable.id, resultado.pessoaId!));
      expect(ficha!.nome).toBe("Maria Souza (WhatsApp)");
      expect(nomeEhPlaceholder(ficha!.nome)).toBe(true);
    });
  });

  it("o nome de perfil só vale na criação: uma ficha achada pelo telefone não é renomeada", async () => {
    await emTransacaoDesfeita(async (tx, celular) => {
      const fichaId = await criarFicha(tx, { celular: celular.nacional, nome: "Maria Souza Real" });
      const conversationId = await criarConversa(tx, { canalUsuario: celular.comPais });
      const resultado = await identificarOuCriarPessoaDoWhatsapp({ conversationId, perfilWhatsapp: "Outro Nome" }, tx);
      expect(resultado).toEqual({ status: "reconhecida", pessoaId: fichaId });
      const [ficha] = await tx.select().from(pessoasTable).where(eq(pessoasTable.id, fichaId));
      expect(ficha!.nome).toBe("Maria Souza Real");
    });
  });

  it.each([
    ["ficha com o telefone sem o 55", (n: { nacional: string; comPais: string }) => n.nacional],
    ["ficha com o telefone com o 55", (n: { nacional: string; comPais: string }) => `+${n.comPais.slice(0, 2)} ${n.comPais.slice(2, 4)} ${n.comPais.slice(4)}`],
  ])("%s: é a mesma ficha, serve ao cartão e NÃO é ligada à conversa", async (_nome, formato) => {
    await emTransacaoDesfeita(async (tx, celular) => {
      const fichaId = await criarFicha(tx, { celular: formato(celular) });
      const conversationId = await criarConversa(tx, { canalUsuario: celular.comPais });

      const resultado = await identificarOuCriarPessoaDoWhatsapp({ conversationId }, tx);
      expect(resultado).toEqual({ status: "reconhecida", pessoaId: fichaId });
      expect(await pessoaDaConversa(tx, conversationId)).toBeNull();
      expect(await fichasComOMiolo(tx, celular.nacional)).toBe(1);
    });
  });

  it("celular compartilhado por duas fichas: nunca escolhe a primeira, não cria e não liga", async () => {
    await emTransacaoDesfeita(async (tx, celular) => {
      await criarFicha(tx, { celular: celular.nacional, nome: "Mãe" });
      await criarFicha(tx, { celular: celular.nacional, nome: "Filha" });
      const conversationId = await criarConversa(tx, { canalUsuario: celular.comPais });

      expect(await identificarOuCriarPessoaDoWhatsapp({ conversationId }, tx)).toEqual({ status: "celular_compartilhado", pessoaId: null });
      expect(await pessoaDaConversa(tx, conversationId)).toBeNull();
      expect(await fichasComOMiolo(tx, celular.nacional)).toBe(2);
    });
  });

  it("ficha arquivada ou inativa com o telefone: não volta, não é recriada, sem cartão", async () => {
    await emTransacaoDesfeita(async (tx, celular) => {
      await criarFicha(tx, { celular: celular.nacional, arquivado: true });
      const conversationId = await criarConversa(tx, { canalUsuario: celular.comPais });
      expect(await identificarOuCriarPessoaDoWhatsapp({ conversationId }, tx)).toEqual({ status: "ficha_inativa", pessoaId: null });
      expect(await fichasComOMiolo(tx, celular.nacional)).toBe(1);
    });
    await emTransacaoDesfeita(async (tx, celular) => {
      await criarFicha(tx, { celular: celular.nacional, ativo: false });
      const conversationId = await criarConversa(tx, { canalUsuario: celular.comPais });
      expect(await identificarOuCriarPessoaDoWhatsapp({ conversationId }, tx)).toEqual({ status: "ficha_inativa", pessoaId: null });
    });
  });

  it("ficha já fundida em outra (tombstone) não conta como ficha do telefone", async () => {
    await emTransacaoDesfeita(async (tx, celular) => {
      const destino = await criarFicha(tx, { celular: `119${randomInt(10_000_000, 99_999_999)}`, nome: "Destino" });
      await criarFicha(tx, { celular: celular.nacional, mergedInto: destino });
      const conversationId = await criarConversa(tx, { canalUsuario: celular.comPais });
      const resultado = await identificarOuCriarPessoaDoWhatsapp({ conversationId }, tx);
      expect(resultado.status).toBe("criada");
    });
  });

  it("número de fora do Brasil não gera ficha nem cartão (um número dos EUA seria lido como DDD + número do Brasil)", async () => {
    await emTransacaoDesfeita(async (tx) => {
      for (const estrangeiro of ["14155550123", "351912345678", "5511"]) {
        const conversationId = await criarConversa(tx, { canalUsuario: estrangeiro });
        expect(await identificarOuCriarPessoaDoWhatsapp({ conversationId }, tx)).toEqual({ status: "celular_estrangeiro", pessoaId: null });
        expect(await pessoaDaConversa(tx, conversationId)).toBeNull();
      }
      const { rows } = await tx.execute(sql`SELECT count(*)::int AS total FROM pessoas WHERE celular_normalizado IN ('4155550123', '14155550123', '912345678')`);
      expect(Number((rows[0] as { total: number }).total)).toBe(0);
    });
  });

  it("conversa que não é do WhatsApp, ou já ligada a uma ficha, é respeitada", async () => {
    await emTransacaoDesfeita(async (tx, celular) => {
      const interna = await criarConversa(tx, { canal: "interno", canalUsuario: celular.comPais });
      expect(await identificarOuCriarPessoaDoWhatsapp({ conversationId: interna }, tx)).toEqual({ status: "fora_do_whatsapp", pessoaId: null });
      expect(await identificarOuCriarPessoaDoWhatsapp({ conversationId: 2_000_000_000 }, tx)).toEqual({ status: "fora_do_whatsapp", pessoaId: null });

      const fichaId = await criarFicha(tx, { celular: `119${randomInt(10_000_000, 99_999_999)}` });
      const ligada = await criarConversa(tx, { canalUsuario: celular.comPais, pessoaId: fichaId });
      expect(await identificarOuCriarPessoaDoWhatsapp({ conversationId: ligada }, tx)).toEqual({ status: "vinculada", pessoaId: fichaId });
      expect(await fichasComOMiolo(tx, celular.nacional)).toBe(0);
    });
  });
});
