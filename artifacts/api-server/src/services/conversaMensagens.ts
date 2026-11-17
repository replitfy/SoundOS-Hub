import { asc, eq, type SQL } from "drizzle-orm";
import { db, messages, canalEnvios, usersTable, type CanalEnvioStatus } from "@workspace/db";
import { traduzirErroDeEnvio } from "./metaErros";
import { anexosDaConversa } from "./anexosAcesso";

/** Estágios da entrega, do pior para o melhor. */
const ESTAGIO: Record<string, number> = { falhou: -1, aceito: 0, enviado: 1, entregue: 2, lido: 3 };

export interface EntregaDaMensagem { status: CanalEnvioStatus; erro: string | null }

/** Entrega por mensagem a partir dos envios que casam com `condicao`. */
export async function entregaDasMensagens(condicao: SQL): Promise<Map<number, EntregaDaMensagem>> {
  const envios = await db.select({ messageId: canalEnvios.messageId, status: canalEnvios.status, erro: canalEnvios.erro })
    .from(canalEnvios)
    .where(condicao)
    .orderBy(asc(canalEnvios.id));
  const entregaPorMensagem = new Map<number, EntregaDaMensagem>();
  for (const envio of envios) {
    if (envio.messageId === null) continue;
    const atual = entregaPorMensagem.get(envio.messageId);
    // A pior parte vale: falhou vence tudo; entre as demais, a menos adiantada.
    if (!atual || (atual.status !== "falhou" && ESTAGIO[envio.status]! < ESTAGIO[atual.status]!)) {
      entregaPorMensagem.set(envio.messageId, { status: envio.status, erro: envio.erro });
    }
  }
  return entregaPorMensagem;
}

/**
 * Mensagens de uma conversa com a entrega em canal externo e o autor da equipe (quando há).
 * Entrega por mensagem: "falhou" se qualquer parte falhou; senão, o estágio mais atrasado entre as partes
 * (aceito < enviado < entregue < lido).
 */
export async function listarMensagensDaConversa(conversationId: number) {
  const mensagens = await db.select({
    id: messages.id, conversationId: messages.conversationId, role: messages.role, content: messages.content,
    conduta: messages.conduta, authorUserId: messages.authorUserId, authorName: usersTable.name, kind: messages.kind,
    createdAt: messages.createdAt,
  }).from(messages)
    .leftJoin(usersTable, eq(usersTable.id, messages.authorUserId))
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  const entregaPorMensagem = await entregaDasMensagens(eq(canalEnvios.conversationId, conversationId));
  const anexos = await anexosDaConversa(conversationId);

  return mensagens.map(m => ({
    ...m,
    anexo: anexos.get(m.id) ?? null,
    envioStatus: entregaPorMensagem.get(m.id)?.status ?? null,
    envioErro: traduzirErroDeEnvio(entregaPorMensagem.get(m.id)?.erro ?? null),
  }));
}
