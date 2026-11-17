/**
 * Regras do Painel Loja, sem acesso a rede nem banco: recebe os pedidos já
 * lidos da Wix e devolve os números da tela. Valores são somados em centavos
 * inteiros para que as tabelas fechem exatamente com os totais.
 */
import {
  saoPauloDate,
  saoPauloMonthKey,
  startOfSaoPauloDay,
} from "../lib/saoPauloTime";
import type { StoreOrder } from "./wixOrders";

export const STORE_PANEL_PERIODS = ["30d", "90d", "12m", "all"] as const;
export type StorePanelPeriod = (typeof STORE_PANEL_PERIODS)[number];
export const DEFAULT_STORE_PANEL_PERIOD: StorePanelPeriod = "12m";

export const STORE_SITUATIONS = [
  "paid_delivered",
  "paid_to_ship",
  "awaiting_payment",
  "declined",
  "refunded",
  "cancelled",
] as const;
export type StoreSituation = (typeof STORE_SITUATIONS)[number];

export const STORE_ORDERS_PAGE_SIZE = 20;
const TOP_PRODUCTS = 10;
const TOP_CITIES = 10;

export type StorePaymentLabel = "paid" | "awaiting" | "declined" | "refunded" | "canceled";
export type StoreDeliveryLabel = "delivered" | "partial" | "to_ship" | "none";

const REFUNDED_PAYMENTS = new Set(["FULLY_REFUNDED", "PARTIALLY_REFUNDED"]);
const CANCELLED_STATUSES = new Set(["CANCELED", "REJECTED"]);

/**
 * Situação única de um pedido. A ordem das regras importa: um pedido pago e
 * depois reembolsado ou cancelado não pode contar como venda confirmada.
 */
export function situationOf(order: Pick<StoreOrder, "status" | "paymentStatus" | "fulfillmentStatus">): StoreSituation {
  if (REFUNDED_PAYMENTS.has(order.paymentStatus)) return "refunded";
  if (CANCELLED_STATUSES.has(order.status) || order.paymentStatus === "CANCELED") return "cancelled";
  if (order.paymentStatus === "DECLINED") return "declined";
  if (order.paymentStatus === "PAID") {
    return order.fulfillmentStatus === "FULFILLED" ? "paid_delivered" : "paid_to_ship";
  }
  return "awaiting_payment";
}

/** Venda confirmada: paga, não cancelada e não reembolsada. */
export function isConfirmedSale(order: Pick<StoreOrder, "status" | "paymentStatus" | "fulfillmentStatus">): boolean {
  const situation = situationOf(order);
  return situation === "paid_delivered" || situation === "paid_to_ship";
}

function paymentLabelOf(situation: StoreSituation): StorePaymentLabel {
  switch (situation) {
    case "paid_delivered":
    case "paid_to_ship":
      return "paid";
    case "declined":
      return "declined";
    case "refunded":
      return "refunded";
    case "cancelled":
      return "canceled";
    default:
      return "awaiting";
  }
}

function deliveryLabelOf(order: StoreOrder, situation: StoreSituation): StoreDeliveryLabel {
  if (order.fulfillmentStatus === "FULFILLED") return "delivered";
  if (order.fulfillmentStatus === "PARTIALLY_FULFILLED") return "partial";
  return situation === "paid_to_ship" ? "to_ship" : "none";
}

/**
 * Início do período em São Paulo. 30d e 90d são dias corridos incluindo hoje;
 * 12m são os 12 meses civis, do mês atual para trás; "all" não tem início.
 */
export function periodStart(period: StorePanelPeriod, now: Date): Date | null {
  const today = saoPauloDate(now);
  switch (period) {
    case "30d":
      return startOfSaoPauloDay(today.year, today.month, today.day - 29);
    case "90d":
      return startOfSaoPauloDay(today.year, today.month, today.day - 89);
    case "12m":
      return startOfSaoPauloDay(today.year, today.month - 11, 1);
    default:
      return null;
  }
}

