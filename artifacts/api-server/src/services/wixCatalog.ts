import {
  getProductInventory,
  getStoreInventorySummary,
  type OmieProductInventory,
  type StoreInventorySyncSummary,
} from "./omieStoreInventory";
import {
  getProductDescriptionEnrichment,
  hydrateProductDescriptionEnrichments,
  resetProductDescriptionEnrichmentForTests,
  scheduleProductDescriptionEnrichment,
  type ProductDescriptionSource,
} from "./productDescriptionEnrichment";

const WIX_PRODUCTS_URL = "https://www.wixapis.com/stores-reader/v1/products/query";
const PAGE_SIZE = 100;
const SCHEDULE_TIME_ZONE = "America/Sao_Paulo";
const SCHEDULE_HOUR = 22;
const SCHEDULE_MINUTE = 0;
const zonedPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHEDULE_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

type WixPriceData = {
  currency?: string;
  price?: number;
  discountedPrice?: number;
};

type WixVariant = {
  choices?: Record<string, string>;
  variant?: {
    sku?: string;
    visible?: boolean;
    priceData?: WixPriceData;
  };
  stock?: {
    quantity?: number;
  };
};

type WixImage = {
  url?: string;
};

type WixRawProduct = {
  id?: string;
  name?: string;
  description?: string;
  sku?: string;
  visible?: boolean;
  priceData?: WixPriceData;
  priceRange?: { minValue?: number; maxValue?: number };
  stock?: {
    quantity?: number;
    inventoryStatus?: string;
  };
  productPageUrl?: {
    base?: string;
    path?: string;
  };
  media?: {
    mainMedia?: {
      image?: WixImage;
    };
    items?: Array<{
      image?: WixImage;
    }>;
  };
  variants?: WixVariant[];
};

type WixQueryResponse = {
  products?: WixRawProduct[];
  totalResults?: number;
  pagingMetadata?: {
    count?: number;
    offset?: number;
    total?: number;
    tooManyToCount?: boolean;
  };
};

export type CatalogProduct = {
  id: string;
  sku: string | null;
  skus: string[];
  /** Valores de opções publicados pela Wix (por exemplo, “Azul”). */
  variantOptions?: string[];
  /** Combinações de opções por variante visível; não achatar ao validar identidade. */
  variantChoices?: string[][];
  name: string;
  description: string | null;
  descriptionSource: ProductDescriptionSource;
  price: number | null;
  priceMax: number | null;
  currency: string;
  url: string | null;
  imageUrl: string | null;
  visible: boolean;
  inStock: boolean | null;
  omieInventory: OmieProductInventory;
};

export type PublicProductFacts = {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  price: number | null;
  priceMax: number | null;
  currency: string;
  url: string | null;
  availability: "disponivel" | "indisponivel" | "indeterminada";
  availabilitySource: "omie-store";
  availabilityUpdatedAt: string | null;
};

/** Dados de produto autorizados para a Sofia; quantidades Omie nunca atravessam esta fronteira. */
export function getPublicProductFacts(product: CatalogProduct): PublicProductFacts {
  const inventoryStatus = product.omieInventory.status;
  const availability = inventoryStatus === "linked"
    ? "disponivel"
    : inventoryStatus === "zero"
      ? "indisponivel"
      : "indeterminada";
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    description: product.descriptionSource === "wix" ? product.description : null,
    price: product.price,
    priceMax: product.priceMax,
    currency: product.currency,
    url: product.url,
    availability,
    availabilitySource: "omie-store",
    availabilityUpdatedAt: product.omieInventory.lastUpdated,
  };
}

