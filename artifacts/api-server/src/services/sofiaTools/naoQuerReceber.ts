import { eq } from "drizzle-orm";
import { conversations, db } from "@workspace/db";
import { logger } from "../../lib/logger";
import { registrarContatoDoSistema } from "../contatoAutorizacao";

/**
 * A pessoa pediu, na conversa, para não receber mais mensagens. Quem decide que foi um pedido é o modelo,
 * por chamada de ferramenta (nada de palavra-chave): "pare", "me tira da lista" e variações. O registro vale
 * para a pessoa toda, vai para o histórico dos cartões abertos e bloqueia qualquer envio automático ou
 * manual de modelo. A Sofia se despede em uma frase e não oferece mais nada.
 */
export async function registrarNaoQuerReceber(input: { pessoaId: number | null; conversationId: number }): Promise<Record<string, unknown>> {
  const despedida = "Despeça-se em UMA frase curta e respeitosa, confirmando que ela não receberá mais mensagens da Soundfulness. Não ofereça nada, não faça perguntas e não tente convencê-la.";
  if (input.pessoaId === null) {
    // Sem ficha não há onde registrar o pedido; a despedida vale e a equipe vê a conversa.
    logger.warn({ conversationId: input.conversationId }, "sofia: pedido para parar de receber em conversa sem ficha");
    return { ok: true, registrado: false, instrucao: despedida };
  }
  const [conversa] = await db.select({ canal: conversations.canal }).from(conversations).where(eq(conversations.id, input.conversationId)).limit(1);
  const whatsapp = conversa?.canal === "whatsapp";
  const { registrado } = await db.transaction(tx => registrarContatoDoSistema(tx, {
    pessoaId: input.pessoaId!,
    kind: "NAO_QUER_RECEBER",
    origem: whatsapp ? "CONVERSA_WHATSAPP" : "OUTRO",
    origemTexto: whatsapp
      ? "A própria pessoa pediu para parar de receber mensagens, na conversa do WhatsApp com a Sofia."
      : "A própria pessoa pediu para parar de receber mensagens, na conversa com a Sofia.",
    actor: { kind: "SOFIA" },
  }));
  return { ok: true, registrado, instrucao: despedida };
}
