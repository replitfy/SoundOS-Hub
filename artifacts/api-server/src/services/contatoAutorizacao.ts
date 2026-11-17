import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  pessoasTable,
  pessoaContatoRegistros,
  commercialOpportunities,
  usersTable,
  CONTATO_REGISTRO_KINDS,
  CONTATO_ORIGENS,
  type ContatoRegistroKind,
  type ContatoOrigem,
} from "@workspace/db";
import { OpportunityRuleError, type DbClient, type OpportunityActor } from "./commercialOpportunities";
import { exigirHumano, registrarAcao, travarCartoesAbertosDaPessoa, type AcaoDoCard } from "./crmAtendimento";

// Autorização de contato por pessoa. O registro é só de inserções (quem registrou, quando e de onde veio a
// autorização) e o estado atual é derivado dele: autorizada = existe um AUTORIZOU; "não quer receber" vale
// desde o último NAO_QUER_RECEBER até um NAO_QUER_RECEBER_DESFEITO posterior. "Não quer receber" sempre
// vence a autorização.

const NAMESPACE_TRAVA_CONTATO = 0x434f4e54;
const LIMITE_ORIGEM_TEXTO = 300;

export interface RegistroDeContato {
  id: number;
  kind: ContatoRegistroKind;
  origem: ContatoOrigem;
  origemTexto: string | null;
  /** Nulo quando o próprio sistema registrou (consentimento no formulário, pedido de parar na conversa). */
  registradoPorUserId: number | null;
  registradoPeloSistema: boolean;
  registradoPorNome: string | null;
  createdAt: Date;
}

export interface EstadoDeContato {
  autorizado: boolean;
  naoQuerReceber: boolean;
  /** Do mais recente para o mais antigo. */
  registros: RegistroDeContato[];
}

export function derivarEstadoDeContato(registros: ReadonlyArray<Pick<RegistroDeContato, "kind">>): { autorizado: boolean; naoQuerReceber: boolean } {
  // `registros` em ordem cronológica (do mais antigo ao mais recente).
  const autorizado = registros.some(r => r.kind === "AUTORIZOU");
  let naoQuerReceber = false;
  for (const registro of registros) {
    if (registro.kind === "NAO_QUER_RECEBER") naoQuerReceber = true;
    else if (registro.kind === "NAO_QUER_RECEBER_DESFEITO") naoQuerReceber = false;
  }
  return { autorizado, naoQuerReceber };
}

export async function carregarEstadoDeContato(pessoaId: number): Promise<EstadoDeContato> {
  const linhas = await db.select({
    id: pessoaContatoRegistros.id,
    kind: pessoaContatoRegistros.kind,
    origem: pessoaContatoRegistros.origem,
    origemTexto: pessoaContatoRegistros.origemTexto,
    registradoPorUserId: pessoaContatoRegistros.registradoPorUserId,
    registradoPeloSistema: pessoaContatoRegistros.registradoPeloSistema,
    registradoPorNome: usersTable.name,
    createdAt: pessoaContatoRegistros.createdAt,
  }).from(pessoaContatoRegistros)
    .leftJoin(usersTable, eq(usersTable.id, pessoaContatoRegistros.registradoPorUserId))
    .where(eq(pessoaContatoRegistros.pessoaId, pessoaId))
    .orderBy(asc(pessoaContatoRegistros.createdAt), asc(pessoaContatoRegistros.id));
  return { ...derivarEstadoDeContato(linhas), registros: [...linhas].reverse() };
}

/**
 * Executa `fn` com a trava de contato da pessoa (a mesma que o registro usa): enquanto um envio confere a
 * autorização e envia, ninguém grava um "não quer receber" no meio, e o contrário.
 */
export async function comTravaDeContato<T>(pessoaId: number, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let travou = false;
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [NAMESPACE_TRAVA_CONTATO, pessoaId]);
    travou = true;
    return await fn();
  } finally {
    try {
      if (travou) await client.query("SELECT pg_advisory_unlock($1, $2)", [NAMESPACE_TRAVA_CONTATO, pessoaId]);
      client.release();
    } catch {
      client.release(true);
    }
  }
}

const ACAO_DO_REGISTRO: Record<ContatoRegistroKind, AcaoDoCard> = {
  AUTORIZOU: "CONTACT_AUTHORIZED",
  NAO_QUER_RECEBER: "CONTACT_OPT_OUT",
  NAO_QUER_RECEBER_DESFEITO: "CONTACT_OPT_OUT_UNDONE",
};

