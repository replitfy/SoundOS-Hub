import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger.js";

/**
 * Expansão de query para o RAG da Sofia.
 *
 * A busca da base de conhecimento é BM25 puro (tsvector): casa palavra com palavra.
 * Isso erra em sinônimo e paráfrase — "sonhos" não recupera "sono", "cura" não
 * recupera "terapia sonora". A metade vetorial do RRF resolveria isso, mas o proxy de
 * IA do Replit não expõe o endpoint de embeddings, então nenhum chunk tem vetor.
 *
 * Em vez de vetores, expandimos a pergunta em algumas formulações alternativas com um
 * modelo leve e rodamos um BM25 para cada uma. É complementar ao pgvector, não
 * concorrente: se um dia houver embeddings, os dois convivem.
 */

/**
 * Modelo da expansão — esta chamada entra no caminho crítico da resposta da Sofia.
 *
 * Não use `gpt-5-nano` aqui, apesar do nome sugerir que é o mais rápido: ele é um modelo
 * de raciocínio e gasta centenas de tokens de reasoning numa tarefa que não precisa
 * disso, levando ~5s e estourando o timeout abaixo. O `gpt-5.4-mini` responde em ~700ms
 * com zero tokens de reasoning.
 */
const EXPANSION_MODEL = "gpt-5.4-mini";

/** A expansão é um ganho opcional: se demorar, é melhor buscar sem ela do que travar a Sofia. */
const EXPANSION_TIMEOUT_MS = 3_000;

/** Quantas variações pedir, além da query original. */
const MAX_VARIANTS = 4;

const CACHE_TTL_MS = 10 * 60 * 1_000;
/** Teto de entradas: o cache vive no processo e a query vem do usuário final. */
const CACHE_MAX_ENTRIES = 500;

const cache = new Map<string, { variants: string[]; expiresAt: number }>();

/**
 * Expansões em andamento, por query normalizada.
 *
 * O cache sozinho só evita a segunda chamada depois que a primeira terminou. Como várias
 * conversas podem perguntar a mesma coisa ao mesmo tempo, sem isto cada uma dispararia
 * a sua própria chamada ao modelo antes de qualquer resposta chegar ao cache.
 */
const emAndamento = new Map<string, Promise<string[]>>();

const PROMPT = [
  "Você expande consultas de busca para um acervo em português sobre sound healing,",
  "terapia sonora, cursos e instrumentos musicais terapêuticos.",
  `Dada a consulta do usuário, devolva até ${MAX_VARIANTS} formulações alternativas que`,
  "usem sinônimos e termos relacionados que provavelmente aparecem nos documentos.",
  "Responda apenas com as alternativas separadas por | (barra vertical),",
  "sem numerar, sem aspas e sem explicação.",
].join(" ");

/**
 * Quebra a resposta do modelo em variações utilizáveis.
 *
 * Exportada para teste: é aqui que mora todo o comportamento frágil (o modelo às vezes
 * numera, usa aspas ou devolve uma frase só).
 */
export function parseExpansions(raw: string, original: string): string[] {
  const jaVistas = new Set([normalizar(original)]);
  const variantes: string[] = [];

  for (const parte of raw.split("|")) {
    // A ordem importa: as aspas só são reconhecidas nas pontas depois que o espaço em
    // volta some, senão `"banho de som" ` perde a aspa inicial e mantém a final.
    const limpa = parte
      .trim()
      .replace(/^[-*\d.)\]]+\s*/, "") // marcador de lista ou numeração
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .trim();

    if (limpa.length < 2 || limpa.length > 200) continue;

    const chave = normalizar(limpa);
    if (jaVistas.has(chave)) continue;
    jaVistas.add(chave);
    variantes.push(limpa);

    if (variantes.length >= MAX_VARIANTS) break;
  }

  return variantes;
}

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function limparCacheExpirado(agora: number): void {
  for (const [chave, entrada] of cache) {
    if (entrada.expiresAt <= agora) cache.delete(chave);
  }
  // Se ainda estiver cheio depois de expirar o que dava, descarta os mais antigos
  // (Map preserva ordem de inserção).
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const maisAntiga = cache.keys().next();
    if (maisAntiga.done) break;
    cache.delete(maisAntiga.value);
  }
}

/**
 * Devolve a query original seguida das variações geradas.
 *
 * Sempre inclui a original em primeiro lugar, e nunca lança: qualquer falha (timeout,
 * proxy fora do ar, resposta ininteligível) degrada para `[query]`, que é exatamente a
 * busca de palavra-chave que existia antes.
 */
export async function expandQuery(query: string): Promise<string[]> {
  const original = query.trim();
  if (!original) return [];

  const chave = normalizar(original);
  const agora = Date.now();

  const emCache = cache.get(chave);
  if (emCache && emCache.expiresAt > agora) {
    return [original, ...emCache.variants];
  }

  let pendente = emAndamento.get(chave);
  if (!pendente) {
    pendente = buscarVariacoes(original, chave).finally(() => emAndamento.delete(chave));
    emAndamento.set(chave, pendente);
  }

  return [original, ...(await pendente)];
}

async function buscarVariacoes(original: string, chave: string): Promise<string[]> {
  let variants: string[] = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXPANSION_TIMEOUT_MS);

  try {
    const resposta = await openai.chat.completions.create(
      {
        model: EXPANSION_MODEL,
        max_completion_tokens: 8192,
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: original },
        ],
      },
      { signal: controller.signal },
    );

    variants = parseExpansions(resposta.choices[0]?.message?.content ?? "", original);
  } catch (err) {
    // Degradação silenciosa é intencional, mas registrada: se a expansão parar de
    // funcionar, a busca continua respondendo e ninguém perceberia sem este log.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "expansão de query falhou; seguindo com busca simples",
    );
    variants = [];
  } finally {
    clearTimeout(timeout);
  }

  // A falha também é cacheada: se o proxy está fora, não adianta pagar 3s de espera a
  // cada mensagem da conversa.
  const agora = Date.now();
  limparCacheExpirado(agora);
  cache.set(chave, { variants, expiresAt: agora + CACHE_TTL_MS });

  return variants;
}

/** Apenas para teste — o cache é de processo e vazaria entre casos. */
export function _limparCacheExpansao(): void {
  cache.clear();
}
