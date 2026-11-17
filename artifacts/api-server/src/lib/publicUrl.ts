/**
 * Endereço público do SoundOS, usado para montar links que a Sofia envia às
 * pessoas (ex.: o cadastro de interesse de um evento).
 *
 * Ordem: `PUBLIC_APP_URL` (override explícito) → `REPLIT_DOMAINS` → nada.
 * Sem endereço conhecido devolve `null`: quem chama não pode inventar link.
 *
 * Em produção `REPLIT_DOMAINS` lista todos os domínios publicados (inclusive o
 * próprio, se houver); em desenvolvimento traz só o domínio temporário. Por
 * isso preferimos um domínio que não termine em `.replit.app/.replit.dev/.repl.co`.
 */

const DOMINIOS_TEMPORARIOS = /\.(?:replit\.app|replit\.dev|repl\.co)$/i;

function comoOrigem(valor: string): string | null {
  const texto = valor.trim();
  if (!texto) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(texto) ? texto : `https://${texto}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

export function publicAppBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const configurado = env.PUBLIC_APP_URL ? comoOrigem(env.PUBLIC_APP_URL) : null;
  if (configurado) return configurado;
  const dominios = (env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map(dominio => dominio.trim())
    .filter(Boolean);
  const proprio = dominios.find(dominio => !DOMINIOS_TEMPORARIOS.test(dominio));
  return comoOrigem(proprio ?? dominios[0] ?? "");
}
