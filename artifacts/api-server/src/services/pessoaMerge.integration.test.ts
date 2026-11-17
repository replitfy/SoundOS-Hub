import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, pessoaMergeAudits, pessoaNotes, pessoasTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { executePessoaMerge } from "./pessoaMerge";

const rollback = new Error("ROLLBACK_MERGE_PHONE_FIXTURE");

async function inRolledBackTransaction(
  test: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>,
): Promise<void> {
  try {
    await db.transaction(async tx => {
      await test(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe.sequential("pessoa merge phone integration", () => {
  it("moves the source phone to a blank target under a real unique index", async () => {
    await inRolledBackTransaction(async tx => {
      const prefix = `merge-phone-test-${randomUUID()}`;
      await tx.execute(sql.raw(`
        CREATE UNIQUE INDEX merge_phone_test_unique
        ON pessoas (celular_normalizado)
        WHERE codigo LIKE 'merge-phone-test-%'
      `));
      const [target, source] = await tx.insert(pessoasTable).values([
        { codigo: `${prefix}-target`, nome: "Nome Curto", celular: null },
        { codigo: `${prefix}-source`, nome: "Nome Mais Longo", celular: "+55 11 98888-0001" },
      ]).returning();

      const result = await executePessoaMerge(target.id, {
        sourceId: source.id,
        nameFrom: "source",
        emailFrom: "target",
        phoneFrom: "source",
        fieldChoices: {},
        reason: "Teste de telefone da origem",
      }, tx) as { source: typeof source; target: typeof target };

      expect(result.target.celular).toBe("+55 11 98888-0001");
      expect(result.target.celularNormalizado).toBe("5511988880001");
      expect(result.source.celular).toBeNull();
      expect(result.source.celularNormalizado).toBeNull();
      expect(result.source.mergedIntoPessoaId).toBe(target.id);

      const audits = await tx.select().from(pessoaMergeAudits)
        .where(eq(pessoaMergeAudits.sourcePessoaId, source.id));
      expect(audits).toHaveLength(1);
    });
  });

  it("keeps the target phone and preserves the source phone as a note", async () => {
    await inRolledBackTransaction(async tx => {
      const prefix = `merge-phone-test-${randomUUID()}`;
      await tx.execute(sql.raw(`
        CREATE UNIQUE INDEX merge_phone_test_unique
        ON pessoas (celular_normalizado)
        WHERE codigo LIKE 'merge-phone-test-%'
      `));
      const [target, source] = await tx.insert(pessoasTable).values([
        { codigo: `${prefix}-target`, nome: "Destino Principal", celular: "+55 11 97777-0001" },
        { codigo: `${prefix}-source`, nome: "Origem", celular: "+55 11 96666-0001" },
      ]).returning();

      const result = await executePessoaMerge(target.id, {
        sourceId: source.id,
        nameFrom: "target",
        emailFrom: "target",
        phoneFrom: "target",
        fieldChoices: {},
        reason: "Teste de telefone do destino",
      }, tx) as { source: typeof source; target: typeof target };

      expect(result.target.celularNormalizado).toBe("5511977770001");
      expect(result.source.celularNormalizado).toBeNull();
      const notes = await tx.select().from(pessoaNotes).where(eq(pessoaNotes.pessoaId, target.id));
      expect(notes).toHaveLength(1);
      expect(notes[0]?.contactType).toBe("phone");
      expect(notes[0]?.value).toBe("+55 11 96666-0001");
    });
  });
});