export function formatPublicProductFacts(
  facts: PublicProductFacts,
  request = "",
): string {
  const wantsPrice = /\b(pre[çc]o|valor|quanto custa)\b/i.test(request);
  const wantsLink = /\b(link|p[áa]gina|url|site)\b/i.test(request);
  const wantsAvailability = /\b(disponibilidade|dispon[íi]vel|indispon[íi]vel|estoque)\b/i.test(request);
  const wantsDescription = /\b(o que [ée]|como funciona|para que serve|descri[çc][ãa]o|detalhes)\b/i.test(request);
  const hasRequestedField = wantsPrice || wantsLink || wantsAvailability || wantsDescription;
  const price = facts.price === null
    ? null
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: facts.currency || "BRL" })
      .format(facts.price)
      .replace(/\u00a0/g, " ");
  const availability = facts.availability === "disponivel"
    ? "Disponibilidade: disponível no estoque oficial."
    : facts.availability === "indisponivel"
      ? "Disponibilidade: indisponível no estoque oficial."
      : "Disponibilidade: não foi possível confirmar no estoque oficial agora.";
  return [
    facts.name,
    wantsDescription || !hasRequestedField ? facts.description : null,
    wantsPrice && price ? `Preço: ${price}` : null,
    wantsLink && facts.url ? `Link: ${facts.url}` : null,
    wantsAvailability ? availability : null,
  ].filter((value): value is string => Boolean(value)).join("\n");
}

export type CatalogSnapshot = {
  source: "wix";
  lastUpdated: string;
  totalRegistered: number;
  totalHidden: number;
  products: CatalogProduct[];
  inventory: StoreInventorySyncSummary;
};

type WixCatalogProduct = Omit<CatalogProduct, "omieInventory">;
type WixCatalogSnapshot = Omit<CatalogSnapshot, "products" | "inventory"> & {
  products: WixCatalogProduct[];
};

export class WixCatalogError extends Error {
  constructor(message: string, public readonly statusCode = 502) {
    super(message);
    this.name = "WixCatalogError";
  }
}

let cache: { snapshot: WixCatalogSnapshot } | null = null;
let refreshInFlight: Promise<WixCatalogSnapshot> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

export function resetWixCatalogCacheForTests(): void {
  cache = null;
  resetProductDescriptionEnrichmentForTests();
}

function getZonedParts(date: Date): Record<string, number> {
  return Object.fromEntries(
    zonedPartsFormatter.formatToParts(date)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, Number(part.value)]),
  );
}

function getTimeZoneOffsetMs(date: Date): number {
  const parts = getZonedParts(date);
  return date.getTime() - Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second,
  );
}

function nextDailyRefreshTimestamp(now = new Date()): number {
  const local = getZonedParts(now);
  const targetForDay = (day: number): number => {
    const localAsUtc = Date.UTC(
      local.year, local.month - 1, day,
      SCHEDULE_HOUR, SCHEDULE_MINUTE, 0,
    );
    return localAsUtc + getTimeZoneOffsetMs(new Date(localAsUtc));
  };
  let targetLocalUtc = targetForDay(local.day);
  if (targetLocalUtc <= now.getTime()) {
    targetLocalUtc = targetForDay(local.day + 1);
  }
  return targetLocalUtc;
}

export function getNextCatalogRefreshAt(now = new Date()): string {
  return new Date(nextDailyRefreshTimestamp(now)).toISOString();
}

function requireConfig(): { apiKey: string; siteId: string } {
  const apiKey = process.env["WIX_API_KEY"]?.trim();
  const siteId = process.env["WIX_SITE_ID"]?.trim();
  if (!apiKey || !siteId) {
    throw new WixCatalogError("A integração Wix não está configurada.", 503);
  }
  return { apiKey, siteId };
}

function plainText(value?: string): string | null {
  if (!value?.trim()) return null;
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim() || null;
}

function productUrl(raw?: WixRawProduct["productPageUrl"]): string | null {
  if (!raw?.base || !raw.path) return null;
  try {
    const base = raw.base.startsWith("http") ? raw.base : `https://${raw.base}`;
    const baseUrl = new URL(base.endsWith("/") ? base : `${base}/`);
    const resolvedUrl = new URL(raw.path, baseUrl);
    if (
      baseUrl.protocol !== "https:" ||
      resolvedUrl.protocol !== "https:" ||
      resolvedUrl.origin !== baseUrl.origin
    ) {
      return null;
    }
    return resolvedUrl.toString();
  } catch {
    return null;
  }
}

