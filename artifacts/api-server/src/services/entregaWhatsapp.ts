import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { canalEnvios, db, habllaEventos, type CanalEnvioStatus } from "@workspace/db";
import { interpretarEventoWhatsapp, type EsperadoWhatsapp, type StatusDeEntrega } from "./habllaEventoWhatsapp";

// Estado de entrega de cada parte enviada pelo WhatsApp. A ordem é aceito → enviado → entregue → lido.
// A atualização é condicional no próprio UPDATE: eventos fora de ordem (ou repetidos, ou simultâneos)
// nunca fazem o estado andar para trás — "lido" não volta a "entregue". "falhou" é final: só sai de
// aceito/enviado, e nada o substitui depois.

const ESTADO_DO_STATUS: Record<StatusDeEntrega, CanalEnvioStatus> = {
  sent: "enviado", delivered: "entregue", read: "lido", failed: "falhou",
};

/** Estados dos quais cada novo estado pode partir. */
const PODE_PARTIR_DE: Record<CanalEnvioStatus, CanalEnvioStatus[]> = {
  aceito: [],
  enviado: ["aceito"],
  entregue: ["aceito", "enviado"],
  lido: ["aceito", "enviado", "entregue"],
  falhou: ["aceito", "enviado"],
};

export type ResultadoEntrega =
  | { resultado: "atualizado"; estado: CanalEnvioStatus; ligouIdDaMeta?: string | null }
  | { resultado: "sem_mudanca"; estado: CanalEnvioStatus; ligouIdDaMeta?: string | null }
  | { resultado: "desconhecido" };

async function acharEnvio(ids: { metaMessageId?: string | null; filaId?: string | null }) {
  const colunas = { id: canalEnvios.id, status: canalEnvios.status, metaMessageId: canalEnvios.metaMessageId, filaId: canalEnvios.filaId };
  if (ids.metaMessageId) {
    const [porMeta] = await db.select(colunas).from(canalEnvios)
      .where(and(eq(canalEnvios.canal, "whatsapp"), eq(canalEnvios.metaMessageId, ids.metaMessageId))).limit(1);
    if (porMeta) return porMeta;
  }
  if (ids.filaId) {
    const [porFila] = await db.select(colunas).from(canalEnvios)
      .where(and(eq(canalEnvios.canal, "whatsapp"), eq(canalEnvios.filaId, ids.filaId))).limit(1);
    if (porFila) return porFila;
  }
  return null;
}

/** Aplica um evento de status (sent/delivered/read/failed) ao envio com aquele id da Meta. Id desconhecido: nada muda. */
export async function registrarStatusDeEntrega(evento: {
  status: StatusDeEntrega;
  metaMessageId: string;
  filaId: string | null;
  erro: string | null;
}): Promise<ResultadoEntrega> {
  const envio = await acharEnvio(evento);
  if (!envio) return { resultado: "desconhecido" };

  const novo = ESTADO_DO_STATUS[evento.status];
  const agora = new Date();
  const atualizadas = await db.update(canalEnvios)
    .set({
      status: novo,
      entregaAtualizadaEm: agora,
      metaMessageId: envio.metaMessageId ?? evento.metaMessageId,
      ...(novo === "falhou" ? { erro: (evento.erro ?? "O WhatsApp não entregou a mensagem.").slice(0, 500) } : {}),
    })
    .where(and(eq(canalEnvios.id, envio.id), inArray(canalEnvios.status, PODE_PARTIR_DE[novo])))
    .returning({ id: canalEnvios.id });
  // Quando este evento trouxe o id da Meta pela primeira vez, os outros eventos desse id que chegaram
  // antes (sem envio para ligar) precisam ser reprocessados: `ligouIdDaMeta` avisa quem chamou.
  const ligou = envio.metaMessageId ? null : envio.filaId;
  if (atualizadas.length > 0) return { resultado: "atualizado", estado: novo, ligouIdDaMeta: ligou };

  // Sem mudança (repetido ou fora de ordem): ainda completa o id da Meta, se faltava.
  if (!envio.metaMessageId) {
    await db.update(canalEnvios).set({ metaMessageId: evento.metaMessageId })
      .where(and(eq(canalEnvios.id, envio.id), sql`${canalEnvios.metaMessageId} IS NULL`));
  }
  const [atual] = await db.select({ status: canalEnvios.status }).from(canalEnvios).where(eq(canalEnvios.id, envio.id)).limit(1);
  return { resultado: "sem_mudanca", estado: atual?.status ?? envio.status, ligouIdDaMeta: ligou };
}

/**
 * Resultado do envio na fila do Hablla: liga o id da fila ao id da mensagem na Meta (para os eventos de
 * status acharem o envio) e registra a recusa quando a fila não conseguiu enviar.
 */
