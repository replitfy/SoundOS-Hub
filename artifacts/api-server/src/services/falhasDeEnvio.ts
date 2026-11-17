import { and, desc, eq, ne, sql } from "drizzle-orm";
import { canalEnvios, conversations, db } from "@workspace/db";
import { codigoDaFalhaGuardada } from "./metaErros";

// Falhas de envio derivadas dos envios já registrados em canal_envios (sem estado nem tabela de aviso).
// "A última resposta falhou" vale para a conversa até um envio seguinte ser registrado: o aviso some sozinho.
// A resposta pode ter várias partes; a Meta pode recusar uma parte minutos depois de aceitar as seguintes,
// então a resposta conta como falha se o último envio ou qualquer parte da mesma mensagem falhou.

/**
 * Condição SQL: a última resposta da conversa não foi entregue. Correlacionada com `conversations`
 * (nomes literais: colunas interpoladas perderiam a qualificação da tabela dentro da subconsulta).
 */
export const ULTIMO_ENVIO_FALHOU = sql`COALESCE((
  SELECT u.status = 'falhou' OR (u.message_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM canal_envios f
    WHERE f.conversation_id = conversations.id AND f.message_id = u.message_id AND f.status = 'falhou'
  ))
  FROM (
    SELECT status, message_id FROM canal_envios
    WHERE conversation_id = conversations.id
    ORDER BY created_at DESC, id DESC LIMIT 1
  ) u
), false)`;

/** Conversas de canais externos cuja última resposta não foi entregue. O chat interno não conta. */
export async function contarRespostasNaoEntregues(): Promise<number> {
  const [linha] = await db.select({ total: sql<number>`COUNT(*)::int` }).from(conversations)
    .where(and(eq(conversations.hidden, false), ne(conversations.canal, "interno"), ULTIMO_ENVIO_FALHOU));
  return linha?.total ?? 0;
}

export interface UltimaFalhaDeEnvio {
  falhouEm: string;
  /** Código da Meta quando o erro guardado traz um; nulo caso contrário. Nunca o texto do provedor. */
  codigo: number | null;
}

/**
 * Se o envio mais recente do WhatsApp (de qualquer conversa) falhou, quando e com qual código da Meta.
 * Só o código e a data saem daqui: texto do provedor, telefone e conteúdo de mensagem ficam de fora.
 */
export async function ultimaFalhaDeEnvioDoWhatsapp(): Promise<UltimaFalhaDeEnvio | null> {
  const colunas = { status: canalEnvios.status, erro: canalEnvios.erro, createdAt: canalEnvios.createdAt, entregaAtualizadaEm: canalEnvios.entregaAtualizadaEm };
  const [ultimo] = await db.select({ ...colunas, conversationId: canalEnvios.conversationId, messageId: canalEnvios.messageId })
    .from(canalEnvios).where(eq(canalEnvios.canal, "whatsapp"))
    .orderBy(desc(canalEnvios.createdAt), desc(canalEnvios.id)).limit(1);
  if (!ultimo) return null;

  let falha: typeof ultimo | undefined = ultimo.status === "falhou" ? ultimo : undefined;
  if (!falha && ultimo.messageId !== null) {
    [falha] = await db.select({ ...colunas, conversationId: canalEnvios.conversationId, messageId: canalEnvios.messageId })
      .from(canalEnvios)
      .where(and(eq(canalEnvios.canal, "whatsapp"), eq(canalEnvios.conversationId, ultimo.conversationId), eq(canalEnvios.messageId, ultimo.messageId), eq(canalEnvios.status, "falhou")))
      .orderBy(desc(canalEnvios.createdAt), desc(canalEnvios.id)).limit(1);
  }
  if (!falha) return null;
  return { falhouEm: (falha.entregaAtualizadaEm ?? falha.createdAt).toISOString(), codigo: codigoDaFalhaGuardada(falha.erro) };
}
