/**
 * Leitura (somente leitura) dos pedidos reais da loja na Wix.
 *
 * Só guardamos o necessário para o Painel Loja. Do cliente guardamos nome,
 * e-mail e telefone (para ligar o pedido à ficha em Pessoas) e a cidade/UF de
 * entrega. CPF/CNPJ, endereço de rua e dados de pagamento nunca são copiados.
 */

const WIX_ORDERS_SEARCH_URL = "https://www.wixapis.com/ecom/v1/orders/search";
const DEFAULT_PAGE_SIZE = 100;
// 100 páginas x 100 pedidos. Passar disso é erro explícito, nunca lista cortada.
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_TIMEOUT_MS = 20_000;

export type WixOrdersErrorCode =
  | "not_configured"
  | "credential_refused"
  | "wix_unavailable"
  | "too_many_orders"
  | "unexpected_response"
  | "unsupported_currency";

export class WixOrdersError extends Error {
  constructor(
    public readonly code: WixOrdersErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WixOrdersError";
  }
}

export interface StoreOrderItem {
  name: string;
  quantity: number;
  /** Valor do item (já com desconto do item), sem frete. */
  value: number;
  /** Id do produto no catálogo; nulo para itens personalizados. */
  catalogId: string | null;
}

export interface StoreOrder {
  id: string;
  number: string;
  /** Momento da criação do pedido (ISO). */
  createdAt: string;
  customerName: string | null;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  /** Total pago pelo cliente: itens − descontos + frete + impostos + taxas. */
  total: number;
  shipping: number;
  /**
   * Campos abaixo ausentes (`undefined`) em retratos salvos antes de existirem;
   * `null` quando a Wix não informou o dado. Depois de uma atualização vêm sempre preenchidos.
   */
  email?: string | null;
  phone?: string | null;
  subtotal?: number | null;
  discount?: number | null;
  tax?: number | null;
  shippingMethod?: string | null;
  city: string | null;
  /** UF para o Brasil; código do país para o exterior. */
  region: string | null;
  country: string | null;
  items: StoreOrderItem[];
}

export interface WixOrdersConfig {
  apiKey: string;
  siteId: string;
}

export interface FetchWixOrdersOptions {
  fetchImpl?: typeof fetch;
  config?: WixOrdersConfig;
  pageSize?: number;
  maxPages?: number;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed || null;
}

function invalid(detail: string): never {
  throw new WixOrdersError("unexpected_response", `Resposta inesperada da Wix: ${detail}.`);
}

function readMoney(container: unknown, field: string, required: boolean, context: string): number {
  const raw = asRecord(container)?.[field];
  const amount = asRecord(raw)?.["amount"];
  if (amount === undefined || amount === null || amount === "") {
    if (required) invalid(`${context} sem ${field}`);
    return 0;
  }
  const value = Number(amount);
  if (!Number.isFinite(value)) invalid(`${context} com ${field} inválido`);
  return value;
}

function readConfig(): WixOrdersConfig {
  const apiKey = process.env["WIX_API_KEY"]?.trim();
  const siteId = process.env["WIX_SITE_ID"]?.trim();
  if (!apiKey || !siteId) {
    throw new WixOrdersError("not_configured", "A integração Wix não está configurada.");
  }
  return { apiKey, siteId };
}

function customerNameOf(order: Json): string | null {
  for (const infoKey of ["billingInfo", "recipientInfo"]) {
    const contact = asRecord(asRecord(order[infoKey])?.["contactDetails"]);
    const name = [asText(contact?.["firstName"]), asText(contact?.["lastName"])]
      .filter(Boolean)
      .join(" ");
    if (name) return name;
  }
  return null;
}

function readOptionalMoney(container: unknown, field: string, context: string): number | null {
  const amount = asRecord(asRecord(container)?.[field])?.["amount"];
  if (amount === undefined || amount === null || amount === "") return null;
  const value = Number(amount);
  if (!Number.isFinite(value)) invalid(`${context} com ${field} inválido`);
  return value;
}

function buyerEmailOf(order: Json): string | null {
  return asText(asRecord(order["buyerInfo"])?.["email"]);
}

/** Mesma ordem do nome: cobrança primeiro, entrega quando não há telefone na cobrança. */
function customerPhoneOf(order: Json): string | null {
  for (const infoKey of ["billingInfo", "recipientInfo"]) {
    const phone = asText(asRecord(asRecord(order[infoKey])?.["contactDetails"])?.["phone"]);
    if (phone) return phone;
  }
  return null;
}

function placeOf(order: Json): Pick<StoreOrder, "city" | "region" | "country"> {
  // Cidade de entrega primeiro; a de cobrança só entra quando não há entrega.
  for (const infoKey of ["recipientInfo", "billingInfo"]) {
    const address = asRecord(asRecord(order[infoKey])?.["address"]);
    const city = asText(address?.["city"]);
    if (!city) continue;

    const subdivision = asText(address?.["subdivision"]);
    const prefix = subdivision?.match(/^([A-Za-z]{2})-/)?.[1] ?? null;
    const country = (asText(address?.["country"]) ?? prefix)?.toUpperCase() ?? null;
    const uf = subdivision ? subdivision.replace(/^[A-Za-z]{2}-/, "").toUpperCase() : null;
    const region = country && country !== "BR" ? country : uf;
    return { city, region, country };
  }
  return { city: null, region: null, country: null };
}

