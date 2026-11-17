/**
 * Leitura de erros do Postgres através dos invólucros do Drizzle.
 *
 * O Drizzle embrulha o erro do driver `pg` num `DrizzleQueryError`, então o
 * SQLSTATE não fica no erro que chega ao `catch` — ele fica em `cause`. Um
 * `err.code === "23503"` direto nunca casa, e a falha esperada (um 400/409, ou
 * uma nova tentativa) vira um 500 genérico. Por isso percorremos a cadeia de
 * causas em vez de olhar só o topo.
 */

const PROFUNDIDADE_MAX = 5;

function detalhePg(err: unknown): { code?: unknown; constraint?: unknown } | null {
  let atual: unknown = err;
  for (let i = 0; i < PROFUNDIDADE_MAX && typeof atual === "object" && atual !== null; i++) {
    const registro = atual as Record<string, unknown>;
    if (typeof registro["code"] === "string") return registro;
    atual = registro["cause"];
  }
  return null;
}

/** SQLSTATE 23503 — violação de chave estrangeira. */
export function isPgFkViolation(err: unknown): boolean {
  return detalhePg(err)?.code === "23503";
}

/**
 * SQLSTATE 23505 — violação de unicidade. Se `constraintContem` for informado,
 * só casa quando o nome da constraint contiver esse trecho, para distinguir
 * qual índice único falhou.
 */
export function isPgUniqueViolation(err: unknown, constraintContem?: string): boolean {
  const detalhe = detalhePg(err);
  if (detalhe?.code !== "23505") return false;
  if (constraintContem === undefined) return true;
  return typeof detalhe["constraint"] === "string" && detalhe["constraint"].includes(constraintContem);
}
