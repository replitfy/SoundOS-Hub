import { pool } from "@workspace/db";

/**
 * Trava por conversa compartilhada entre o chat do SoundOS e os canais externos:
 * duas respostas da Sofia nunca rodam ao mesmo tempo na mesma conversa.
 */
export const SOFIA_CONVERSATION_LOCK_NAMESPACE = 0x534f4649;

const ESPERA_PADRAO_MS = 120_000;
const INTERVALO_MS = 250;

export class ConversaOcupadaErro extends Error {
  constructor(conversationId: number) {
    super(`Conversa ${conversationId} ocupada por outra resposta da Sofia.`);
    this.name = "ConversaOcupadaErro";
  }
}

/**
 * Executa `fn` com a trava da conversa. Espera a vez (várias mensagens seguidas do
 * mesmo contato entram em fila, na ordem em que a trava é liberada) até `esperaMs`.
 */
export async function comTravaDaConversa<T>(
  conversationId: number,
  fn: () => Promise<T>,
  esperaMs = ESPERA_PADRAO_MS,
): Promise<T> {
  const limite = Date.now() + esperaMs;
  for (;;) {
    const client = await pool.connect();
    let adquirida = false;
    try {
      const r = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired",
        [SOFIA_CONVERSATION_LOCK_NAMESPACE, conversationId],
      );
      adquirida = Boolean(r.rows[0]?.acquired);
      if (!adquirida) {
        client.release();
      } else {
        try {
          return await fn();
        } finally {
          try {
            await client.query("SELECT pg_advisory_unlock($1, $2)", [SOFIA_CONVERSATION_LOCK_NAMESPACE, conversationId]);
            client.release();
          } catch {
            client.release(true);
          }
        }
      }
    } catch (error) {
      if (!adquirida) client.release(true);
      throw error;
    }
    if (Date.now() >= limite) throw new ConversaOcupadaErro(conversationId);
    await new Promise(resolve => setTimeout(resolve, INTERVALO_MS));
  }
}