export function normalizeWixOrder(raw: unknown): StoreOrder {
  const order = asRecord(raw);
  if (!order) invalid("pedido ilegível");

  const id = asText(order["id"]);
  if (!id) invalid("pedido sem id");
  const context = `pedido ${id}`;

  const createdAt = asText(order["createdDate"]);
  if (!createdAt || Number.isNaN(new Date(createdAt).getTime())) invalid(`${context} sem data válida`);

  const currency = asText(order["currency"]);
  if (currency && currency.toUpperCase() !== "BRL") {
    throw new WixOrdersError(
      "unsupported_currency",
      "Há pedidos em outra moeda; o painel só soma valores em reais.",
    );
  }

  const summary = asRecord(order["priceSummary"]);
  if (!summary) invalid(`${context} sem resumo de valores`);
  const total = readMoney(summary, "total", true, context);
  const shipping = readMoney(summary, "shipping", false, context);

  const lineItems = order["lineItems"];
  if (lineItems !== undefined && !Array.isArray(lineItems)) invalid(`${context} com itens inválidos`);
  const items: StoreOrderItem[] = (lineItems ?? []).map((rawItem: unknown) => {
    const item = asRecord(rawItem);
    if (!item) invalid(`${context} com item ilegível`);
    const productName = asRecord(item["productName"]);
    const quantity = Number(item["quantity"] ?? 1);
    if (!Number.isFinite(quantity)) invalid(`${context} com quantidade inválida`);
    const hasAfterTax = asRecord(item["totalPriceAfterTax"])?.["amount"] !== undefined;
    const value = readMoney(
      item,
      hasAfterTax ? "totalPriceAfterTax" : "totalPriceBeforeTax",
      true,
      `${context}, item`,
    );
    return {
      name: asText(productName?.["original"]) ?? asText(productName?.["translated"]) ?? "Item sem nome",
      quantity,
      value,
      catalogId: asText(asRecord(item["catalogReference"])?.["catalogItemId"]),
    };
  });

  return {
    id,
    number: asText(order["number"]) ?? id,
    createdAt: new Date(createdAt).toISOString(),
    customerName: customerNameOf(order),
    status: asText(order["status"]) ?? "",
    paymentStatus: asText(order["paymentStatus"]) ?? "",
    fulfillmentStatus: asText(order["fulfillmentStatus"]) ?? "",
    total,
    shipping,
    email: buyerEmailOf(order),
    phone: customerPhoneOf(order),
    subtotal: readOptionalMoney(summary, "subtotal", context),
    discount: readOptionalMoney(summary, "discount", context),
    tax: readOptionalMoney(summary, "tax", context),
    shippingMethod: asText(asRecord(order["shippingInfo"])?.["title"]),
    ...placeOf(order),
    items,
  };
}

async function requestPage(
  fetchImpl: typeof fetch,
  config: WixOrdersConfig,
  cursor: string | null,
  pageSize: number,
  timeoutMs: number,
): Promise<{ orders: unknown[]; next: string | null }> {
  // A Wix não aceita ordenação junto com cursor: a ordem vem embutida no cursor.
  const search = cursor
    ? { cursorPaging: { cursor } }
    : {
        cursorPaging: { limit: pageSize },
        sort: [{ fieldName: "createdDate", order: "DESC" }],
      };

  let response: Response;
  try {
    response = await fetchImpl(WIX_ORDERS_SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: config.apiKey,
        "wix-site-id": config.siteId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ search }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new WixOrdersError("wix_unavailable", "A Wix não respondeu a tempo.");
  }

  if (response.status === 401 || response.status === 403) {
    throw new WixOrdersError("credential_refused", "A Wix recusou a credencial da integração.");
  }
  if (!response.ok) {
    throw new WixOrdersError("wix_unavailable", `A Wix respondeu com erro (${response.status}).`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    invalid("corpo não é JSON");
  }
  const parsed = asRecord(body);
  const orders = parsed?.["orders"];
  if (!parsed || !Array.isArray(orders)) invalid("lista de pedidos ausente");

  const metadata = asRecord(parsed["metadata"]);
  const hasNext = metadata?.["hasNext"] === true;
  const next = asText(asRecord(metadata?.["cursors"])?.["next"]);
  if (hasNext && !next) invalid("há mais páginas, mas o cursor veio vazio");
  return { orders, next: hasNext ? next : null };
}

/** Lê todos os pedidos da loja, página por página. Falha por inteiro em vez de devolver uma lista incompleta. */
export async function fetchWixOrders(options: FetchWixOrdersOptions = {}): Promise<StoreOrder[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const config = options.config ?? readConfig();
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const byId = new Map<string, StoreOrder>();
  let cursor: string | null = null;
  for (let page = 1; ; page++) {
    if (page > maxPages) {
      throw new WixOrdersError(
        "too_many_orders",
        "A loja tem mais pedidos do que o painel consegue ler com segurança.",
      );
    }
    const result = await requestPage(fetchImpl, config, cursor, pageSize, timeoutMs);
    for (const raw of result.orders) {
      const order = normalizeWixOrder(raw);
      byId.set(order.id, order);
    }
    if (!result.next) break;
    cursor = result.next;
  }
  return [...byId.values()];
}
