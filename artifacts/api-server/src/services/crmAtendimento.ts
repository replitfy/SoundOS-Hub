import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  db,
  commercialOpportunities,
  commercialOpportunityNotes,
  commercialOpportunityTasks,
  commercialOpportunityAppointments,
  usersTable,
} from "@workspace/db";
import { appendEvent, OpportunityRuleError, type DbClient, type OpportunityActor } from "./commercialOpportunities";

// Informações, observações, tarefas e compromissos do card. Nenhuma destas ações sobe a `version` da
// oportunidade (ela protege quem edita o card; subir faria a próxima gravação de quem o tem aberto
// falhar). Cada uma grava o histórico na mesma transação, com o tipo genérico UPDATED e a ação em
// `metadata.action` (a restrição de tipos de evento do banco não muda). Oportunidade encerrada é só leitura.

export const LIMITE_INFORMACOES = 10_000;
export const LIMITE_OBSERVACAO = 5_000;
export const LIMITE_TAREFA = 500;
export const LIMITE_TITULO = 200;
export const LIMITE_LINK = 2_000;

export type AcaoDoCard =
  | "INFORMATION_UPDATED"
  | "NOTE_ADDED"
  | "TASK_CREATED"
  | "TASK_EDITED"
  | "TASK_DONE"
  | "TASK_REOPENED"
  | "TASK_DELETED"
  | "APPOINTMENT_CREATED"
  | "APPOINTMENT_EDITED"
  | "APPOINTMENT_DELETED"
  | "ATTENDANCE_ASSUMED"
  | "ATTENDANCE_RETURNED"
  | "MESSAGE_SENT"
  | "TEMPLATE_SENT"
  // Arquivo (imagem, vídeo, áudio ou documento) enviado pela equipe no chat do cartão.
  | "ATTACHMENT_SENT"
  | "CONTACT_AUTHORIZED"
  | "CONTACT_OPT_OUT"
  | "CONTACT_OPT_OUT_UNDONE"
  | "CONVERSATION_LINKED"
  // O primeiro contato automático da Sofia (formulário) não saiu: o motivo vai no histórico do card.
  | "AUTO_OPENING_NOT_SENT";

export function exigirHumano(actor: OpportunityActor): number {
  if (actor.kind !== "HUMAN" || !actor.id) {
    throw new OpportunityRuleError("Apenas um usuário autenticado da equipe pode fazer isto.", "HUMAN_REQUIRED", 403);
  }
  return actor.id;
}

/** Texto obrigatório, sem espaços nas pontas e dentro do limite. */
export function textoObrigatorio(valor: unknown, campo: string, limite: number): string {
  const texto = typeof valor === "string" ? valor.trim() : "";
  if (!texto) throw new OpportunityRuleError(`${campo} é obrigatório.`, "TEXT_REQUIRED", 422);
  if (texto.length > limite) throw new OpportunityRuleError(`${campo} passa de ${limite} caracteres.`, "TEXT_TOO_LONG", 422);
  return texto;
}

function dataOpcional(valor: unknown, campo: string): Date | null {
  if (valor === null || valor === undefined || valor === "") return null;
  const data = valor instanceof Date ? valor : new Date(String(valor));
  if (Number.isNaN(data.getTime())) throw new OpportunityRuleError(`${campo} inválida.`, "INVALID_DATE", 422);
  return data;
}

/** Só http ou https: o link abre em nova aba e um `javascript:` seria executado pelo navegador. */
export function linkOpcional(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  const texto = typeof valor === "string" ? valor.trim() : "";
  if (!texto) return null;
  if (texto.length > LIMITE_LINK) throw new OpportunityRuleError("O link é longo demais.", "LINK_TOO_LONG", 422);
  let url: URL;
  try { url = new URL(texto); } catch { throw new OpportunityRuleError("Link inválido.", "INVALID_LINK", 422); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OpportunityRuleError("O link precisa começar com http ou https.", "INVALID_LINK", 422);
  }
  return url.toString();
}

