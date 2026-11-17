import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  pessoaCamposConfirmados,
  pessoaEvidencias,
  pessoaMergeAudits,
  pessoaNotes,
  pessoasTable,
  type Pessoa,
} from "@workspace/db";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbOrTx = NodePgDatabase<any> | Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

export type MergeChoice = "target" | "source";
export interface MergeOptions {
  sourceId: number;
  nameFrom: MergeChoice;
  emailFrom: MergeChoice;
  phoneFrom: MergeChoice;
  fieldChoices?: Record<string, MergeChoice>;
  reason: string;
  actorUserId?: number;
}

export class PessoaMergeError extends Error {
  constructor(public readonly code: "INVALID" | "NOT_FOUND" | "ALREADY_MERGED" | "CONFLICT", message: string) {
    super(message);
    this.name = "PessoaMergeError";
  }
}

const relationshipTables = [
  "pessoa_servicos",
  "pessoa_participacoes",
  "pessoa_instrumentos",
  "conversations",
  "sofia_decision_runs",
  "pessoa_evidencias",
  "pessoa_campos_confirmados",
  "evento_formulario_submissoes",
  "interesse_geral_submissoes",
  "evento_preinscricoes",
  "enrollments",
  "video_envios",
  "commercial_opportunities",
  "pessoa_notes",
  "pessoa_contato_registros",
] as const;

const copyFields = [
  "cpf", "dataNascimento", "sexo", "instagram", "site",
  "profissao", "profissaoCategoria", "enderecoRua", "cidade", "estadoUf", "cep",
  "servicoInteresse", "comoFicouSabendo", "qualAmigoParceiro", "preferenciaContato",
  "contatoPara", "adicionarContato", "aguaPresencial", "fogoPresencial", "workshopAgua",
  "cacau", "ayahuasca", "concerto", "zapPierre", "idAlunoCliente", "turma",
  "conectadoProposito", "buscaEspiritual", "lugarMusicaSom", "participouTrabalhoSom",
  "qualTrabalhoSom", "midiaInput", "midiaInputOutro", "terapeuta", "formacaoMusicaTerapia",
  "objetivoCurso", "cursoProposito", "cursoExpectativas", "outroCurso", "sentidoParticipar",
  "experienciaAyahuasca", "psicodelicosDrogas", "traumaVida", "ansioliticoAntidepressivos",
  "problemaSaude", "psicoterapiaPsiquiatria", "sensacao", "sensacaoPerseguido", "covid",
  "comprovanteCovid", "perfilPrincipal", "objetivosDeclarados", "macrojornadaPrincipalId",
  "intencaoPrincipal", "temperatura", "estiloCognitivo", "velocidadeEvolucao",
  "preferredLanguage", "consentStatus", "numeroRef", "dataRegistro",
] as const;

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  if (typeof left === "string" || typeof right === "string") return trimmed(left).toLowerCase() === trimmed(right).toLowerCase();
  return left === right;
}
function fullName(p: Pessoa): string {
  return [trimmed(p.nome), trimmed(p.sobrenome)].filter(Boolean).join(" ").trim();
}
function contactValue(p: Pessoa, kind: "email" | "phone"): string {
  return trimmed(kind === "email" ? p.email : p.celular);
}
function secondaryContact(
  source: Pessoa,
  target: Pessoa,
  kind: "email" | "phone",
  selected: MergeChoice,
): { value: string; sourcePessoaId: number } | null {
  const unselected = selected === "target" ? source : target;
  const selectedPerson = selected === "target" ? target : source;
  const value = contactValue(unselected, kind);
  const selectedValue = contactValue(selectedPerson, kind);
  if (!value || value.toLowerCase() === selectedValue.toLowerCase()) return null;
  return { value, sourcePessoaId: unselected.id };
}

export function deriveMergeDefaults(source: Pick<Pessoa, "nome" | "sobrenome" | "email" | "celular">, target: Pick<Pessoa, "nome" | "sobrenome" | "email" | "celular">): {
  nameFrom: MergeChoice;
  emailFrom: MergeChoice;
  phoneFrom: MergeChoice;
} {
  return {
    nameFrom: fullName(source as Pessoa).length > fullName(target as Pessoa).length ? "source" : "target",
    emailFrom: !contactValue(target as Pessoa, "email") && Boolean(contactValue(source as Pessoa, "email")) ? "source" : "target",
    phoneFrom: !contactValue(target as Pessoa, "phone") && Boolean(contactValue(source as Pessoa, "phone")) ? "source" : "target",
  };
}

