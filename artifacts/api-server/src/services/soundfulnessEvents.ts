import type { OfficialEventSnapshot } from "./officialEventAgenda";

const SITE_ORIGIN = "https://www.soundfulness.online";
export const EVENTS_INDEX_URL = `${SITE_ORIGIN}/`;
export const EVENT_SYNC_TAG = "soundfulness-event-auto";
export const EVENT_ABSENCE_PREFIX = "soundfulness-event-absent-since:";
export const EVENT_ABSENCE_CONFIRMATION_MS = 5 * 60 * 60 * 1_000;

export interface EventDocument {
  title: string;
  sourceUrl: string;
  markdown: string;
  event: OfficialEventSnapshot;
}

export interface EventCrawlResult {
  documents: EventDocument[];
  discoveredUrls: string[];
  failures: Array<{ url: string; error: string }>;
}

export interface SyncedEventKnowledgeState {
  id: number;
  sourceUrl: string | null;
  errorMessage: string | null;
}

export interface EventAbsencePlan {
  firstMissingIds: number[];
  confirmedMissingIds: number[];
  confirmedMissingSourceUrls: string[];
}

export function hasCompleteEnoughEventSnapshot(
  previousCount: number,
  discoveredCount: number,
  failureCount: number,
): boolean {
  if (failureCount > 0 || discoveredCount === 0) return false;
  if (previousCount === 0) return true;
  // Process at most one disappearance at a time. Losing two or more links in
  // one crawl is indistinguishable from a truncated Wix section, so the last
  // valid snapshot must remain intact until an operator can inspect it.
  return discoveredCount >= Math.max(1, previousCount - 1);
}

export function eventAbsenceErrorMessage(now: Date): string {
  return `${EVENT_ABSENCE_PREFIX}${now.toISOString()}`;
}

export function planEventAbsenceConfirmation(input: {
  previousItems: SyncedEventKnowledgeState[];
  discoveredUrls: string[];
  snapshotComplete: boolean;
  now: Date;
}): EventAbsencePlan {
  if (!input.snapshotComplete) {
    return { firstMissingIds: [], confirmedMissingIds: [], confirmedMissingSourceUrls: [] };
  }
  const liveUrls = new Set(input.discoveredUrls);
  const firstMissingIds: number[] = [];
  const confirmedMissingIds: number[] = [];
  const confirmedMissingSourceUrls: string[] = [];

  for (const item of input.previousItems) {
    if (!item.sourceUrl || liveUrls.has(item.sourceUrl)) continue;
    const missingSince = item.errorMessage?.startsWith(EVENT_ABSENCE_PREFIX)
      ? Date.parse(item.errorMessage.slice(EVENT_ABSENCE_PREFIX.length))
      : Number.NaN;
    if (Number.isFinite(missingSince)
      && input.now.getTime() - missingSince >= EVENT_ABSENCE_CONFIRMATION_MS) {
      confirmedMissingIds.push(item.id);
      confirmedMissingSourceUrls.push(item.sourceUrl);
    } else if (!Number.isFinite(missingSince)) {
      firstMissingIds.push(item.id);
    }
  }

  return { firstMissingIds, confirmedMissingIds, confirmedMissingSourceUrls };
}

export function isDirectInformationalQuestion(message: string): boolean {
  const text = message.trim().toLocaleLowerCase("pt-BR");
  if (!text) return false;

  const hasSubject =
    /\b(vídeo|video|vídeos|videos|evento|eventos|curso|cursos|produto|produtos|instrumento|instrumentos|ciclo (?:ar|água|agua|fogo|terra)|retiro|imers[aã]o|forma[çc][aã]o|sound healing|massagem sonora|taketina|cacau|gong|tigela|diapas[aã]o)\b/i.test(text);
  if (!hasSubject) return false;

  const asksForFacts =
    /\b(quando|onde|qual(?: é| o| a)? (?:data|local|endere[çc]o|hor[aá]rio|dura[çc][aã]o|programa[çc][aã]o|conte[uú]do|formato|valor|pre[çc]o|link|requisito|pr[eé]-?requisito|certifica[çc][aã]o)|quais (?:s[aã]o )?(?:as )?(?:datas|locais|hor[aá]rios|conte[uú]dos|formatos|requisitos|pr[eé]-?requisitos|detalhes)|como funciona|o que (?:est[aá] )?(?:é|e|inclu[ií]do|inclui|tem)|tem (?:data|certificado|certifica[çc][aã]o)|data|datas|local|endere[çc]o|hor[aá]rio|dura[çc][aã]o|programa[çc][aã]o|conte[uú]do|formato|valor|pre[çc]o|quanto custa|link|detalhes|informa[çc][oõ]es|requisitos?|pr[eé]-?requisitos?|certificado|certifica[çc][aã]o|me fale|conte mais|explique)\b/i.test(text);
  const asksForVideo =
    /\b(vídeo|video|vídeos|videos)\b/i.test(text) &&
    (/\b(tem|teria|há|ha|existe|algum|alguma|quero|gostaria|manda|mande|envia|envie|compartilha|compartilhe|assistir|ver|entender|conhecer|exemplo)\b/i.test(text)
      || /\b(?:vídeo|video|vídeos|videos)(?:\s+[\p{L}\p{N}_-]+){0,3}\s+(?:de|do|da|dos|das|sobre|para)\s+\S+/iu.test(text));
  const asksForTransaction =
    /\b(quero (?:comprar|fechar|contratar|me inscrever)|como (?:fa[çc]o para|eu) (?:pagar|comprar|fechar|me inscrever)|finalizar (?:a )?compra)\b/i.test(text);
  const asksForPersonalRecommendation =
    /\b(recomenda|recomendaria|indicado|indicada|ideal|adequado|adequada|serve para mim|para o meu perfil|combina comigo|qual devo escolher|qual deveria escolher)\b/i.test(text);

  return (asksForFacts || asksForVideo) && !asksForTransaction && !asksForPersonalRecommendation;
}