function productImageUrl(raw?: WixRawProduct["media"]): string | null {
  const url = raw?.mainMedia?.image?.url
    ?? raw?.items?.find(item => item.image?.url)?.image?.url;
  if (!url?.trim()) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const trustedWixImageHost = host === "static.wixstatic.com" || host.endsWith(".wixstatic.com");
    return parsed.protocol === "https:" && trustedWixImageHost ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function normalizeProduct(raw: WixRawProduct): WixCatalogProduct | null {
  if (!raw.id || !raw.name?.trim() || raw.visible === false) return null;

  const visibleVariants = (raw.variants ?? []).filter(v => v.variant?.visible !== false);
  const skus = [...new Set([
    raw.sku?.trim(),
    ...visibleVariants.map(v => v.variant?.sku?.trim()),
  ].filter((value): value is string => Boolean(value)))];
  const variantOptions = [...new Set(
    visibleVariants.flatMap(variant =>
      Object.values(variant.choices ?? {}).map(value => value.trim()).filter(Boolean)
    ),
  )];
  const variantChoices = visibleVariants
    .map(variant => Object.values(variant.choices ?? {}).map(value => value.trim()).filter(Boolean))
    .filter(choices => choices.length > 0);
  const variantPrices = visibleVariants
    .map(v => v.variant?.priceData?.discountedPrice ?? v.variant?.priceData?.price)
    .filter((value): value is number => typeof value === "number");
  const productPrice = raw.priceData?.discountedPrice ?? raw.priceData?.price;
  const prices = variantPrices.length > 0
    ? variantPrices
    : typeof productPrice === "number" ? [productPrice] : [];
  const currency = raw.priceData?.currency
    ?? visibleVariants.find(v => v.variant?.priceData?.currency)?.variant?.priceData?.currency
    ?? "BRL";

  let inStock: boolean | null = null;
  if (raw.stock?.inventoryStatus) {
    inStock = raw.stock.inventoryStatus !== "OUT_OF_STOCK";
  } else if (visibleVariants.some(v => typeof v.stock?.quantity === "number")) {
    inStock = visibleVariants.some(v => (v.stock?.quantity ?? 0) > 0);
  }

  const description = plainText(raw.description);
  return {
    id: raw.id,
    sku: skus[0] ?? null,
    skus,
    variantOptions,
    variantChoices,
    name: raw.name.trim(),
    description,
    descriptionSource: description ? "wix" : "pending",
    price: prices.length > 0 ? Math.min(...prices) : raw.priceRange?.minValue ?? null,
    priceMax: prices.length > 0 ? Math.max(...prices) : raw.priceRange?.maxValue ?? null,
    currency,
    url: productUrl(raw.productPageUrl),
    imageUrl: productImageUrl(raw.media),
    visible: true,
    inStock,
  };
}

async function fetchPage(offset: number): Promise<WixQueryResponse> {
  const { apiKey, siteId } = requireConfig();
  const response = await fetch(WIX_PRODUCTS_URL, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "wix-site-id": siteId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      includeVariants: true,
      // Lemos também os ocultos para paginar sobre os 110 cadastrados e então
      // filtrá-los explicitamente. A Sofia e a Store continuam recebendo
      // somente os produtos publicados/visíveis.
      includeHiddenProducts: true,
      query: { paging: { limit: PAGE_SIZE, offset } },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new WixCatalogError(
      `A Wix recusou a consulta ao catálogo (${response.status})${detail ? `: ${detail}` : "."}`,
      response.status === 401 || response.status === 403 ? 502 : response.status,
    );
  }

  return response.json() as Promise<WixQueryResponse>;
}

async function refreshCatalog(): Promise<WixCatalogSnapshot> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
  const rawProducts: WixRawProduct[] = [];
  let offset = 0;
  let knownTotal: number | null = null;

  while (true) {
    const page = await fetchPage(offset);
    const products = page.products ?? [];
    rawProducts.push(...products);
    knownTotal = typeof page.pagingMetadata?.total === "number"
      ? page.pagingMetadata.total
      : typeof page.totalResults === "number"
        ? page.totalResults
        : knownTotal;
    if (products.length < PAGE_SIZE) break;
    offset += products.length;
    if (knownTotal !== null && offset >= knownTotal) break;
    if (offset > 10_000) throw new WixCatalogError("O catálogo Wix excedeu o limite seguro de leitura.");
  }

  const products = rawProducts
    .map(normalizeProduct)
    .filter((product): product is WixCatalogProduct => product !== null)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const snapshot: WixCatalogSnapshot = {
    source: "wix",
    lastUpdated: new Date().toISOString(),
    totalRegistered: rawProducts.length,
    totalHidden: rawProducts.length - products.length,
    products,
  };
  cache = { snapshot };
  return snapshot;
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function scheduleDailyRefresh(): void {
  if (refreshTimer) return;
  const nextRefreshAt = nextDailyRefreshTimestamp();
  const delay = Math.max(nextRefreshAt - Date.now(), 1_000);
  console.info(
    `[wix-catalog] próxima atualização: ${new Date(nextRefreshAt).toISOString()} (22:00 America/Sao_Paulo)`,
  );
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try {
      await refreshCatalog();
      console.info("[wix-catalog] catálogo atualizado às 22:00 America/Sao_Paulo");
    } catch (error) {
      // A Wix pode ficar indisponível temporariamente; nesse caso, o último
      // snapshot válido permanece em uso até a tentativa do dia seguinte.
      console.error("[wix-catalog] atualização diária falhou; mantendo snapshot anterior", error);
    } finally {
      scheduleDailyRefresh();
    }
  }, delay);
  refreshTimer.unref?.();
}