/**
 * Trava a oportunidade (FOR NO KEY UPDATE) contra encerramento simultâneo e recusa quando já está
 * encerrada. As ações do card no mesmo card correm uma por vez: com FOR SHARE, duas delas que depois
 * gravam `updated_at` se travariam uma à outra.
 */
export async function travarOportunidadeAberta(tx: DbClient, opportunityId: number): Promise<{ id: number; pessoaId: number; stage: string }> {
  const resultado = await tx.execute(sql`
    SELECT id, pessoa_id AS "pessoaId", stage FROM commercial_opportunities WHERE id = ${opportunityId} FOR NO KEY UPDATE
  `);
  const linha = resultado.rows[0] as { id: number; pessoaId: number; stage: string } | undefined;
  if (!linha) throw new OpportunityRuleError("Oportunidade não encontrada.", "NOT_FOUND", 404);
  if (linha.stage === "CLOSED") {
    throw new OpportunityRuleError("Oportunidade encerrada: só é possível reativá-la.", "OPPORTUNITY_CLOSED", 409);
  }
  return linha;
}

/** Registra a ação no histórico e marca a atividade do card, sem mexer na versão. */
export async function registrarAcao(
  tx: DbClient,
  opportunityId: number,
  actor: OpportunityActor,
  acao: AcaoDoCard,
  detalhes: Record<string, unknown> = {},
): Promise<void> {
  await appendEvent(tx, {
    opportunityId,
    actor,
    eventType: "UPDATED",
    source: "CRM",
    idempotencyKey: `crm:${acao}:${randomUUID()}`,
    metadata: { action: acao, ...detalhes },
  });
  await tx.update(commercialOpportunities).set({ updatedAt: new Date() }).where(eq(commercialOpportunities.id, opportunityId));
}

/** Cartões abertos da pessoa, travados sempre em ordem de id (nunca trava em ciclo com outra transação). */
export async function travarCartoesAbertosDaPessoa(tx: DbClient, pessoaId: number): Promise<number[]> {
  const abertos = await tx.execute(sql`
    SELECT id FROM commercial_opportunities
    WHERE pessoa_id = ${pessoaId} AND stage <> 'CLOSED'
    ORDER BY id FOR NO KEY UPDATE
  `);
  return (abertos.rows as Array<{ id: number }>).map(r => r.id);
}

/** Registra a mesma ação no histórico de todos os cartões abertos da pessoa (autorização, vínculo, modelo enviado). */
export async function registrarAcaoNosCartoesAbertos(
  tx: DbClient,
  pessoaId: number,
  actor: OpportunityActor,
  acao: AcaoDoCard,
  detalhes: Record<string, unknown> = {},
): Promise<number[]> {
  const ids = await travarCartoesAbertosDaPessoa(tx, pessoaId);
  for (const id of ids) await registrarAcao(tx, id, actor, acao, detalhes);
  return ids;
}

// ── Informações ────────────────────────────────────────────────────────────────

export async function salvarInformacoes(input: { opportunityId: number; actor: OpportunityActor; informacoes: unknown }): Promise<{ informacoes: string | null }> {
  exigirHumano(input.actor);
  const novo = typeof input.informacoes === "string" ? input.informacoes.trim() : "";
  if (novo.length > LIMITE_INFORMACOES) throw new OpportunityRuleError(`As informações passam de ${LIMITE_INFORMACOES} caracteres.`, "TEXT_TOO_LONG", 422);
  return db.transaction(async (tx) => {
    await travarOportunidadeAberta(tx, input.opportunityId);
    const [atual] = await tx.select({ informacoes: commercialOpportunities.informacoes }).from(commercialOpportunities)
      .where(eq(commercialOpportunities.id, input.opportunityId)).limit(1);
    const valorNovo = novo === "" ? null : novo;
    if ((atual?.informacoes ?? null) === valorNovo) return { informacoes: valorNovo };
    await tx.update(commercialOpportunities).set({ informacoes: valorNovo }).where(eq(commercialOpportunities.id, input.opportunityId));
    await registrarAcao(tx, input.opportunityId, input.actor, "INFORMATION_UPDATED", { previous: atual?.informacoes ?? null, current: valorNovo });
    return { informacoes: valorNovo };
  });
}