export async function registrarResultadoDeEnvio(evento: {
  filaId: string;
  metaMessageId: string | null;
  sucesso: boolean;
  erro: string | null;
}): Promise<ResultadoEntrega> {
  const envio = await acharEnvio({ filaId: evento.filaId });
  if (!envio) return { resultado: "desconhecido" };

  if (evento.sucesso) {
    if (evento.metaMessageId && !envio.metaMessageId) {
      await db.update(canalEnvios).set({ metaMessageId: evento.metaMessageId })
        .where(and(eq(canalEnvios.id, envio.id), sql`${canalEnvios.metaMessageId} IS NULL`));
      return { resultado: "atualizado", estado: envio.status, ligouIdDaMeta: envio.filaId };
    }
    return { resultado: "sem_mudanca", estado: envio.status };
  }

  const atualizadas = await db.update(canalEnvios)
    .set({
      status: "falhou",
      entregaAtualizadaEm: new Date(),
      erro: (evento.erro ?? "O Hablla não conseguiu enviar a mensagem.").slice(0, 500),
    })
    .where(and(eq(canalEnvios.id, envio.id), inArray(canalEnvios.status, PODE_PARTIR_DE.falhou)))
    .returning({ id: canalEnvios.id });
  return atualizadas.length > 0
    ? { resultado: "atualizado", estado: "falhou" }
    : { resultado: "sem_mudanca", estado: envio.status };
}

// ---------------------------------------------------------------------------------------------
// Reconciliação. Os avisos do Hablla/Meta chegam em paralelo ao envio: um status pode vir antes de o
// resultado do envio ligar o id da fila ao id da Meta, e qualquer aviso pode vir antes de o registro do
// envio ser gravado. Esses eventos já estão guardados em hablla_eventos (com motivo `envio_desconhecido`);
// quando o vínculo aparece, eles são aplicados de novo, na ordem de chegada. Aplicar é idempotente e
// nunca regride o estado, então reprocessar um evento que já tinha sido aplicado não muda nada.
// ---------------------------------------------------------------------------------------------

const JANELA_DE_PENDENTES_MS = 3 * 24 * 60 * 60 * 1000;
const MAXIMO_DE_PENDENTES = 500;

function escaparLike(valor: string): string {
  return valor.replace(/[\\%_]/g, "\\$&");
}

/**
 * Troca o motivo de um evento que tinha ficado sem envio. Eventos ainda em processamento não são
 * tocados: o próprio processamento registra o desfecho deles.
 */
async function marcarReconciliado(eventoId: number, estado: CanalEnvioStatus): Promise<void> {
  await db.update(habllaEventos)
    .set({ motivo: `reconciliado:${estado}`, processadoEm: new Date() })
    .where(and(eq(habllaEventos.id, eventoId), eq(habllaEventos.status, "ignorado"), eq(habllaEventos.motivo, "envio_desconhecido")));
}

/**
 * Reaplica os resultados de envio e os status guardados que pertencem ao envio com este id de fila.
 * Devolve quantos eventos foram aplicados. Chamada quando o envio é gravado e quando um evento liga o
 * id da fila ao id da Meta.
 */
export async function reconciliarEntrega(filaId: string, esperado: EsperadoWhatsapp): Promise<number> {
  let aplicados = 0;

  const resultados = await db.select({ id: habllaEventos.id, payload: habllaEventos.payload }).from(habllaEventos)
    .where(and(eq(habllaEventos.canal, "whatsapp"), like(habllaEventos.externoId, `whatsapp:envio:${escaparLike(filaId)}:%`)))
    .orderBy(asc(habllaEventos.id));
  for (const guardado of resultados) {
    const evento = interpretarEventoWhatsapp(guardado.payload, esperado);
    if (evento.tipo !== "resultado_envio") continue;
    const efeito = await registrarResultadoDeEnvio(evento);
    if (efeito.resultado === "desconhecido") continue;
    await marcarReconciliado(guardado.id, efeito.estado);
    aplicados += 1;
  }

  const envio = await acharEnvio({ filaId });
  if (!envio) return aplicados;

  // Status que ainda não acharam envio, ou que estavam em processamento durante a ligação.
  const desde = new Date(Date.now() - JANELA_DE_PENDENTES_MS);
  const pendentes = await db.select({ id: habllaEventos.id, payload: habllaEventos.payload }).from(habllaEventos)
    .where(and(
      eq(habllaEventos.canal, "whatsapp"),
      like(habllaEventos.externoId, "whatsapp:status:%"),
      sql`${habllaEventos.createdAt} > ${desde}`,
      or(eq(habllaEventos.status, "recebido"), and(eq(habllaEventos.status, "ignorado"), eq(habllaEventos.motivo, "envio_desconhecido"))),
    ))
    .orderBy(desc(habllaEventos.id))
    .limit(MAXIMO_DE_PENDENTES);
  for (const guardado of pendentes.reverse()) {
    const evento = interpretarEventoWhatsapp(guardado.payload, esperado);
    if (evento.tipo !== "status") continue;
    const daqui = evento.filaId === filaId || (envio.metaMessageId !== null && evento.metaMessageId === envio.metaMessageId);
    if (!daqui) continue;
    const efeito = await registrarStatusDeEntrega(evento);
    if (efeito.resultado === "desconhecido") continue;
    await marcarReconciliado(guardado.id, efeito.estado);
    aplicados += 1;
    // Um status com a fila e o id da Meta pode ter ligado o envio agora: o próximo da lista já o encontra.
    if (!envio.metaMessageId) envio.metaMessageId = evento.metaMessageId;
  }
  return aplicados;
}
