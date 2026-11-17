import { z } from "zod";
import { logger } from "../lib/logger";
import { startOfSaoPauloDayContaining } from "../lib/saoPauloTime";
import {
  createSnapshotCoordinator,
  type SnapshotState,
  type SnapshotStore,
} from "./dashboardSnapshotCoordinator";
import { createPostgresSnapshotStore } from "./postgresSnapshotStore";
import { fetchWixOrders, WixOrdersError, type StoreOrder } from "./wixOrders";

/**
 * Pedidos do Painel Loja guardados como snapshot no banco (mesma tabela e
 * mesmo mecanismo do Dashboard). A tela nunca consulta a Wix ao abrir: lê o
 * último snapshot e só atualiza por ação do usuário ou na primeira abertura do dia.
 */
export const STORE_ORDERS_SNAPSHOT_KEY = "store-orders";
export const STORE_ORDERS_SCHEMA_VERSION = 1;

export interface StoreOrdersPayload {
  orders: StoreOrder[];
}

export type StorePanelErrorCode = WixOrdersError["code"] | "interrupted" | "unknown";

export const STORE_PANEL_ERROR_MESSAGES: Record<StorePanelErrorCode, string> = {
  not_configured: "A integração com a Wix não está configurada. Peça a um administrador para configurá-la.",
  credential_refused: "A Wix recusou a credencial da integração. Peça a um administrador para conferir a chave de acesso.",
  wix_unavailable: "A Wix não respondeu agora. Tente atualizar novamente em alguns minutos.",
  too_many_orders: "A loja tem mais pedidos do que o painel consegue ler com segurança.",
  unexpected_response: "A Wix devolveu pedidos em um formato inesperado.",
  unsupported_currency: "Há pedidos em outra moeda; o painel só soma valores em reais.",
  interrupted: "A atualização anterior foi interrompida antes de terminar.",
  unknown: "Não foi possível atualizar o Painel Loja.",
};

const finite = z.number().refine(Number.isFinite);
const nullableText = z.string().nullable();

const storeOrderSchema = z.object({
  id: z.string(),
  number: z.string(),
  createdAt: z.string().refine(value => !Number.isNaN(new Date(value).getTime())),
  customerName: nullableText,
  status: z.string(),
  paymentStatus: z.string(),
  fulfillmentStatus: z.string(),
  total: finite,
  shipping: finite,
  // Opcionais: o retrato salvo antes destes campos continua válido até a próxima atualização.
  email: nullableText.optional(),
  phone: nullableText.optional(),
  subtotal: finite.nullable().optional(),
  discount: finite.nullable().optional(),
  tax: finite.nullable().optional(),
  shippingMethod: nullableText.optional(),
  city: nullableText,
  region: nullableText,
  country: nullableText,
  items: z.array(
    z.object({
      name: z.string(),
      quantity: finite,
      value: finite,
      catalogId: nullableText,
    }),
  ),
});
const payloadSchema = z.object({ orders: z.array(storeOrderSchema) });

export function isStoreOrdersPayload(value: unknown): value is StoreOrdersPayload {
  return payloadSchema.safeParse(value).success;
}

/** O que fica gravado em `lastError`: só o código; o texto é montado na leitura. */
export function storePanelErrorCodeOf(error: unknown): StorePanelErrorCode {
  return error instanceof WixOrdersError ? error.code : "unknown";
}

export function readStorePanelErrorCode(stored: string | null): StorePanelErrorCode | null {
  if (!stored) return null;
  return stored in STORE_PANEL_ERROR_MESSAGES ? (stored as StorePanelErrorCode) : "unknown";
}

const store: SnapshotStore<StoreOrdersPayload> = createPostgresSnapshotStore<StoreOrdersPayload>({
  key: STORE_ORDERS_SNAPSHOT_KEY,
  schemaVersion: STORE_ORDERS_SCHEMA_VERSION,
  isPayload: isStoreOrdersPayload,
  interruptedMessage: "interrupted",
});

export function createStorePanelCoordinator(
  snapshotStore: SnapshotStore<StoreOrdersPayload>,
  collect: () => Promise<StoreOrdersPayload>,
) {
  return createSnapshotCoordinator(snapshotStore, collect, {
    // Leitura de ~260 pedidos leva poucos segundos; o limite cobre lojas bem maiores.
    leaseMs: 3 * 60 * 1000,
    failureMessage: storePanelErrorCodeOf,
    onCollectionError: error => {
      // Só o código e a mensagem própria: nada de requisição, que carrega a credencial.
      logger.error(
        { code: storePanelErrorCodeOf(error), message: error instanceof Error ? error.message : String(error) },
        "[store-panel] order collection failed",
      );
    },
  });
}

const coordinator = createStorePanelCoordinator(store, async () => ({ orders: await fetchWixOrders() }));

export type StorePanelSnapshotState = SnapshotState<StoreOrdersPayload>;

export async function getStorePanelSnapshot(): Promise<StorePanelSnapshotState> {
  return coordinator.read();
}

export type StorePanelRefreshTrigger = "manual" | "automatic";

/**
 * Atualização manual roda sempre que ninguém mais estiver atualizando. A
 * automática exige que nenhuma tentativa (qualquer usuário, aba ou resultado)
 * tenha começado desde a meia-noite de São Paulo; a checagem é atômica no banco.
 */
export function refreshStorePanelSnapshot(
  trigger: StorePanelRefreshTrigger,
  now: Date = new Date(),
): Promise<StorePanelSnapshotState> {
  return coordinator.refresh(
    trigger === "automatic" ? { notAttemptedSince: startOfSaoPauloDayContaining(now) } : undefined,
  );
}