export async function getPublishedCatalog(forceRefresh = false): Promise<CatalogSnapshot> {
  scheduleDailyRefresh();
  const wixSnapshot = !forceRefresh && cache ? cache.snapshot : await refreshCatalog();
  if (process.env.NODE_ENV !== "test") {
    await hydrateProductDescriptionEnrichments(wixSnapshot.products);
    void scheduleProductDescriptionEnrichment(wixSnapshot.products);
  }
  const [inventory, products] = await Promise.all([
    getStoreInventorySummary(),
    Promise.all(wixSnapshot.products.map(async product => {
      const enrichment = getProductDescriptionEnrichment(product);
      return {
        ...product,
        description: enrichment.description,
        descriptionSource: enrichment.source,
        omieInventory: await getProductInventory(product.skus),
      };
    })),
  ]);
  return { ...wixSnapshot, products, inventory };
}

function normalized(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

const SEARCH_STOPWORDS = new Set([
  "a", "ao", "aos", "as", "da", "das", "de", "do", "dos", "e", "em", "o", "os",
  "qual", "quais", "quanto", "custa", "preco", "valor", "quero", "queria", "comprar",
  "produto", "produtos", "loja", "manda", "mandar", "link", "pagamento", "para",
  "como", "uma", "um", "voces", "voce", "tem", "teria", "trabalham", "com", "me",
  "mostra", "mostrar", "mostre", "lista", "listar", "procuro", "procurando", "gostaria",
  "saber", "sobre", "disponivel", "disponibilidade", "estoque", "agora", "por", "favor",
  "oi", "ola", "bom", "boa", "dia", "tarde", "noite", "vende", "vendem", "existe",
  "no", "na", "nos", "nas", "esta", "estao",
  // Nome da loja em construções como “A Soundfulness vende [produto]?”.
  "soundfulness",
  // “oficial” qualifica a fonte/loja, não cria uma variante de produto.
  "oficial",
]);

const BROAD_CATALOG_REQUEST =
  /\b(quais|opcoes|modelos|catalogo|produtos|mostr(?:a|ar|e)|list(?:a|ar)|trabalham com)\b/;

function words(value: string): string[] {
  return normalized(value).match(/[a-z0-9]+/g) ?? [];
}

function identityWords(value: string): string[] {
  // Letras/números isolados podem ser opções reais de variante (P, G, 8).
  return words(value).filter(word => !SEARCH_STOPWORDS.has(word));
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < 4 || right.length < 4 || Math.abs(left.length - right.length) > 1) return false;
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  if (left.length === right.length) {
    return left.slice(prefix + 1) === right.slice(prefix + 1);
  }
  const [longer, shorter] = left.length > right.length ? [left, right] : [right, left];
  return longer.slice(prefix + 1) === shorter.slice(prefix);
}