const toCents = (value: number): number => Math.round(value * 100);
const fromCents = (cents: number): number => cents / 100;

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const LOWERCASE_WORDS = new Set(["de", "da", "do", "das", "dos", "e"]);

function titleCase(value: string): string {
  return value
    .toLocaleLowerCase("pt-BR")
    .split(" ")
    .map((word, index) =>
      index > 0 && LOWERCASE_WORDS.has(word)
        ? word
        : word.charAt(0).toLocaleUpperCase("pt-BR") + word.slice(1),
    )
    .join(" ");
}

/** Grafia mais usada do grupo; empata a favor da que tem acento. Texto todo em caixa alta/baixa vira Título. */
function displayName(spellings: Map<string, number>): string {
  const [best] = [...spellings.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const accentA = /[^\x00-\x7f]/.test(a[0]) ? 1 : 0;
    const accentB = /[^\x00-\x7f]/.test(b[0]) ? 1 : 0;
    if (accentB !== accentA) return accentB - accentA;
    return a[0].localeCompare(b[0], "pt-BR");
  })[0] ?? ["", 0];
  const mixed = best !== best.toLocaleLowerCase("pt-BR") && best !== best.toLocaleUpperCase("pt-BR");
  return mixed ? best : titleCase(best);
}

export interface StorePanelOrderRow {
  id: string;
  number: string;
  createdAt: string;
  customerName: string | null;
  items: Array<{ name: string; quantity: number }>;
  city: string | null;
  region: string | null;
  total: number;
  situation: StoreSituation;
  payment: StorePaymentLabel;
  delivery: StoreDeliveryLabel;
  /**
   * Ligação com a ficha em Pessoas, calculada na hora pela rota e só para quem tem a área Pessoas
   * (ausente para os demais; `null` quando o pedido não está ligado a uma ficha).
   */
  pessoaLink?: { mode: "email" | "phone" | "both" | "name"; similarity: number | null } | null;
}

export interface StoreOrderDetail {
  id: string;
  number: string;
  createdAt: string;
  situation: StoreSituation;
  payment: StorePaymentLabel;
  delivery: StoreDeliveryLabel;
  confirmedSale: boolean;
  customer: {
    name: string | null;
    email: string | null;
    phone: string | null;
    city: string | null;
    region: string | null;
  };
  /** Falso para pedidos de um retrato salvo antes de e-mail/telefone serem guardados. */
  contactAvailable: boolean;
  items: Array<{ name: string; quantity: number; value: number }>;
  amounts: {
    subtotal: number | null;
    discount: number | null;
    shipping: number;
    shippingMethod: string | null;
    tax: number | null;
    total: number;
  };
}

export interface StorePanelProductRow {
  kind: "product" | "others";
  /** Nulo na linha "Outros", que a tela rotula no idioma do usuário. */
  name: string | null;
  quantity: number;
  value: number;
}

export interface StorePanelCityRow {
  kind: "city" | "others" | "unknown";
  /** Nulo nas linhas "Outras cidades" e "Sem cidade informada". */
  city: string | null;
  region: string | null;
  orders: number;
  value: number;
  avgTicket: number | null;
}

export interface StorePanelData {
  period: StorePanelPeriod;
  periodStart: string | null;
  productOptions: Array<{ key: string; name: string }>;
  kpis: {
    orders: number;
    confirmedOrders: number;
    revenue: number;
    avgTicket: number | null;
    awaitingPayment: { orders: number; value: number };
    paidToShip: { orders: number; value: number };
  };
  situations: Array<{ situation: StoreSituation; orders: number; value: number }>;
  orders: {
    situation: StoreSituation | null;
    page: number;
    pageSize: number;
    totalPages: number;
    total: number;
    rows: StorePanelOrderRow[];
  };
  products: { totalQuantity: number; totalValue: number; rows: StorePanelProductRow[] };
  cities: { totalOrders: number; totalValue: number; rows: StorePanelCityRow[] };
  monthly: Array<{ month: string; orders: number; revenue: number }>;
}