/**
 * Registra uma autorização ou um "não quer receber" (ou o desfazer). Vale para a pessoa; o histórico recebe o
 * registro em todos os cartões abertos dela. Se `opportunityId` vier, ele precisa ser da pessoa e estar aberto.
 */
export async function registrarContato(input: {
  pessoaId: number;
  kind: unknown;
  origem: unknown;
  origemTexto?: unknown;
  actor: OpportunityActor;
  opportunityId?: number;
}): Promise<{ registro: RegistroDeContato | null; estado: EstadoDeContato }> {
  const autorId = exigirHumano(input.actor);
  if (typeof input.kind !== "string" || !(CONTATO_REGISTRO_KINDS as readonly string[]).includes(input.kind)) {
    throw new OpportunityRuleError("Tipo de registro inválido.", "INVALID_CONTACT_KIND", 422);
  }
  const kind = input.kind as ContatoRegistroKind;
  // Desfazer um "não quer receber" não tem origem a explicar; os outros registros dizem de onde veio.
  let origem: ContatoOrigem = "OUTRO";
  let origemTexto: string | null = null;
  if (kind !== "NAO_QUER_RECEBER_DESFEITO" || input.origem !== undefined) {
    if (typeof input.origem !== "string" || !(CONTATO_ORIGENS as readonly string[]).includes(input.origem)) {
      throw new OpportunityRuleError("Informe de onde veio a informação.", "INVALID_CONTACT_ORIGIN", 422);
    }
    origem = input.origem as ContatoOrigem;
    const texto = typeof input.origemTexto === "string" ? input.origemTexto.trim() : "";
    if (origem === "OUTRO" && !texto) {
      throw new OpportunityRuleError("Descreva a origem quando for \"outro\".", "ORIGIN_TEXT_REQUIRED", 422);
    }
    if (texto.length > LIMITE_ORIGEM_TEXTO) {
      throw new OpportunityRuleError(`A origem passa de ${LIMITE_ORIGEM_TEXTO} caracteres.`, "TEXT_TOO_LONG", 422);
    }
    origemTexto = texto || null;
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${NAMESPACE_TRAVA_CONTATO}, ${input.pessoaId})`);
    const [pessoa] = await tx.select({ id: pessoasTable.id, mergedInto: pessoasTable.mergedIntoPessoaId }).from(pessoasTable)
      .where(eq(pessoasTable.id, input.pessoaId)).limit(1);
    if (!pessoa) throw new OpportunityRuleError("Pessoa não encontrada.", "PERSON_NOT_FOUND", 404);
    if (pessoa.mergedInto !== null) {
      throw new OpportunityRuleError("Esta ficha foi unida a outra: registre na ficha que ficou.", "PERSON_MERGED", 409);
    }

    const idsAbertos = await travarCartoesAbertosDaPessoa(tx, input.pessoaId);
    if (input.opportunityId !== undefined) {
      if (!idsAbertos.includes(input.opportunityId)) {
        const [card] = await tx.select({ pessoaId: commercialOpportunities.pessoaId, stage: commercialOpportunities.stage })
          .from(commercialOpportunities).where(eq(commercialOpportunities.id, input.opportunityId)).limit(1);
        if (!card || card.pessoaId !== input.pessoaId) throw new OpportunityRuleError("Oportunidade não encontrada.", "NOT_FOUND", 404);
        throw new OpportunityRuleError("Oportunidade encerrada: só é possível reativá-la.", "OPPORTUNITY_CLOSED", 409);
      }
    }

    const atuais = await tx.select({ kind: pessoaContatoRegistros.kind }).from(pessoaContatoRegistros)
      .where(eq(pessoaContatoRegistros.pessoaId, input.pessoaId))
      .orderBy(asc(pessoaContatoRegistros.createdAt), asc(pessoaContatoRegistros.id));
    const estado = derivarEstadoDeContato(atuais);
    // Repetir o que já vale não cria um segundo registro.
    if (kind === "NAO_QUER_RECEBER" && estado.naoQuerReceber) return;
    if (kind === "AUTORIZOU" && estado.autorizado) return;
    if (kind === "NAO_QUER_RECEBER_DESFEITO" && !estado.naoQuerReceber) {
      throw new OpportunityRuleError("Esta pessoa não está marcada como \"não quer receber\".", "NOT_OPTED_OUT", 409);
    }

    const [registro] = await tx.insert(pessoaContatoRegistros)
      .values({ pessoaId: input.pessoaId, kind, origem, origemTexto, registradoPorUserId: autorId }).returning({ id: pessoaContatoRegistros.id });
    for (const id of idsAbertos) {
      await registrarAcao(tx, id, input.actor, ACAO_DO_REGISTRO[kind], { registroId: registro!.id, origem, origemTexto });
    }
  });

  const estado = await carregarEstadoDeContato(input.pessoaId);
  return { registro: estado.registros[0] ?? null, estado };
}

/**
 * Registro feito pelo próprio sistema, dentro de uma transação já aberta: o consentimento marcado no
 * formulário (AUTORIZOU, origem Formulário) ou o pedido de parar feito pela pessoa na conversa
 * (NAO_QUER_RECEBER, origem Conversa no WhatsApp). Sem usuário da equipe como autor.
 *
 * Toma a trava de contato da pessoa ANTES de qualquer trava de cartão (ordem contato → conversa →
 * oportunidade), por isso o formulário chama isto antes de abrir ou atualizar o cartão. Repetir o que
 * já vale não cria outro registro. Devolve se um registro novo foi gravado.
 */
export async function registrarContatoDoSistema(tx: DbClient, input: {
  pessoaId: number;
  kind: Exclude<ContatoRegistroKind, "NAO_QUER_RECEBER_DESFEITO">;
  origem: Extract<ContatoOrigem, "FORMULARIO" | "CONVERSA_WHATSAPP" | "OUTRO">;
  origemTexto: string;
  actor: OpportunityActor;
}): Promise<{ registrado: boolean; registroId: number | null }> {
  if (input.actor.kind === "HUMAN") {
    throw new OpportunityRuleError("Este registro é feito pelo sistema.", "SYSTEM_ACTOR_REQUIRED", 500);
  }
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${NAMESPACE_TRAVA_CONTATO}, ${input.pessoaId})`);
  const [pessoa] = await tx.select({ id: pessoasTable.id, mergedInto: pessoasTable.mergedIntoPessoaId }).from(pessoasTable)
    .where(eq(pessoasTable.id, input.pessoaId)).limit(1);
  if (!pessoa) throw new OpportunityRuleError("Pessoa não encontrada.", "PERSON_NOT_FOUND", 404);
  if (pessoa.mergedInto !== null) {
    throw new OpportunityRuleError("Esta ficha foi unida a outra: registre na ficha que ficou.", "PERSON_MERGED", 409);
  }
  const atuais = await tx.select({ kind: pessoaContatoRegistros.kind }).from(pessoaContatoRegistros)
    .where(eq(pessoaContatoRegistros.pessoaId, input.pessoaId))
    .orderBy(asc(pessoaContatoRegistros.createdAt), asc(pessoaContatoRegistros.id));
  const estado = derivarEstadoDeContato(atuais);
  if (input.kind === "NAO_QUER_RECEBER" && estado.naoQuerReceber) return { registrado: false, registroId: null };
  if (input.kind === "AUTORIZOU" && estado.autorizado) return { registrado: false, registroId: null };

  const idsAbertos = await travarCartoesAbertosDaPessoa(tx, input.pessoaId);
  const [registro] = await tx.insert(pessoaContatoRegistros).values({
    pessoaId: input.pessoaId, kind: input.kind, origem: input.origem, origemTexto: input.origemTexto,
    registradoPorUserId: null, registradoPeloSistema: true,
  }).returning({ id: pessoaContatoRegistros.id });
  for (const id of idsAbertos) {
    await registrarAcao(tx, id, input.actor, ACAO_DO_REGISTRO[input.kind], {
      registroId: registro!.id, origem: input.origem, origemTexto: input.origemTexto,
    });
  }
  return { registrado: true, registroId: registro!.id };
}

/** Cartões abertos da pessoa com status de contato "não quer receber". */
export async function pessoaTemCartaoSemContato(pessoaId: number): Promise<boolean> {
  const [linha] = await db.select({ id: commercialOpportunities.id }).from(commercialOpportunities)
    .where(and(eq(commercialOpportunities.pessoaId, pessoaId), eq(commercialOpportunities.contactStatus, "OPTED_OUT"), sql`${commercialOpportunities.stage} <> 'CLOSED'`))
    .limit(1);
  return Boolean(linha);
}