async function relationshipCounts(client: DbOrTx, id: number): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of relationshipTables) {
    const rows = await client.execute(sql.raw(
      `SELECT COUNT(*)::int AS count FROM "${table}" WHERE pessoa_id = ${id}`,
    ));
    result[table] = Number(rows.rows[0]?.count ?? 0);
  }
  return result;
}

async function collisionCounts(client: DbOrTx, sourceId: number, targetId: number): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  const enrollments = await client.execute(sql`
    SELECT COUNT(*)::int AS count FROM enrollments s
    JOIN enrollments t ON t.class_id = s.class_id AND t.pessoa_id = ${targetId}
    WHERE s.pessoa_id = ${sourceId}
  `);
  result.enrollments = Number(enrollments.rows[0]?.count ?? 0);
  const preinscricoes = await client.execute(sql`
    SELECT COUNT(*)::int AS count FROM evento_preinscricoes s
    JOIN evento_preinscricoes t ON t.evento_id = s.evento_id AND t.pessoa_id = ${targetId}
    WHERE s.pessoa_id = ${sourceId}
  `);
  result.preinscricoes = Number(preinscricoes.rows[0]?.count ?? 0);
  const opportunities = await client.execute(sql`
    SELECT COUNT(*)::int AS count FROM commercial_opportunities s
    JOIN commercial_opportunities t
      ON t.nucleus = s.nucleus AND t.offer_identity = s.offer_identity
     AND t.pessoa_id = ${targetId} AND t.stage <> 'CLOSED' AND s.stage <> 'CLOSED'
    WHERE s.pessoa_id = ${sourceId}
  `);
  result.activeOpportunities = Number(opportunities.rows[0]?.count ?? 0);
  const markers = await client.execute(sql`
    SELECT COUNT(*)::int AS count FROM pessoa_campos_confirmados s
    JOIN pessoa_campos_confirmados t ON t.campo = s.campo AND t.pessoa_id = ${targetId}
    WHERE s.pessoa_id = ${sourceId}
  `);
  result.confirmationMarkers = Number(markers.rows[0]?.count ?? 0);
  return result;
}

async function lockedPessoas(client: DbOrTx, sourceId: number, targetId: number): Promise<{ source?: Pessoa; target?: Pessoa }> {
  const ids = [sourceId, targetId].sort((a, b) => a - b);
  // A deterministic order prevents two opposing merges from deadlocking.
  await client.execute(sql`SELECT id FROM pessoas WHERE id = ${ids[0]} FOR UPDATE`);
  await client.execute(sql`SELECT id FROM pessoas WHERE id = ${ids[1]} FOR UPDATE`);
  const rows = await client.select().from(pessoasTable).where(sql`${pessoasTable.id} IN (${sourceId}, ${targetId})`);
  return { source: rows.find(row => row.id === sourceId), target: rows.find(row => row.id === targetId) };
}