export interface BuildStorePanelOptions {
  period: StorePanelPeriod;
  situation?: StoreSituation | null;
  page?: number;
  now?: Date;
  dataDe?: string;
  dataAte?: string;
  productKey?: string;
}

function productKeyOf(item: StoreOrder["items"][number]): string {
  return item.catalogId ? `id:${item.catalogId}` : `name:${normalizeText(item.name)}`;
}

function buildProductOptions(orders: readonly StoreOrder[]): StorePanelData["productOptions"] {
  const products = new Map<string, { name: string; latest: number }>();
  for (const order of orders) {
    const at = new Date(order.createdAt).getTime();
    for (const item of order.items) {
      const key = productKeyOf(item);
      const previous = products.get(key);
      if (!previous || at >= previous.latest) products.set(key, { name: item.name, latest: at });
    }
  }
  return [...products.entries()]
    .map(([key, product]) => ({ key, name: product.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR") || a.key.localeCompare(b.key));
}

function buildProducts(confirmed: StoreOrder[], productKey?: string): StorePanelData["products"] {
  interface Group { quantity: number; cents: number; name: string; latest: number }
  const groups = new Map<string, Group>();
  for (const order of confirmed) {
    const at = new Date(order.createdAt).getTime();
    for (const item of order.items) {
      const key = productKeyOf(item);
      if (productKey && key !== productKey) continue;
      const group = groups.get(key) ?? { quantity: 0, cents: 0, name: item.name, latest: -Infinity };
      group.quantity += item.quantity;
      group.cents += toCents(item.value);
      // O nome exibido é o do pedido mais recente: produtos renomeados na Wix contam juntos.
      if (at >= group.latest) {
        group.latest = at;
        group.name = item.name;
      }
      groups.set(key, group);
    }
  }

  const sorted = [...groups.values()].sort(
    (a, b) => b.cents - a.cents || b.quantity - a.quantity || a.name.localeCompare(b.name, "pt-BR"),
  );
  const rows: StorePanelProductRow[] = sorted.slice(0, TOP_PRODUCTS).map(group => ({
    kind: "product",
    name: group.name,
    quantity: group.quantity,
    value: fromCents(group.cents),
  }));
  const rest = sorted.slice(TOP_PRODUCTS);
  if (rest.length > 0) {
    rows.push({
      kind: "others",
      name: null,
      quantity: rest.reduce((sum, group) => sum + group.quantity, 0),
      value: fromCents(rest.reduce((sum, group) => sum + group.cents, 0)),
    });
  }
  return {
    totalQuantity: sorted.reduce((sum, group) => sum + group.quantity, 0),
    totalValue: fromCents(sorted.reduce((sum, group) => sum + group.cents, 0)),
    rows,
  };
}

function buildCities(confirmed: StoreOrder[]): StorePanelData["cities"] {
  interface Group { orders: number; cents: number; region: string | null; spellings: Map<string, number> }
  const groups = new Map<string, Group>();
  let unknown = { orders: 0, cents: 0 };

  for (const order of confirmed) {
    const cents = toCents(order.total);
    const normalized = order.city ? normalizeText(order.city) : "";
    if (!order.city || !normalized) {
      unknown = { orders: unknown.orders + 1, cents: unknown.cents + cents };
      continue;
    }
    const key = `${order.country ?? ""}|${order.region ?? ""}|${normalized}`;
    const group = groups.get(key) ?? { orders: 0, cents: 0, region: order.region, spellings: new Map() };
    group.orders += 1;
    group.cents += cents;
    group.spellings.set(order.city, (group.spellings.get(order.city) ?? 0) + 1);
    groups.set(key, group);
  }

  const sorted = [...groups.values()]
    .map(group => ({ ...group, city: displayName(group.spellings) }))
    .sort((a, b) => b.cents - a.cents || b.orders - a.orders || a.city.localeCompare(b.city, "pt-BR"));

  const average = (cents: number, orders: number) => (orders > 0 ? fromCents(Math.round(cents / orders)) : null);
  const rows: StorePanelCityRow[] = sorted.slice(0, TOP_CITIES).map(group => ({
    kind: "city",
    city: group.city,
    region: group.region,
    orders: group.orders,
    value: fromCents(group.cents),
    avgTicket: average(group.cents, group.orders),
  }));
  const rest = sorted.slice(TOP_CITIES);
  if (rest.length > 0) {
    const orders = rest.reduce((sum, group) => sum + group.orders, 0);
    const cents = rest.reduce((sum, group) => sum + group.cents, 0);
    rows.push({ kind: "others", city: null, region: null, orders, value: fromCents(cents), avgTicket: average(cents, orders) });
  }
  if (unknown.orders > 0) {
    rows.push({
      kind: "unknown",
      city: null,
      region: null,
      orders: unknown.orders,
      value: fromCents(unknown.cents),
      avgTicket: average(unknown.cents, unknown.orders),
    });
  }

  return {
    totalOrders: confirmed.length,
    totalValue: fromCents(confirmed.reduce((sum, order) => sum + toCents(order.total), 0)),
    rows,
  };
}

function buildMonthly(confirmed: StoreOrder[], start: Date | null, end: Date, now: Date): StorePanelData["monthly"] {
  const byMonth = new Map<string, { orders: number; cents: number }>();
  for (const order of confirmed) {
    const key = saoPauloMonthKey(new Date(order.createdAt));
    const entry = byMonth.get(key) ?? { orders: 0, cents: 0 };
    entry.orders += 1;
    entry.cents += toCents(order.total);
    byMonth.set(key, entry);
  }

  const firstKey = start ? saoPauloMonthKey(start) : [...byMonth.keys()].sort()[0];
  if (!firstKey) return [];
  const [firstYear, firstMonth] = firstKey.split("-").map(Number) as [number, number];
  const current = saoPauloDate(end);

  const months: StorePanelData["monthly"] = [];
  let year = firstYear;
  let month = firstMonth;
  while (year < current.year || (year === current.year && month <= current.month)) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    const entry = byMonth.get(key);
    months.push({ month: key, orders: entry?.orders ?? 0, revenue: fromCents(entry?.cents ?? 0) });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/** Ficha do pedido, só com o que está no retrato salvo. */
export function buildStoreOrderDetail(order: StoreOrder): StoreOrderDetail {
  const situation = situationOf(order);
  return {
    id: order.id,
    number: order.number,
    createdAt: order.createdAt,
    situation,
    payment: paymentLabelOf(situation),
    delivery: deliveryLabelOf(order, situation),
    confirmedSale: isConfirmedSale(order),
    customer: {
      name: order.customerName,
      email: order.email ?? null,
      phone: order.phone ?? null,
      city: order.city,
      region: order.region,
    },
    contactAvailable: order.email !== undefined || order.phone !== undefined,
    items: order.items.map(item => ({ name: item.name, quantity: item.quantity, value: item.value })),
    amounts: {
      subtotal: order.subtotal ?? null,
      discount: order.discount ?? null,
      shipping: order.shipping,
      shippingMethod: order.shippingMethod ?? null,
      tax: order.tax ?? null,
      total: order.total,
    },
  };
}

export function buildStorePanel(
  allOrders: readonly StoreOrder[],
  {
    period,
    situation = null,
    page = 1,
    now = new Date(),
    dataDe,
    dataAte,
    productKey,
  }: BuildStorePanelOptions,
): StorePanelData {
  const start = dataDe
    ? dateStartInSaoPaulo(dataDe)
    : periodStart(period, now);
  const endExclusive = dataAte ? dateStartInSaoPaulo(addIsoDays(dataAte, 1)) : null;
  const end = dataAte ? dateStartInSaoPaulo(dataAte) : now;
  const startMs = start?.getTime() ?? -Infinity;
  const orders = allOrders
    .filter(order => {
      const createdAt = new Date(order.createdAt).getTime();
      return createdAt >= startMs && (endExclusive === null || createdAt < endExclusive.getTime());
    })
    .filter(order => !productKey || order.items.some(item => productKeyOf(item) === productKey))
    .map(order => ({ order, situation: situationOf(order) }))
    .sort(
      (a, b) =>
        b.order.createdAt.localeCompare(a.order.createdAt) || b.order.id.localeCompare(a.order.id),
    );

  const confirmed = orders.filter(entry => entry.situation === "paid_delivered" || entry.situation === "paid_to_ship");
  const confirmedOrders = confirmed.map(entry => entry.order);
  const revenueCents = confirmedOrders.reduce((sum, order) => sum + toCents(order.total), 0);

  const situationTotals = new Map<StoreSituation, { orders: number; cents: number }>();
  for (const entry of orders) {
    const totals = situationTotals.get(entry.situation) ?? { orders: 0, cents: 0 };
    totals.orders += 1;
    totals.cents += toCents(entry.order.total);
    situationTotals.set(entry.situation, totals);
  }
  const situations = STORE_SITUATIONS.map(key => ({
    situation: key,
    orders: situationTotals.get(key)?.orders ?? 0,
    value: fromCents(situationTotals.get(key)?.cents ?? 0),
  }));
  const valueOf = (key: StoreSituation) => situations.find(entry => entry.situation === key)?.value ?? 0;
  const countOf = (key: StoreSituation) => situations.find(entry => entry.situation === key)?.orders ?? 0;

  const listed = situation ? orders.filter(entry => entry.situation === situation) : orders;
  const totalPages = Math.max(1, Math.ceil(listed.length / STORE_ORDERS_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, Math.trunc(page) || 1), totalPages);
  const rows: StorePanelOrderRow[] = listed
    .slice((currentPage - 1) * STORE_ORDERS_PAGE_SIZE, currentPage * STORE_ORDERS_PAGE_SIZE)
    .map(({ order, situation: rowSituation }) => ({
      id: order.id,
      number: order.number,
      createdAt: order.createdAt,
      customerName: order.customerName,
      items: order.items.map(item => ({ name: item.name, quantity: item.quantity })),
      city: order.city,
      region: order.region,
      total: order.total,
      situation: rowSituation,
      payment: paymentLabelOf(rowSituation),
      delivery: deliveryLabelOf(order, rowSituation),
    }));

  return {
    period,
    periodStart: start?.toISOString() ?? null,
    productOptions: buildProductOptions(allOrders),
    kpis: {
      orders: orders.length,
      confirmedOrders: confirmedOrders.length,
      revenue: fromCents(revenueCents),
      avgTicket: confirmedOrders.length > 0 ? fromCents(Math.round(revenueCents / confirmedOrders.length)) : null,
      awaitingPayment: { orders: countOf("awaiting_payment"), value: valueOf("awaiting_payment") },
      paidToShip: { orders: countOf("paid_to_ship"), value: valueOf("paid_to_ship") },
    },
    situations,
    orders: {
      situation,
      page: currentPage,
      pageSize: STORE_ORDERS_PAGE_SIZE,
      totalPages,
      total: listed.length,
      rows,
    },
    products: buildProducts(confirmedOrders, productKey),
    cities: buildCities(confirmedOrders),
    monthly: buildMonthly(confirmedOrders, start, end, now),
  };
}

function dateStartInSaoPaulo(value: string): Date {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return startOfSaoPauloDay(year, month, day);
}

function addIsoDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