// ── Observações ────────────────────────────────────────────────────────────────

export async function adicionarObservacao(input: { opportunityId: number; actor: OpportunityActor; texto: unknown }) {
  const autorId = exigirHumano(input.actor);
  const texto = textoObrigatorio(input.texto, "A observação", LIMITE_OBSERVACAO);
  return db.transaction(async (tx) => {
    await travarOportunidadeAberta(tx, input.opportunityId);
    const [nota] = await tx.insert(commercialOpportunityNotes)
      .values({ opportunityId: input.opportunityId, text: texto, authorUserId: autorId }).returning();
    await registrarAcao(tx, input.opportunityId, input.actor, "NOTE_ADDED", { noteId: nota!.id, text: texto });
    return nota!;
  });
}

// ── Tarefas ────────────────────────────────────────────────────────────────────

async function tarefaDoCard(tx: DbClient, opportunityId: number, taskId: number) {
  const [tarefa] = await tx.select().from(commercialOpportunityTasks)
    .where(and(eq(commercialOpportunityTasks.id, taskId), eq(commercialOpportunityTasks.opportunityId, opportunityId)))
    .for("update").limit(1);
  if (!tarefa) throw new OpportunityRuleError("Tarefa não encontrada.", "TASK_NOT_FOUND", 404);
  return tarefa as typeof commercialOpportunityTasks.$inferSelect;
}

export async function criarTarefa(input: { opportunityId: number; actor: OpportunityActor; texto: unknown; prazo?: unknown }) {
  const autorId = exigirHumano(input.actor);
  const texto = textoObrigatorio(input.texto, "A tarefa", LIMITE_TAREFA);
  const prazo = dataOpcional(input.prazo, "Prazo");
  return db.transaction(async (tx) => {
    await travarOportunidadeAberta(tx, input.opportunityId);
    const [tarefa] = await tx.insert(commercialOpportunityTasks)
      .values({ opportunityId: input.opportunityId, text: texto, dueAt: prazo, createdByUserId: autorId }).returning();
    await registrarAcao(tx, input.opportunityId, input.actor, "TASK_CREATED", { taskId: tarefa!.id, text: texto, dueAt: prazo?.toISOString() ?? null });
    return tarefa!;
  });
}

export async function editarTarefa(input: { opportunityId: number; taskId: number; actor: OpportunityActor; texto: unknown; prazo?: unknown }) {
  exigirHumano(input.actor);
  const texto = textoObrigatorio(input.texto, "A tarefa", LIMITE_TAREFA);
  const prazo = dataOpcional(input.prazo, "Prazo");
  return db.transaction(async (tx) => {
    await travarOportunidadeAberta(tx, input.opportunityId);
    const atual = await tarefaDoCard(tx, input.opportunityId, input.taskId);
    const [tarefa] = await tx.update(commercialOpportunityTasks)
      .set({ text: texto, dueAt: prazo, updatedAt: new Date() })
      .where(eq(commercialOpportunityTasks.id, input.taskId)).returning();
    await registrarAcao(tx, input.opportunityId, input.actor, "TASK_EDITED", {
      taskId: input.taskId,
      previousText: atual.text, text: texto,
      previousDueAt: atual.dueAt?.toISOString() ?? null, dueAt: prazo?.toISOString() ?? null,
    });
    return tarefa!;
  });
}

/** Marca ou desmarca como executada. Não muda a próxima ação nem a etapa do card. */
export async function definirTarefaExecutada(input: { opportunityId: number; taskId: number; actor: OpportunityActor; executada: boolean }) {
  const autorId = exigirHumano(input.actor);
  return db.transaction(async (tx) => {
    await travarOportunidadeAberta(tx, input.opportunityId);
    const atual = await tarefaDoCard(tx, input.opportunityId, input.taskId);
    if ((atual.doneAt !== null) === input.executada) return atual;
    const [tarefa] = await tx.update(commercialOpportunityTasks)
      .set(input.executada
        ? { doneAt: new Date(), doneByUserId: autorId, updatedAt: new Date() }
        : { doneAt: null, doneByUserId: null, updatedAt: new Date() })
      .where(eq(commercialOpportunityTasks.id, input.taskId)).returning();
    await registrarAcao(tx, input.opportunityId, input.actor, input.executada ? "TASK_DONE" : "TASK_REOPENED", { taskId: input.taskId, text: atual.text });
    return tarefa!;
  });
}