export async function getMergePreview(targetId: number, sourceId: number): Promise<Record<string, unknown>> {
  if (!Number.isInteger(targetId) || !Number.isInteger(sourceId) || targetId === sourceId) {
    throw new PessoaMergeError("INVALID", "targetId e sourceId devem ser inteiros diferentes");
  }
  const [target] = await db.select().from(pessoasTable).where(eq(pessoasTable.id, targetId)).limit(1);
  const [source] = await db.select().from(pessoasTable).where(eq(pessoasTable.id, sourceId)).limit(1);
  if (!target || !source) throw new PessoaMergeError("NOT_FOUND", "Pessoa target/source não encontrada");
  if (target.mergedIntoPessoaId !== null) {
    throw new PessoaMergeError("ALREADY_MERGED", "Pessoa target já foi mesclada em outro registro");
  }
  if (source.mergedIntoPessoaId !== null) {
    if (source.mergedIntoPessoaId === targetId) throw new PessoaMergeError("CONFLICT", "Pessoa já foi mesclada neste target");
    throw new PessoaMergeError("ALREADY_MERGED", "Pessoa source já foi mesclada em outro registro");
  }
  const [relationships, sourceRelationships, collisions] = await Promise.all([
    relationshipCounts(db, targetId),
    relationshipCounts(db, sourceId),
    collisionCounts(db, sourceId, targetId),
  ]);
  const { nameFrom, emailFrom, phoneFrom } = deriveMergeDefaults(source, target);
  const secondaryEmail = secondaryContact(source, target, "email", emailFrom);
  const secondaryPhone = secondaryContact(source, target, "phone", phoneFrom);
  const secondaryContacts = [
    ...(secondaryEmail ? [{ type: "email", ...secondaryEmail }] : []),
    ...(secondaryPhone ? [{ type: "phone", ...secondaryPhone }] : []),
  ];
  const fieldConflicts = copyFields.flatMap(field => {
      const targetValue = (target as unknown as Record<string, unknown>)[field];
      const sourceValue = (source as unknown as Record<string, unknown>)[field];
      return hasValue(targetValue) && hasValue(sourceValue) && !valuesEqual(targetValue, sourceValue)
        ? [{ field, targetValue, sourceValue, defaultFrom: "target" as const }]
        : [];
    });
  return {
    target: { id: target.id, codigo: target.codigo, nome: fullName(target), email: target.email, celular: target.celular, ativo: target.ativo, arquivadoEm: target.arquivadoEm },
    source: { id: source.id, codigo: source.codigo, nome: fullName(source), email: source.email, celular: source.celular, ativo: source.ativo, arquivadoEm: source.arquivadoEm },
    defaults: { nameFrom, emailFrom, phoneFrom },
    relationshipCounts: { target: relationships, source: sourceRelationships },
    collisionCounts: collisions,
    fieldConflicts,
    secondaryContacts,
  };
}

async function reconcileConfirmationMarkers(
  client: DbOrTx,
  source: Pessoa,
  mergedTarget: Pessoa,
): Promise<void> {
  const sourceId = source.id;
  const targetId = mergedTarget.id;
  const sourceMarkers = await client.select().from(pessoaCamposConfirmados).where(eq(pessoaCamposConfirmados.pessoaId, sourceId));
  const targetMarkers = await client.select().from(pessoaCamposConfirmados).where(eq(pessoaCamposConfirmados.pessoaId, targetId));
  const targetByField = new Map(targetMarkers.map(marker => [marker.campo, marker]));
  for (const sourceMarker of sourceMarkers) {
    const targetMarker = targetByField.get(sourceMarker.campo);
    const sourceValue = (source as unknown as Record<string, unknown>)[sourceMarker.campo];
    const targetValue = (mergedTarget as unknown as Record<string, unknown>)[sourceMarker.campo];
    const sourceConfirmationMatchesResult = valuesEqual(sourceValue, targetValue);
    if (!targetMarker) {
      if (sourceConfirmationMatchesResult) {
        await client.update(pessoaCamposConfirmados).set({ pessoaId: targetId }).where(eq(pessoaCamposConfirmados.id, sourceMarker.id));
      } else {
        await client.delete(pessoaCamposConfirmados).where(eq(pessoaCamposConfirmados.id, sourceMarker.id));
      }
      continue;
    }
    if (sourceConfirmationMatchesResult && sourceMarker.confirmadoEm > targetMarker.confirmadoEm) {
      await client.update(pessoaCamposConfirmados)
        .set({ confirmadoPor: sourceMarker.confirmadoPor, confirmadoEm: sourceMarker.confirmadoEm })
        .where(eq(pessoaCamposConfirmados.id, targetMarker.id));
    }
    await client.delete(pessoaCamposConfirmados).where(eq(pessoaCamposConfirmados.id, sourceMarker.id));
  }
}

async function reconcileEnrollments(client: DbOrTx, sourceId: number, targetId: number): Promise<void> {
  await client.execute(sql`UPDATE enrollments SET pessoa_id = ${targetId} WHERE pessoa_id = ${sourceId}`);
}

async function reconcilePreinscricoes(client: DbOrTx, sourceId: number, targetId: number): Promise<void> {
  await client.execute(sql`UPDATE evento_preinscricoes SET pessoa_id = ${targetId}, updated_at = now() WHERE pessoa_id = ${sourceId}`);
}

