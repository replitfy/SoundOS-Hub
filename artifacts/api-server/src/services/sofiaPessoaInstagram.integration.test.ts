import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { conversations, db, pessoaEvidencias, pessoasTable } from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { identificarOuCriarPessoaDoInstagram } from "./sofiaPessoa";

// Tudo roda dentro de uma transação que é desfeita no fim: nada fica no banco.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const rollback = new Error("ROLLBACK_INSTAGRAM_FIXTURE");

async function emTransacaoDesfeita(teste: (tx: Tx, usuario: string) => Promise<void>): Promise<void> {
  const usuario = `zz384_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  try {
    await db.transaction(async tx => {
      await teste(tx, usuario);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function criarConversa(tx: Tx, valores: { canal?: "interno" | "instagram"; canalUsuario?: string | null; pessoaId?: number | null }) {
  const [conversa] = await tx.insert(conversations).values({
    title: "Teste Instagram",
    canal: valores.canal ?? "instagram",
    canalUsuario: valores.canalUsuario ?? null,
    pessoaId: valores.pessoaId ?? null,
  }).returning({ id: conversations.id });
  return conversa!.id;
}

async function criarFicha(tx: Tx, valores: { nome?: string; instagram?: string | null; arquivado?: boolean; mergedInto?: number }) {
  const [ficha] = await tx.insert(pessoasTable).values({
    codigo: `ig-test-${randomUUID()}`,
    nome: valores.nome ?? "Maria Teste",
    instagram: valores.instagram ?? null,
    arquivadoEm: valores.arquivado ? new Date() : null,
    mergedIntoPessoaId: valores.mergedInto ?? null,
  }).returning({ id: pessoasTable.id });
  return ficha!.id;
}

async function fichasComUsuario(tx: Tx, usuario: string): Promise<number> {
  const { rows } = await tx.execute(sql`SELECT count(*)::int AS total FROM pessoas WHERE instagram ILIKE ${`%${usuario}%`}`);
  return Number((rows[0] as { total: number }).total);
}

async function pessoaDaConversa(tx: Tx, conversationId: number): Promise<number | null> {
  const [conversa] = await tx.select({ pessoaId: conversations.pessoaId }).from(conversations).where(eq(conversations.id, conversationId));
  return conversa?.pessoaId ?? null;
}

describe.sequential("ficha de quem conversa pelo Instagram sem telefone (banco real, transação desfeita)", () => {
  it("sem ficha com o usuário: cria uma, ligada à conversa, e uma segunda chamada reaproveita a mesma", async () => {
    await emTransacaoDesfeita(async (tx, usuario) => {
      const conversationId = await criarConversa(tx, { canalUsuario: usuario });

      const primeira = await identificarOuCriarPessoaDoInstagram({ conversationId }, tx);
      expect(primeira.status).toBe("criada");
      expect(primeira.pessoaId).not.toBeNull();
      expect(await pessoaDaConversa(tx, conversationId)).toBe(primeira.pessoaId);

      const [ficha] = await tx.select().from(pessoasTable).where(eq(pessoasTable.id, primeira.pessoaId!));
      expect(ficha).toMatchObject({ nome: `@${usuario}`, instagram: usuario, celular: null, celularNormalizado: null });

      // A criação passa pelo mecanismo de evidências, como qualquer escrita da Sofia.
      const evidencias = await tx.select({ campo: pessoaEvidencias.campo, origem: pessoaEvidencias.origem })
        .from(pessoaEvidencias)
        .where(and(eq(pessoaEvidencias.pessoaId, primeira.pessoaId!), eq(pessoaEvidencias.campo, "instagram")));
      expect(evidencias).toEqual([{ campo: "instagram", origem: "sofia:canal-instagram" }]);

      const segunda = await identificarOuCriarPessoaDoInstagram({ conversationId }, tx);
      expect(segunda).toEqual({ status: "vinculada", pessoaId: primeira.pessoaId });
      expect(await fichasComUsuario(tx, usuario)).toBe(1);
    });
  });

  it("pessoa que já existe com o mesmo usuário, em qualquer grafia: usa a ficha, não cria outra e não liga à conversa", async () => {
    for (const grafia of [(u: string) => u, (u: string) => `'@${u.toUpperCase()}`, (u: string) => `https://www.instagram.com/${u}/?hl=pt-br`]) {
      await emTransacaoDesfeita(async (tx, usuario) => {
        const existente = await criarFicha(tx, { instagram: grafia(usuario) });
        const conversationId = await criarConversa(tx, { canalUsuario: usuario });

        const resultado = await identificarOuCriarPessoaDoInstagram({ conversationId }, tx);
        expect(resultado).toEqual({ status: "reconhecida", pessoaId: existente });
        // O usuário na ficha é declarado por alguém: a conversa não é ligada a ela.
        expect(await pessoaDaConversa(tx, conversationId)).toBeNull();
        expect(await fichasComUsuario(tx, usuario)).toBe(1);
      });
    }
  });

  it("ficha fundida em outra (tombstone) é ignorada; a ficha ativa vence", async () => {
    await emTransacaoDesfeita(async (tx, usuario) => {
      const principal = await criarFicha(tx, { instagram: `@${usuario}` });
      await criarFicha(tx, { instagram: usuario, mergedInto: principal });
      const conversationId = await criarConversa(tx, { canalUsuario: usuario });
      expect(await identificarOuCriarPessoaDoInstagram({ conversationId }, tx)).toEqual({ status: "reconhecida", pessoaId: principal });
    });
  });

  it("usuário em mais de uma ficha: não escolhe a primeira nem cria outra", async () => {
    await emTransacaoDesfeita(async (tx, usuario) => {
      await criarFicha(tx, { instagram: `@${usuario}` });
      await criarFicha(tx, { instagram: usuario, nome: "Outra Pessoa" });
      const conversationId = await criarConversa(tx, { canalUsuario: usuario });

      expect(await identificarOuCriarPessoaDoInstagram({ conversationId }, tx)).toEqual({ status: "usuario_compartilhado", pessoaId: null });
      expect(await pessoaDaConversa(tx, conversationId)).toBeNull();
      expect(await fichasComUsuario(tx, usuario)).toBe(2);
    });
  });

  it("ficha arquivada com o usuário: não volta às listas nem é duplicada", async () => {
    await emTransacaoDesfeita(async (tx, usuario) => {
      await criarFicha(tx, { instagram: usuario, arquivado: true });
      const conversationId = await criarConversa(tx, { canalUsuario: usuario });

      expect(await identificarOuCriarPessoaDoInstagram({ conversationId }, tx)).toEqual({ status: "ficha_inativa", pessoaId: null });
      expect(await fichasComUsuario(tx, usuario)).toBe(1);
    });
  });

  it("e-mail ou texto parecido no campo Instagram não casa: cria uma ficha nova", async () => {
    await emTransacaoDesfeita(async (tx, usuario) => {
      await criarFicha(tx, { instagram: `${usuario}@gmail.com` });
      await criarFicha(tx, { instagram: `${usuario}_oficial` });
      const conversationId = await criarConversa(tx, { canalUsuario: usuario });

      const resultado = await identificarOuCriarPessoaDoInstagram({ conversationId }, tx);
      expect(resultado.status).toBe("criada");
      expect(await fichasComUsuario(tx, usuario)).toBe(3);
    });
  });

  it("conversa já ligada a uma ficha (pela equipe) vence qualquer busca por usuário", async () => {
    await emTransacaoDesfeita(async (tx, usuario) => {
      const daEquipe = await criarFicha(tx, { instagram: null });
      await criarFicha(tx, { instagram: usuario, nome: "Outra Pessoa" });
      const conversationId = await criarConversa(tx, { canalUsuario: usuario, pessoaId: daEquipe });

      expect(await identificarOuCriarPessoaDoInstagram({ conversationId }, tx)).toEqual({ status: "vinculada", pessoaId: daEquipe });
      expect(await fichasComUsuario(tx, usuario)).toBe(1);
    });
  });

  it("sem @usuário conhecido: cria a ficha ligada à conversa, com o nome ainda em aberto", async () => {
    await emTransacaoDesfeita(async tx => {
      const conversationId = await criarConversa(tx, { canalUsuario: null });
      const resultado = await identificarOuCriarPessoaDoInstagram({ conversationId }, tx);
      expect(resultado.status).toBe("criada");
      expect(await pessoaDaConversa(tx, conversationId)).toBe(resultado.pessoaId);
      const [ficha] = await tx.select().from(pessoasTable).where(eq(pessoasTable.id, resultado.pessoaId!));
      expect(ficha).toMatchObject({ nome: "(ficha em criação)", instagram: null });
      expect((await identificarOuCriarPessoaDoInstagram({ conversationId }, tx)).status).toBe("vinculada");
    });
  });

  it("conversa do chat interno ou inexistente nunca ganha ficha por aqui", async () => {
    await emTransacaoDesfeita(async (tx, usuario) => {
      const interna = await criarConversa(tx, { canal: "interno", canalUsuario: usuario });
      expect(await identificarOuCriarPessoaDoInstagram({ conversationId: interna }, tx)).toEqual({ status: "fora_do_instagram", pessoaId: null });
      expect(await identificarOuCriarPessoaDoInstagram({ conversationId: 2_147_000_000 }, tx)).toEqual({ status: "fora_do_instagram", pessoaId: null });
      expect(await pessoaDaConversa(tx, interna)).toBeNull();
      expect(await fichasComUsuario(tx, usuario)).toBe(0);
    });
  });

  // Única parte que grava de verdade: duas conexões só disputam a mesma conversa fora de
  // uma transação compartilhada. O que for criado aqui é removido no fim.
  it("duas chamadas simultâneas da mesma conversa (dois eventos na mesma mensagem) criam uma só ficha", async () => {
    const usuario = `zz384_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const [conversa] = await db.insert(conversations)
      .values({ title: "Teste Instagram simultâneo", canal: "instagram", canalUsuario: usuario })
      .returning({ id: conversations.id });
    try {
      const [a, b] = await Promise.all([
        identificarOuCriarPessoaDoInstagram({ conversationId: conversa!.id }),
        identificarOuCriarPessoaDoInstagram({ conversationId: conversa!.id }),
      ]);
      expect(a.pessoaId).not.toBeNull();
      expect(b.pessoaId).toBe(a.pessoaId);
      expect([a.status, b.status].sort()).toEqual(["criada", "vinculada"]);
      const criadas = await db.select({ id: pessoasTable.id }).from(pessoasTable).where(eq(pessoasTable.instagram, usuario));
      expect(criadas).toHaveLength(1);
    } finally {
      const criadas = await db.select({ id: pessoasTable.id }).from(pessoasTable).where(eq(pessoasTable.instagram, usuario));
      const ids = criadas.map(c => c.id);
      await db.transaction(async tx => {
        await tx.delete(conversations).where(eq(conversations.id, conversa!.id));
        if (ids.length > 0) {
          await tx.execute(sql`SET LOCAL app.allow_evidencia_cascade_delete = 'on'`);
          await tx.delete(pessoaEvidencias).where(inArray(pessoaEvidencias.pessoaId, ids));
          await tx.delete(pessoasTable).where(inArray(pessoasTable.id, ids));
        }
      });
    }
  });
});
