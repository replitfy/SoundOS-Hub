import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  db,
  pessoaCamposConfirmados,
  pessoaEvidencias,
  pessoaParticipacoes,
  pessoasTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { cleanupUnnamedPeople } from "./unnamedPeopleCleanup";

describe.sequential("cleanupUnnamedPeople integration", () => {
  const fixtureIds: number[] = [];

  afterEach(async () => {
    if (fixtureIds.length === 0) return;
    await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL app.allow_evidencia_cascade_delete = 'on'`);
      await tx.delete(pessoaParticipacoes).where(inArray(pessoaParticipacoes.pessoaId, fixtureIds));
      await tx.delete(pessoaCamposConfirmados).where(inArray(pessoaCamposConfirmados.pessoaId, fixtureIds));
      await tx.delete(pessoasTable).where(inArray(pessoasTable.id, fixtureIds));
    });
    fixtureIds.length = 0;
  });

  async function createPerson(email: string | null): Promise<number> {
    const [person] = await db
      .insert(pessoasTable)
      .values({
        codigo: `cleanup-test-${randomUUID()}`,
        nome: "(sem nome)",
        email,
      })
      .returning({ id: pessoasTable.id });
    fixtureIds.push(person.id);
    return person.id;
  }

  it("updates email records, deletes only unlinked records, and is idempotent", async () => {
    const inferredId = await createPerson("teste.integracao42@example.com");
    const deletableId = await createPerson(null);
    const preservedId = await createPerson(null);
    await db.insert(pessoaParticipacoes).values({
      pessoaId: preservedId,
      curso: "Histórico preservado",
    });

    const scope = [inferredId, deletableId, preservedId];
    const first = await cleanupUnnamedPeople({ personIds: scope });
    expect(first).toMatchObject({ inferred: 1, fallback: 0, deleted: 1 });

    const remaining = await db
      .select({ id: pessoasTable.id, nome: pessoasTable.nome })
      .from(pessoasTable)
      .where(inArray(pessoasTable.id, [inferredId, deletableId, preservedId]));
    expect(remaining).toEqual(expect.arrayContaining([
      { id: inferredId, nome: "Teste Integracao" },
      { id: preservedId, nome: "(sem nome)" },
    ]));
    expect(remaining.some(person => person.id === deletableId)).toBe(false);

    const evidenceBefore = await db
      .select({ id: pessoaEvidencias.id })
      .from(pessoaEvidencias)
      .where(eq(pessoaEvidencias.pessoaId, inferredId));
    expect(evidenceBefore).toHaveLength(1);

    const second = await cleanupUnnamedPeople({ personIds: scope });
    expect(second).toMatchObject({ inferred: 0, fallback: 0, deleted: 0 });
    const evidenceAfter = await db
      .select({ id: pessoaEvidencias.id })
      .from(pessoaEvidencias)
      .where(eq(pessoaEvidencias.pessoaId, inferredId));
    expect(evidenceAfter).toHaveLength(1);
  });

  it("rolls back rather than overwriting a confirmed placeholder name", async () => {
    const confirmedId = await createPerson("nome.confirmado@example.com");
    await db.insert(pessoaCamposConfirmados).values({
      pessoaId: confirmedId,
      campo: "nome",
      confirmadoPor: "cleanup-integration-test",
    });

    await expect(cleanupUnnamedPeople({ personIds: [confirmedId] })).rejects.toThrow(
      "Ainda existem pessoas com e-mail e nome não identificado",
    );

    const [person] = await db
      .select({ nome: pessoasTable.nome })
      .from(pessoasTable)
      .where(eq(pessoasTable.id, confirmedId));
    expect(person.nome).toBe("(sem nome)");
    const evidence = await db
      .select({ id: pessoaEvidencias.id })
      .from(pessoaEvidencias)
      .where(eq(pessoaEvidencias.pessoaId, confirmedId));
    expect(evidence).toHaveLength(0);
  });
});