async function reconcileOpportunities(client: DbOrTx, sourceId: number, targetId: number): Promise<void> {
  const rows = await client.execute(sql`
    SELECT s.id, s.nucleus, s.offer_identity, s.stage
    FROM commercial_opportunities s
    WHERE s.pessoa_id = ${sourceId}
    ORDER BY s.id
    FOR UPDATE
  `);
  for (const row of rows.rows) {
    const activeCollision = await client.execute(sql`
      SELECT id FROM commercial_opportunities
      WHERE pessoa_id = ${targetId} AND nucleus = ${String(row.nucleus)}
        AND offer_identity = ${String(row.offer_identity)} AND stage <> 'CLOSED'
      LIMIT 1
    `);
    if (activeCollision.rows.length > 0 && String(row.stage) !== "CLOSED") {
      await client.execute(sql`UPDATE commercial_opportunities SET stage = 'CLOSED', close_reason = 'Merged duplicate into target pessoa', updated_at = now() WHERE id = ${Number(row.id)}`);
    }
    await client.execute(sql`UPDATE commercial_opportunities SET pessoa_id = ${targetId}, updated_at = now() WHERE id = ${Number(row.id)}`);
  }
}

export async function executePessoaMerge(
  targetId: number,
  options: MergeOptions,
  existingTransaction?: DbOrTx,
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(targetId) || !Number.isInteger(options.sourceId) || targetId === options.sourceId) {
    throw new PessoaMergeError("INVALID", "targetId e sourceId devem ser inteiros diferentes");
  }
  if (!options.reason?.trim()) throw new PessoaMergeError("INVALID", "reason é obrigatório");

  const runMerge = async (tx: DbOrTx): Promise<Record<string, unknown>> => {
    const locked = await lockedPessoas(tx, options.sourceId, targetId);
    const source = locked.source;
    const target = locked.target;
    if (!source || !target) throw new PessoaMergeError("NOT_FOUND", "Pessoa target/source não encontrada");
    if (target.mergedIntoPessoaId !== null) {
      throw new PessoaMergeError("ALREADY_MERGED", "Pessoa target já foi mesclada em outro registro");
    }
    if (source.mergedIntoPessoaId !== null) {
      if (source.mergedIntoPessoaId !== targetId) throw new PessoaMergeError("ALREADY_MERGED", "Pessoa source já foi mesclada em outro registro");
      const [existing] = await tx.select().from(pessoaMergeAudits).where(and(eq(pessoaMergeAudits.sourcePessoaId, source.id), eq(pessoaMergeAudits.targetPessoaId, target.id))).limit(1);
      return { idempotent: true, target, source, audit: existing ?? null };
    }
    const collisions = await collisionCounts(tx, source.id, target.id);
    if (collisions.enrollments > 0 || collisions.preinscricoes > 0) {
      throw new PessoaMergeError(
        "CONFLICT",
        "A fusão foi bloqueada porque há matrícula ou pré-inscrição duplicada; resolva a colisão sem apagar o histórico antes de tentar novamente.",
      );
    }
    const sourceSnapshot = { ...source };
    const targetSnapshot = { ...target };
    // The evidence trigger remains append-only for normal writes. A merge is
    // the one audited, transactional operation allowed to re-home its FK.
    await tx.execute(sql`SET LOCAL app.allow_pessoa_merge = 'on'`);
    // Tombstone first, inside the same transaction. This closes the window in
    // which another writer could attach a fresh child row after the transfer.
    // If any later step fails, PostgreSQL rolls this update back with the merge.
    const [mergedSource] = await tx.update(pessoasTable).set({
      ativo: false,
      arquivadoEm: new Date(),
      mergedIntoPessoaId: targetId,
      // The pre-merge snapshot and secondary-contact notes preserve these
      // values. Clear identity fields on the tombstone so the target can adopt
      // them safely and future lookups cannot match the old record.
      email: null,
      celular: null,
      celularNormalizado: null,
      updatedAt: new Date(),
    }).where(eq(pessoasTable.id, options.sourceId)).returning();

    const updates: Record<string, unknown> = {};
    for (const field of copyFields) {
      const targetValue = (target as unknown as Record<string, unknown>)[field];
      const sourceValue = (source as unknown as Record<string, unknown>)[field];
      if (!hasValue(targetValue) && hasValue(sourceValue)) {
        updates[field] = sourceValue;
      } else if (hasValue(targetValue) && hasValue(sourceValue) && !valuesEqual(targetValue, sourceValue)) {
        const choice = options.fieldChoices?.[field];
        if (choice !== "target" && choice !== "source") {
          throw new PessoaMergeError("INVALID", `Escolha obrigatória para o campo conflitante: ${field}`);
        }
        if (choice === "source") updates[field] = sourceValue;
      }
    }
    const selectedName = options.nameFrom === "source" ? source : target;
    const selectedEmail = options.emailFrom === "source" ? source : target;
    const selectedPhone = options.phoneFrom === "source" ? source : target;
    if (trimmed(selectedName.nome)) updates.nome = trimmed(selectedName.nome);
    updates.sobrenome = selectedName.sobrenome;
    if (trimmed(selectedEmail.email)) updates.email = trimmed(selectedEmail.email);
    if (trimmed(selectedPhone.celular)) {
      updates.celular = trimmed(selectedPhone.celular);
    }
    if (Object.keys(updates).length > 0) {
      await tx.update(pessoasTable).set(updates as never).where(eq(pessoasTable.id, targetId));
    }
    const [mergedBeforeRelationships] = await tx.select().from(pessoasTable).where(eq(pessoasTable.id, targetId)).limit(1);
    if (!mergedBeforeRelationships) throw new PessoaMergeError("NOT_FOUND", "Pessoa target não encontrada após atualização");

    // Resolve every known live FK before marking the source tombstone.
    await reconcileConfirmationMarkers(tx, source, mergedBeforeRelationships);
    await reconcileEnrollments(tx, options.sourceId, targetId);
    await reconcilePreinscricoes(tx, options.sourceId, targetId);
    await reconcileOpportunities(tx, options.sourceId, targetId);
    for (const table of ["pessoa_servicos", "pessoa_participacoes", "pessoa_instrumentos", "conversations", "sofia_decision_runs", "pessoa_evidencias", "evento_formulario_submissoes", "interesse_geral_submissoes", "video_envios", "pessoa_notes", "pessoa_contato_registros"]) {
      await tx.execute(sql.raw(`UPDATE "${table}" SET pessoa_id = ${targetId} WHERE pessoa_id = ${options.sourceId}`));
    }

    for (const [kind, choice] of [["email", options.emailFrom], ["phone", options.phoneFrom]] as const) {
      const noteContact = secondaryContact(source, target, kind, choice);
      if (noteContact) {
        await tx.insert(pessoaNotes).values({
          pessoaId: targetId,
          sourcePessoaId: noteContact.sourcePessoaId,
          contactType: kind,
          value: noteContact.value,
          body: `Contato secundário preservado da pessoa ${noteContact.sourcePessoaId} durante mesclagem.`,
          createdBy: options.actorUserId ? `humano:${options.actorUserId}` : "merge",
        });
      }
    }

    const [mergedTarget] = await tx.select().from(pessoasTable).where(eq(pessoasTable.id, targetId)).limit(1);
    const [audit] = await tx.insert(pessoaMergeAudits).values({
      sourcePessoaId: options.sourceId,
      targetPessoaId: targetId,
      actorUserId: options.actorUserId ?? null,
      reason: options.reason.trim(),
      options: {
        nameFrom: options.nameFrom,
        emailFrom: options.emailFrom,
        phoneFrom: options.phoneFrom,
        fieldChoices: options.fieldChoices ?? {},
      },
      sourceSnapshot,
      targetSnapshot,
      resultSnapshot: mergedTarget ?? {},
    }).returning();
    return { idempotent: false, target: mergedTarget, source: mergedSource, audit };
  };
  return existingTransaction ? runMerge(existingTransaction) : db.transaction(runMerge);
}

export async function listPessoaNotes(id: number): Promise<unknown[]> {
  return db.select().from(pessoaNotes).where(eq(pessoaNotes.pessoaId, id)).orderBy(desc(pessoaNotes.createdAt));
}