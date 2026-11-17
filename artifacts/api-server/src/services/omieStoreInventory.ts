import {
  hasOmieStoreCredentials,
  listarTodaPosicaoEstoque,
  type OmieProdutoEstoqueRaw,
} from "../lib/omie";

const TIME_ZONE = "America/Sao_Paulo";
const SCHEDULE_HOUR = 23;
const SCHEDULE_MINUTE = 0;
const zonedPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const omieDateFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

export type OmieInventoryStatus = "linked" | "zero" | "not_linked" | "stale" | "error";

export type OmieProductInventory = {
  source: "omie-store";
  status: OmieInventoryStatus;
  quantity: number | null;
  physicalQuantity: number | null;
  reservedQuantity: number | null;
  pendingQuantity: number | null;
  minimumQuantity: number | null;
  unit: string | null;
  matchedSkus: string[];
  lastUpdated: string | null;
};

export type StoreInventorySyncSummary = {
  source: "omie-store";
  status: "ok" | "error";
  lastUpdated: string | null;
  lastAttemptedAt: string | null;
  totalItems: number;
  error: string | null;
  nextRefreshAt: string;
};

type AggregatedInventoryItem = {
  code: string;
  quantity: number;
  physicalQuantity: number;
  reservedQuantity: number;
  pendingQuantity: number;
  minimumQuantity: number;
};

type InventorySnapshot = {
  status: "ok" | "error";
  lastUpdated: string | null;
  lastAttemptedAt: string | null;
  hasValidSnapshot: boolean;
  error: string | null;
  bySku: Map<string, AggregatedInventoryItem>;
};

const EMPTY_SNAPSHOT: InventorySnapshot = {
  status: "error",
  lastUpdated: null,
  lastAttemptedAt: null,
  hasValidSnapshot: false,
  error: "O estoque Omie Store ainda não foi sincronizado.",
  bySku: new Map(),
};

let inventorySnapshot: InventorySnapshot = EMPTY_SNAPSHOT;
let refreshInFlight: Promise<InventorySnapshot> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeSku(value: string): string {
  return value.trim().toLocaleUpperCase("pt-BR");
}

function numberOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Linhas repetidas representam locais de estoque distintos. Elas são somadas
 * por código para produzir uma única posição por SKU.
 */
export function aggregateInventoryRows(rows: OmieProdutoEstoqueRaw[]): Map<string, AggregatedInventoryItem> {
  const bySku = new Map<string, AggregatedInventoryItem>();
  for (const row of rows) {
    const code = row.cCodigo?.trim();
    if (!code) continue;
    const key = normalizeSku(code);
    const current = bySku.get(key) ?? {
      code,
      quantity: 0,
      physicalQuantity: 0,
      reservedQuantity: 0,
      pendingQuantity: 0,
      minimumQuantity: 0,
    };
    current.quantity += numberOrZero(row.nSaldo);
    current.physicalQuantity += numberOrZero(row.fisico);
    current.reservedQuantity += numberOrZero(row.reservado);
    current.pendingQuantity += numberOrZero(row.nPendente);
    current.minimumQuantity += numberOrZero(row.estoque_minimo);
    bySku.set(key, current);
  }
  return bySku;
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
  let target = targetForDay(local.day);
  if (target <= now.getTime()) target = targetForDay(local.day + 1);
  return target;
}

export function getNextStoreInventoryRefreshAt(now = new Date()): string {
  return new Date(nextDailyRefreshTimestamp(now)).toISOString();
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.includes("Credenciais Omie")) {
    return "A integração Omie Store não está configurada.";
  }
  return "Não foi possível atualizar o estoque Omie Store.";
}