/** Apagar guarda o texto no histórico: o que foi apagado continua legível. */
export async function apagarTarefa(input: { opportunityId: number; taskId: number; actor: OpportunityActor }): Promise<void> {
  exigirHumano(input.actor);
  await db.transaction(async (tx) => {
    await travarOportunidadeAberta(tx, input.opportunityId);
    const atual = await tarefaDoCard(tx, input.opportunityId, input.taskId);
    await tx.delete(commercialOpportunityTasks).where(eq(commercialOpportunityTasks.id, input.taskId));
    await registrarAcao(tx, input.opportunityId, input.actor, "TASK_DELETED", {
      taskId: input.taskId, text: atual.text, dueAt: atual.dueAt?.toISOString() ?? null, wasDone: atual.doneAt !== null,
    });
  });
}

// ── Compromissos ───────────────────────────────────────────────────────────────

async function compromissoDoCard(tx: DbClient, opportunityId: number, appointmentId: number) {
  const [compromisso] = await tx.select().from(commercialOpportunityAppointments)
    .where(and(eq(commercialOpportunityAppointments.id, appointmentId), eq(commercialOpportunityAppointments.opportunityId, opportunityId)))
    .for("update").limit(1);
  if (!compromisso) throw new OpportunityRuleError("Compromisso não encontrado.", "APPOINTMENT_NOT_FOUND", 404);
  return compromisso as typeof commercialOpportunityAppointments.$inferSelect;
}

function entradaDoCompromisso(input: { titulo: unknown; dataHora: unknown; link?: unknown }) {
  const titulo = textoObrigatorio(input.titulo, "O título", LIMITE_TITULO);
  const dataHora = dataOpcional(input.dataHora, "Data e hora");
  if (!dataHora) throw new OpportunityRuleError("Data e hora são obrigatórias.", "INVALID_DATE", 422);
  return { titulo, dataHora, link: linkOpcional(input.link) };
}

export async function criarCompromisso(input: { opportunityId: number; actor: OpportunityActor; titulo: unknown; dataHora: unknown; link?: unknown }) {
  const autorId = exigirHumano(input.actor);
  const dados = entradaDoCompromisso(input);
  return db.transaction(async (tx) => {
    await travarOportunidadeAberta(tx, input.opportunityId);
    const [compromisso] = await tx.insert(commercialOpportunityAppointments)
      .values({ opportunityId: input.opportunityId, title: dados.titulo, startsAt: dados.dataHora, link: dados.link, createdByUserId: autorId }).returning();
    await registrarAcao(tx, input.opportunityId, input.actor, "APPOINTMENT_CREATED", {
      appointmentId: compromisso!.id, title: dados.titulo, startsAt: dados.dataHora.toISOString(), link: dados.link,
    });
    return compromisso!;
  });
}

export async function editarCompromisso(input: { opportunityId: number; appointmentId: number; actor: OpportunityActor; titulo: unknown; dataHora: unknown; link?: unknown }) {
  exigirHumano(input.actor);
  const dados = entradaDoCompromisso(input);
  return db.transaction(async (tx) => {
    await travarOportunidadeAberta(tx, input.opportunityId);
    const atual = await compromissoDoCard(tx, input.opportunityId, input.appointmentId);
    const [compromisso] = await tx.update(commercialOpportunityAppointments)
      .set({ title: dados.titulo, startsAt: dados.dataHora, link: dados.link, updatedAt: new Date() })
      .where(eq(commercialOpportunityAppointments.id, input.appointmentId)).returning();
    await registrarAcao(tx, input.opportunityId, input.actor, "APPOINTMENT_EDITED", {
      appointmentId: input.appointmentId,
      previousTitle: atual.title, title: dados.titulo,
      previousStartsAt: atual.startsAt.toISOString(), startsAt: dados.dataHora.toISOString(),
      previousLink: atual.link, link: dados.link,
    });
    return compromisso!;
  });
}