function nameMatchesIdentity(product: CatalogProduct, requestedWords: string[]): {
  exactWords: number;
  typoWords: number;
  nameWords: number;
} | null {
  const productWords = identityWords(product.name);
  const choicesByVariant = [
    [],
    ...(product.variantChoices ?? []).map(choices => choices.flatMap(identityWords)),
  ];

  for (const optionWords of choicesByVariant) {
    const candidateWords = [...productWords, ...optionWords];
    const unused = new Set(candidateWords.map((_, index) => index));
    let exactWords = 0;
    let typoWords = 0;
    let nameWords = 0;
    let failed = false;

    for (const requested of requestedWords) {
      let matchedIndex = candidateWords.findIndex(
        (word, index) => unused.has(index) && word === requested,
      );
      if (matchedIndex >= 0) {
        exactWords++;
      } else {
        matchedIndex = candidateWords.findIndex(
          (word, index) => unused.has(index) && editDistanceAtMostOne(word, requested),
        );
        if (matchedIndex < 0) {
          failed = true;
          break;
        }
        typoWords++;
        if (typoWords > 1) {
          failed = true;
          break;
        }
      }
      if (matchedIndex < productWords.length) nameWords++;
      unused.delete(matchedIndex);
    }
    if (!failed && nameWords > 0) return { exactWords, typoWords, nameWords };
  }
  // Opções achatadas de snapshots antigos não provam uma combinação real.
  return null;
}

function isBroadCatalogRequest(query: string, requestedWords: string[]): boolean {
  const value = normalized(query);
  if (BROAD_CATALOG_REQUEST.test(value)) return true;
  // A plural category on its own is browsing; a multi-word name is an identity.
  return requestedWords.length === 1 && /(?:s|es)$/.test(requestedWords[0] ?? "");
}

/**
 * Pure product identity matcher shared by the service and focused route tests.
 *
 * Named requests are fail-closed: every meaningful requested word must belong
 * to the product name (one small typo is accepted). Descriptions never take
 * part in identity matching, so generic copy cannot substitute another item.
 */
export function matchPublishedProducts(
  products: CatalogProduct[],
  query: string,
  limit = 5,
): CatalogProduct[] {
  const q = normalized(query);
  if (!q) return [];

  const exact = products.filter(product =>
    normalized(product.name) === q || product.skus.some(sku => normalized(sku) === q)
  );
  if (exact.length > 0) return exact.slice(0, limit);

  const queryWords = words(query);
  const skuMatches = products.filter(product =>
    product.skus.some(sku => {
      const skuWords = words(sku);
      if (skuWords.length === 0) return false;
      return queryWords.some((_, start) =>
        skuWords.every((word, offset) => queryWords[start + offset] === word)
      );
    })
  );
  if (skuMatches.length > 0) return skuMatches.slice(0, limit);

  const requestedWords = identityWords(query);
  if (requestedWords.length === 0) return [];
  const broad = isBroadCatalogRequest(query, requestedWords);

  return products
    .map(product => {
      const match = nameMatchesIdentity(product, requestedWords);
      if (!match) return null;
      const productWordCount = identityWords(product.name).length;
      // Um único termo exato ainda é uma família legítima (“gong”, “marimba”).
      // Retornamos todos os candidatos de nome para a camada chamadora tratar
      // ambiguidade. Só não promovemos um typo isolado a identidade de produto.
      if (requestedWords.length === 1 && match.typoWords > 0 && !broad) return null;
      return {
        product,
        score: match.exactWords * 10 - match.typoWords * 2
          - Math.max(productWordCount - requestedWords.length, 0),
      };
    })
    .filter((result): result is { product: CatalogProduct; score: number } => result !== null)
    .sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name, "pt-BR"))
    .slice(0, limit)
    .map(result => result.product);
}

export async function searchPublishedProducts(query: string, limit = 5): Promise<CatalogProduct[]> {
  const { products } = await getPublishedCatalog();
  return matchPublishedProducts(products, query, limit);
}

/** Pure counterpart used to test literal mention handling without mocking the matcher. */
export function findMentionedProducts(
  products: CatalogProduct[],
  text: string,
): CatalogProduct[] {
  return matchPublishedProducts(products, text, products.length);
}

/** Detecta menções estritas a um nome de produto publicado ou a qualquer SKU. */
export async function findMentionedPublishedProducts(text: string): Promise<CatalogProduct[]> {
  const { products } = await getPublishedCatalog();
  return findMentionedProducts(products, text);
}

// O agendamento nasce com o backend, independentemente de alguém abrir a tela.
scheduleDailyRefresh();