export async function refreshStoreInventory(
  loader: typeof listarTodaPosicaoEstoque = listarTodaPosicaoEstoque,
): Promise<InventorySnapshot> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const attemptedAt = new Date().toISOString();
    try {
      if (!hasOmieStoreCredentials()) {
        throw new Error("Credenciais Omie Store não configuradas.");
      }
      const rows = await loader("store", omieDateFormatter.format(new Date()));
      inventorySnapshot = {
        status: "ok",
        lastUpdated: attemptedAt,
        lastAttemptedAt: attemptedAt,
        hasValidSnapshot: true,
        error: null,
        bySku: aggregateInventoryRows(rows),
      };
    } catch (error) {
      inventorySnapshot = {
        ...inventorySnapshot,
        status: "error",
        lastAttemptedAt: attemptedAt,
        error: safeErrorMessage(error),
      };
    }
    return inventorySnapshot;
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
    `[omie-store-inventory] próxima atualização: ${new Date(nextRefreshAt).toISOString()} (23:00 America/Sao_Paulo)`,
  );
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    const before = inventorySnapshot.lastUpdated;
    await refreshStoreInventory();
    if (inventorySnapshot.status === "ok" && inventorySnapshot.lastUpdated !== before) {
      console.info("[omie-store-inventory] estoque atualizado às 23:00 America/Sao_Paulo");
    } else {
      console.error("[omie-store-inventory] atualização diária falhou; mantendo snapshot anterior");
    }
    scheduleDailyRefresh();
  }, delay);
  refreshTimer.unref?.();
}

async function getInventorySnapshot(): Promise<InventorySnapshot> {
  scheduleDailyRefresh();
  if (inventorySnapshot.lastAttemptedAt === null) {
    return refreshStoreInventory();
  }
  return inventorySnapshot;
}

export async function getStoreInventorySummary(): Promise<StoreInventorySyncSummary> {
  const snapshot = await getInventorySnapshot();
  return {
    source: "omie-store",
    status: snapshot.status,
    lastUpdated: snapshot.lastUpdated,
    lastAttemptedAt: snapshot.lastAttemptedAt,
    totalItems: snapshot.bySku.size,
    error: snapshot.error,
    nextRefreshAt: getNextStoreInventoryRefreshAt(),
  };
}

/**
 * Produtos Wix com variantes consolidam todos os SKUs correspondentes. Cada
 * SKU Omie entra uma única vez no total, mesmo se estiver repetido na Wix.
 */
export async function getProductInventory(skus: string[]): Promise<OmieProductInventory> {
  const snapshot = await getInventorySnapshot();
  const uniqueSkus = [...new Map(
    skus
      .map(sku => sku.trim())
      .filter(Boolean)
      .map(sku => [normalizeSku(sku), sku]),
  ).entries()];
  const matches = uniqueSkus
    .map(([normalizedSku, originalSku]) => ({
      originalSku,
      item: snapshot.bySku.get(normalizedSku),
    }))
    .filter((match): match is { originalSku: string; item: AggregatedInventoryItem } => Boolean(match.item));

  if (matches.length === 0) {
    return {
      source: "omie-store",
      status: snapshot.hasValidSnapshot ? "not_linked" : "error",
      quantity: null,
      physicalQuantity: null,
      reservedQuantity: null,
      pendingQuantity: null,
      minimumQuantity: null,
      unit: null,
      matchedSkus: [],
      lastUpdated: snapshot.lastUpdated,
    };
  }

  const quantity = matches.reduce((sum, match) => sum + match.item.quantity, 0);
  return {
    source: "omie-store",
    status: snapshot.status === "error" ? "stale" : quantity <= 0 ? "zero" : "linked",
    quantity,
    physicalQuantity: matches.reduce((sum, match) => sum + match.item.physicalQuantity, 0),
    reservedQuantity: matches.reduce((sum, match) => sum + match.item.reservedQuantity, 0),
    pendingQuantity: matches.reduce((sum, match) => sum + match.item.pendingQuantity, 0),
    minimumQuantity: matches.reduce((sum, match) => sum + match.item.minimumQuantity, 0),
    unit: null,
    matchedSkus: matches.map(match => match.originalSku),
    lastUpdated: snapshot.lastUpdated,
  };
}

export function resetStoreInventoryForTests(): void {
  inventorySnapshot = EMPTY_SNAPSHOT;
}

// O agendamento nasce com o backend, independentemente de alguém abrir a tela.
scheduleDailyRefresh();