export function hasExplicitStoreProductIntent(message: string): boolean {
  return /\b(produto|sku|loja|store|p[áa]gina do produto|link de compra|instrumento|tigela|diapas[ãa]o|tambor|gong|marimba|caj[oó]n)\b/i
    .test(message);
}

export const GENERAL_STORE_CATALOG_ANSWER =
  "Vendemos produtos de sound healing, musicoterapia e instrumentos que têm o poder transformador do som. Todos os nossos instrumentos são vibracionais.";

export function isGeneralStoreCatalogQuestion(message: string): boolean {
  const text = message.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
  if (/\b(preco|valor|quanto custa|link|pagina|url|sku|disponibilidade|disponivel|estoque)\b/.test(text)) {
    return false;
  }
  const asksAboutProductTypes =
    /\b(?:quais?|que tipos? de)\s+produtos?\b/.test(text) &&
    /\b(?:vende|vendem|oferece|oferecem|tem)\b/.test(text);
  const asksWhatStoreSells =
    /\bo que\b.*\b(?:vende|vendem|oferece|oferecem|tem)\b/.test(text) &&
    /\b(?:loja|soundfulness)\b/.test(text);
  return asksAboutProductTypes || asksWhatStoreSells;
}

export function isCatalogProductFactRequest(message: string): boolean {
  if (!hasExplicitStoreProductIntent(message)) return false;
  const advisory =
    /\b(recomenda|recomendaria|indicado|indicada|adequado|adequada|ideal|serve para mim|para o meu perfil|combina comigo|qual devo escolher|melhor para mim)\b/i
      .test(message);
  const transactional =
    /\b(quero (?:comprar|adquirir|contratar|fechar)|finalizar (?:a )?compra|como (?:fa[çc]o para|eu) (?:pagar|comprar|contratar|fechar)|checkout|pagar agora)\b/i
      .test(message);
  if (advisory || transactional) return false;
  return /\b(pre[çc]o|valor|quanto custa|link|p[áa]gina|sku|loja|store|disponibilidade|dispon[íi]vel|indispon[íi]vel|estoque|(?:voc[eê]s?\s+)?t[eê]m)\b/i
    .test(message);
}