export async function apagarCompromisso(input: { opportunityId: number; appointmentId: number; actor: OpportunityActor }): Promise<void> {
  exigirHumano(input.actor);
  await db.transaction(async (tx) => {
    await travarOportunidadeAberta(tx, input.opportunityId);
    const atual = await compromissoDoCard(tx, input.opportunityId, input.appointmentId);
    await tx.delete(commercialOpportunityAppointments).where(eq(commercialOpportunityAppointments.id, input.appointmentId));
    await registrarAcao(tx, input.opportunityId, input.actor, "APPOINTMENT_DELETED", {
      appointmentId: input.appointmentId, title: atual.title, startsAt: atual.startsAt.toISOString(), link: atual.link,
    });
  });
}

// ── Leitura ────────────────────────────────────────────────────────────────────

export async function carregarAtendimento(opportunityId: number) {
  const [oportunidade] = await db.select({ id: commercialOpportunities.id, informacoes: commercialOpportunities.informacoes })
    .from(commercialOpportunities).where(eq(commercialOpportunities.id, opportunityId)).limit(1);
  if (!oportunidade) return null;
  const nomeDe = (coluna: AnyPgColumn) => sql<string | null>`(SELECT u.name FROM ${usersTable} u WHERE u.id = ${coluna})`;
  const [notas, tarefas, compromissos] = await Promise.all([
    db.select({
      id: commercialOpportunityNotes.id, text: commercialOpportunityNotes.text,
      authorUserId: commercialOpportunityNotes.authorUserId, authorName: nomeDe(commercialOpportunityNotes.authorUserId),
      createdAt: commercialOpportunityNotes.createdAt,
    }).from(commercialOpportunityNotes)
      .where(eq(commercialOpportunityNotes.opportunityId, opportunityId))
      .orderBy(desc(commercialOpportunityNotes.createdAt), desc(commercialOpportunityNotes.id)),
    db.select({
      id: commercialOpportunityTasks.id, text: commercialOpportunityTasks.text, dueAt: commercialOpportunityTasks.dueAt,
      doneAt: commercialOpportunityTasks.doneAt, doneByUserId: commercialOpportunityTasks.doneByUserId,
      doneByName: nomeDe(commercialOpportunityTasks.doneByUserId),
      createdByUserId: commercialOpportunityTasks.createdByUserId, createdByName: nomeDe(commercialOpportunityTasks.createdByUserId),
      createdAt: commercialOpportunityTasks.createdAt,
    }).from(commercialOpportunityTasks)
      .where(eq(commercialOpportunityTasks.opportunityId, opportunityId))
      .orderBy(asc(commercialOpportunityTasks.createdAt), asc(commercialOpportunityTasks.id)),
    db.select({
      id: commercialOpportunityAppointments.id, title: commercialOpportunityAppointments.title,
      startsAt: commercialOpportunityAppointments.startsAt, link: commercialOpportunityAppointments.link,
      createdByUserId: commercialOpportunityAppointments.createdByUserId, createdByName: nomeDe(commercialOpportunityAppointments.createdByUserId),
    }).from(commercialOpportunityAppointments)
      .where(eq(commercialOpportunityAppointments.opportunityId, opportunityId))
      .orderBy(asc(commercialOpportunityAppointments.startsAt), asc(commercialOpportunityAppointments.id)),
  ]);
  // Os próximos compromissos vêm primeiro; os que já passaram ficam depois, do mais recente ao mais antigo.
  const agora = Date.now();
  const futuros = compromissos.filter(c => c.startsAt.getTime() >= agora);
  const passados = compromissos.filter(c => c.startsAt.getTime() < agora).reverse();
  return { informacoes: oportunidade.informacoes, notas, tarefas, compromissos: [...futuros, ...passados] };
}