export function isPotentialCatalogProductFactRequest(message: string): boolean {
  if (isCatalogProductFactRequest(message)) return true;
  const normalized = message.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
  const advisory =
    /\b(recomenda|recomendaria|indicado|indicada|adequado|adequada|ideal|serve para mim|para o meu perfil|combina comigo|qual devo escolher|melhor para mim)\b/i
      .test(message);
  const transactional =
    /\b(quero (?:comprar|adquirir|contratar|fechar)|finalizar (?:a )?compra|como (?:fa[çc]o para|eu) (?:pagar|comprar|contratar|fechar)|checkout|pagar agora)\b/i
      .test(message);
  const asksForCatalogFacts =
    /\b(pre[çc]o|valor|quanto custa|link|p[áa]gina|sku|disponibilidade|dispon[íi]vel|indispon[íi]vel|estoque)\b/i
      .test(message);
  if (advisory || transactional) return false;

  // Unknown identities cannot be discovered through a literal catalog match,
  // so recognize product-shaped lookup language independently of the known
  // catalog vocabulary. Explicit non-product domains remain outside this path.
  const explicitlyNonProduct =
    /\b(curso|evento|retiro|video|formacao|modulo|ciclo|aula|servico|atendimento|sessao|terapia|vaga|vagas|pessoa|contato|aluno|professor|instrutor)\b/.test(normalized);
  if (explicitlyNonProduct) return false;

  const asksStoreAvailability =
    /\b(?:voces?\s+)?(?:vendem?|tem|possuem?|oferecem?)\b/.test(normalized);
  const searchesForItem =
    /\b(?:estou\s+)?procurando\b/.test(normalized)
    || /\bprocuro\b/.test(normalized);
  const namesProduct =
    /\bproduto\b/.test(normalized)
    || /\b(?:voces?\s+)?(?:vendem?|tem|possuem?|oferecem?)\s+(?:o|a|um|uma)?\s*[a-z0-9]/.test(normalized)
    || /\b(?:estou\s+)?procurando\s+(?:o\s+|a\s+|um\s+|uma\s+)?(?:produto\s+)?[a-z0-9]/.test(normalized);

  const availabilityObject = message.match(
    /\b(?:voc[eê]s?\s+)?(?:t[eê]m|vendem?|possuem?|oferecem?)\s+(?:o\s+|a\s+|um\s+|uma\s+)?([^?!.]+)/i,
  )?.[1]?.trim();
  const looksLikeBarePersonName = Boolean(
    availabilityObject
    && !asksForCatalogFacts
    && !/\b(produto|bluetooth|el[eé]trico|kit|instrumento|modelo|sku)\b/i.test(availabilityObject)
    && (
      /^[\p{Lu}][\p{Ll}]+(?:\s+[\p{Lu}][\p{Ll}]+)$/u.test(availabilityObject)
      || /^\p{L}+\s+(?:da|de|do|dos|das)\s+\p{L}+$/iu.test(availabilityObject)
    )
  );
  if (looksLikeBarePersonName) return false;
  const bareAvailabilityTokens = availabilityObject?.split(/\s+/).filter(Boolean) ?? [];
  const hasExplicitProductContext =
    /\b(produto|bluetooth|el[eé]trico|kit|instrumento|modelo|sku)\b/i.test(message)
    || hasExplicitStoreProductIntent(message);
  if (
    asksStoreAvailability &&
    !asksForCatalogFacts &&
    !searchesForItem &&
    !hasExplicitProductContext &&
    bareAvailabilityTokens.length <= 2
  ) {
    return false;
  }

  return namesProduct && (asksForCatalogFacts || asksStoreAvailability || searchesForItem);
}

/**
 * Permite consultar silenciosamente um nome curto no catálogo para descobrir
 * um match literal conhecido, sem transformar a ausência em alegação de que
 * uma pessoa/termo ambíguo seria um produto inexistente.
 */
export function isBareCatalogAvailabilityProbe(message: string): boolean {
  const normalized = message.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
  if (/\b(curso|evento|retiro|video|formacao|modulo|ciclo|aula|servico|atendimento|sessao|terapia|vaga|vagas)\b/.test(normalized)) {
    return false;
  }
  return /\b(?:voces?\s+)?(?:tem|vendem?|possuem?|oferecem?)\s+(?:o\s+|a\s+|um\s+|uma\s+)?[^?!.]+\??$/.test(normalized.trim());
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function plainText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/section)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function absoluteSoundfulnessUrl(rawHref: string): string | null {
  try {
    const url = new URL(decodeHtml(rawHref), SITE_ORIGIN);
    if (url.origin !== SITE_ORIGIN) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function discoverUpcomingEventUrls(homeHtml: string): string[] {
  const marker = homeHtml.search(/(?:Pr[oó]ximos Eventos|proximos-eventos)/i);
  if (marker < 0) return [];

  // Wix renders the event repeater immediately after its accessible section
  // marker. Limit the scan so unrelated course/navigation links are not treated
  // as current events.
  const section = homeHtml.slice(marker, marker + 450_000);
  const urls = new Set<string>();
  // Wix can expose the event URL as the card href or nested inside a social
  // sharing href. Inspect complete hrefs first so an unrelated external URL
  // containing "/event-details/" cannot be mistaken for this site.
  const hrefPattern = /href=["']([^"']+)["']/gi;
  for (const match of section.matchAll(hrefPattern)) {
    const href = decodeHtml(match[1] ?? "");
    const embedded = href.match(/https?:\/\/www\.soundfulness\.online\/event-details\/[a-z0-9._~%+-]+(?:\?lang=[a-z-]+)?/i)?.[0];
    const candidate = href.startsWith("/event-details/") ? href : embedded;
    if (!candidate) continue;
    const url = absoluteSoundfulnessUrl(candidate);
    if (url) urls.add(url);
  }
  return [...urls];
}

function titleFromHtml(html: string, url: string): string {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const og = html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i)?.[1];
  const title = plainText(h1 ?? og ?? "");
  if (title) return title.replace(/\s*[|–-]\s*Soundfulness.*$/i, "").trim();
  return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "Evento Soundfulness")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function calendarDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/)?.[1] ?? null;
}

function jsonLdEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(jsonLdEntries);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  return [object, ...jsonLdEntries(object["@graph"])];
}

function isEventType(value: unknown): boolean {
  return value === "Event" || Array.isArray(value) && value.includes("Event");
}

function formattedAddress(value: unknown): string | null {
  if (typeof value === "string") return decodeHtml(value).trim() || null;
  if (!value || typeof value !== "object") return null;
  const address = value as Record<string, unknown>;
  const parts = [
    address.streetAddress,
    address.addressLocality,
    address.addressRegion,
    address.postalCode,
    address.addressCountry,
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

function extractStructuredEvent(html: string, sourceUrl: string): OfficialEventSnapshot {
  const entries: unknown[] = [];
  const pattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      entries.push(...jsonLdEntries(JSON.parse(match[1] ?? "")));
    } catch {
      // Ignore unrelated malformed JSON-LD blocks and continue looking for the
      // event block. Missing required event data fails explicitly below.
    }
  }
  const event = entries.find(entry =>
    Boolean(entry && typeof entry === "object" && isEventType((entry as Record<string, unknown>)["@type"])),
  ) as Record<string, unknown> | undefined;
  const name = typeof event?.name === "string" ? decodeHtml(event.name).trim() : "";
  const startDate = calendarDate(event?.startDate);
  if (!event || !name || !startDate) {
    throw new Error("Página sem dados estruturados completos do evento");
  }
  const locationObject = event.location && typeof event.location === "object"
    ? event.location as Record<string, unknown>
    : null;
  const location = typeof locationObject?.name === "string"
    ? decodeHtml(locationObject.name).trim() || null
    : null;
  const description = typeof event.description === "string"
    ? decodeHtml(event.description).trim() || null
    : null;
  const canonicalUrl = new URL(sourceUrl);
  canonicalUrl.search = "";
  canonicalUrl.hash = "";
  return {
    name,
    description,
    startDate,
    endDate: calendarDate(event.endDate),
    location,
    address: formattedAddress(locationObject?.address),
    sourceUrl: canonicalUrl.toString().replace(/\/$/, ""),
  };
}

export function extractEventDocument(html: string, url: string): EventDocument {
  const text = plainText(html);
  if (text.length < 200) throw new Error("Página sem conteúdo textual suficiente");
  const event = extractStructuredEvent(html, url);
  const title = event.name || titleFromHtml(html, url);
  return {
    title,
    sourceUrl: url,
    markdown: `# ${title}\n\nFonte oficial: ${url}\n\n${text}`,
    event,
  };
}

async function fetchViaFirecrawl(url: string, apiKey: string): Promise<string> {
  const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, formats: ["html"], onlyMainContent: true }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`Firecrawl respondeu HTTP ${response.status}`);
  const body = await response.json() as { data?: { html?: string; markdown?: string } };
  const content = body.data?.html ?? body.data?.markdown;
  if (!content) throw new Error("Firecrawl não retornou conteúdo");
  return content;
}

export async function fetchSoundfulnessPage(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  try {
    const response = await fetcher(url, {
      headers: { "User-Agent": "SoundOS-Sofia/1.0 (+https://www.soundfulness.online/)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (html.length < 500) throw new Error("Resposta vazia ou incompleta");
    return html;
  } catch (directError) {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) throw directError;
    return fetchViaFirecrawl(url, apiKey);
  }
}

export async function crawlUpcomingEvents(
  fetchPage: (url: string) => Promise<string> = fetchSoundfulnessPage,
): Promise<EventCrawlResult> {
  const homeHtml = await fetchPage(EVENTS_INDEX_URL);
  const discoveredUrls = discoverUpcomingEventUrls(homeHtml);
  if (discoveredUrls.length === 0) {
    throw new Error("A seção Próximos Eventos não retornou links de eventos");
  }

  const settled = await Promise.allSettled(
    discoveredUrls.map(async url => extractEventDocument(await fetchPage(url), url)),
  );
  const documents: EventDocument[] = [];
  const failures: EventCrawlResult["failures"] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") documents.push(result.value);
    else failures.push({
      url: discoveredUrls[index]!,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
  });
  return { documents, discoveredUrls, failures };
}