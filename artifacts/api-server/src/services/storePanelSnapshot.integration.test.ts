// Regra de "uma atualização automática por dia" e preservação dos dados quando a Wix falha.
// Banco de dev real; cada teste usa uma chave própria de snapshot, apagada no fim.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { dashboardSnapshotsTable, db } from "@workspace/db";
import { like } from "drizzle-orm";
import { startOfSaoPauloDayContaining } from "../lib/saoPauloTime";
import { createPostgresSnapshotStore, snapshotRowToState } from "./postgresSnapshotStore";
import {
  createStorePanelCoordinator,
  isStoreOrdersPayload,
  readStorePanelErrorCode,
  STORE_ORDERS_SCHEMA_VERSION,
  STORE_PANEL_ERROR_MESSAGES,
  type StoreOrdersPayload,
} from "./storePanelSnapshot";
import { WixOrdersError, type StoreOrder } from "./wixOrders";

const prefix = `test-store-orders-${randomUUID().slice(0, 8)}`;
let counter = 0;

function newStore() {
  counter += 1;
  return createPostgresSnapshotStore<StoreOrdersPayload>({
    key: `${prefix}-${counter}`,
    schemaVersion: STORE_ORDERS_SCHEMA_VERSION,
    isPayload: isStoreOrdersPayload,
    interruptedMessage: "interrupted",
  });
}

function order(id: string): StoreOrder {
  return {
    id,
    number: id,
    createdAt: "2026-11-03T16:00:00.000Z",
    customerName: "Cliente",
    status: "APPROVED",
    paymentStatus: "PAID",
    fulfillmentStatus: "FULFILLED",
    total: 100,
    shipping: 10,
    city: "São Paulo",
    region: "SP",
    country: "BR",
    items: [{ name: "Produto", quantity: 1, value: 90, catalogId: "p" }],
  };
}

const todayGate = () => ({ notAttemptedSince: startOfSaoPauloDayContaining(new Date()) });

describe("snapshot do Painel Loja", () => {
  afterAll(async () => {
    await db.delete(dashboardSnapshotsTable).where(like(dashboardSnapshotsTable.key, `${prefix}-%`));
  });

  it("chamadas automáticas simultâneas: só uma reivindica a atualização", async () => {
    const store = newStore();
    const now = new Date();
    const lease = new Date(now.getTime() + 60_000);
    const gate = { notAttemptedSince: startOfSaoPauloDayContaining(now) };

    const results = await Promise.all(
      Array.from({ length: 6 }, () => store.tryClaim(randomUUID(), new Date(), lease, gate)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("depois de uma atualização do dia, a automática é recusada e a manual continua liberada", async () => {
    const store = newStore();
    const owner = randomUUID();
    const first = new Date();
    expect(await store.tryClaim(owner, first, new Date(first.getTime() + 60_000), todayGate())).toBe(true);
    await store.saveSuccess(owner, { orders: [order("a")] }, new Date());

    const again = new Date();
    expect(await store.tryClaim(randomUUID(), again, new Date(again.getTime() + 60_000), todayGate())).toBe(false);

    const manualOwner = randomUUID();
    expect(await store.tryClaim(manualOwner, again, new Date(again.getTime() + 60_000))).toBe(true);
    await store.saveSuccess(manualOwner, { orders: [order("a"), order("b")] }, new Date());
    expect((await store.read()).data?.orders).toHaveLength(2);
  });

  it("a virada do dia é a meia-noite de São Paulo: 23:59:59 bloqueia, 00:00:00 libera", async () => {
    const store = newStore();
    const owner = randomUUID();
    // Primeira tentativa às 23:59:59 de 07/11 em São Paulo (02:59:59Z de 08/11).
    const lastSecond = new Date("2026-11-08T02:59:59.000Z");
    expect(
      await store.tryClaim(owner, lastSecond, new Date(lastSecond.getTime() + 60_000), {
        notAttemptedSince: startOfSaoPauloDayContaining(lastSecond),
      }),
    ).toBe(true);
    await store.saveSuccess(owner, { orders: [] }, lastSecond);

    // Um segundo depois ainda é o mesmo dia civil em UTC, mas já é outro dia em São Paulo.
    const midnight = new Date("2026-11-08T03:00:00.000Z");
    const nextDayOwner = randomUUID();
    expect(
      await store.tryClaim(nextDayOwner, midnight, new Date(midnight.getTime() + 60_000), {
        notAttemptedSince: startOfSaoPauloDayContaining(midnight),
      }),
    ).toBe(true);
    await store.saveSuccess(nextDayOwner, { orders: [] }, midnight);

    // E dentro do dia novo a automática volta a ser recusada.
    const later = new Date("2026-11-08T15:00:00.000Z");
    expect(
      await store.tryClaim(randomUUID(), later, new Date(later.getTime() + 60_000), {
        notAttemptedSince: startOfSaoPauloDayContaining(later),
      }),
    ).toBe(false);
  });

  it("duas instâncias do servidor chamando ao mesmo tempo coletam uma vez só", async () => {
    const store = newStore();
    const collect = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return { orders: [order("a")] };
    });
    const firstProcess = createStorePanelCoordinator(store, collect);
    const secondProcess = createStorePanelCoordinator(store, collect);

    const [one, two] = await Promise.all([
      firstProcess.refresh(todayGate()),
      secondProcess.refresh(todayGate()),
    ]);
    expect(collect).toHaveBeenCalledTimes(1);
    expect([one.status, two.status].every(status => status === "ready" || status === "refreshing")).toBe(true);

    // Recarregar a página ou abrir em outra aba no mesmo dia não coleta de novo.
    const third = await createStorePanelCoordinator(store, collect).refresh(todayGate());
    expect(collect).toHaveBeenCalledTimes(1);
    expect(third.status).toBe("ready");
    expect(third.data?.orders).toHaveLength(1);
  });

  it("tentativa automática que falha mantém os dados anteriores e não é repetida no mesmo dia", async () => {
    const store = newStore();
    const good = createStorePanelCoordinator(store, async () => ({ orders: [order("a"), order("b")] }));
    await good.refresh();
    const loadedAt = (await good.read()).collectedAt;

    const failing = vi.fn(async () => {
      throw new WixOrdersError("credential_refused", "A Wix recusou a credencial da integração.");
    });
    const coordinator = createStorePanelCoordinator(store, failing);

    // A tentativa de hoje já aconteceu (a carga acima): a automática nem chega a coletar.
    const skipped = await coordinator.refresh(todayGate());
    expect(failing).not.toHaveBeenCalled();
    expect(skipped.status).toBe("ready");

    // Manual: falha, mas os pedidos e o horário da última carga boa permanecem.
    const failed = await coordinator.refresh();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(failed.status).toBe("error");
    expect(failed.data?.orders).toHaveLength(2);
    expect(failed.collectedAt).toBe(loadedAt);
    expect(readStorePanelErrorCode(failed.lastError)).toBe("credential_refused");

    // Depois da falha, a automática continua bloqueada até amanhã.
    await coordinator.refresh(todayGate());
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("a primeira tentativa automática do dia que falha não é repetida e o botão manual segue funcionando", async () => {
    const store = newStore();
    const flaky = vi
      .fn<() => Promise<StoreOrdersPayload>>()
      .mockRejectedValueOnce(new WixOrdersError("wix_unavailable", "Wix fora do ar"))
      .mockResolvedValueOnce({ orders: [order("a")] });
    const coordinator = createStorePanelCoordinator(store, flaky);

    const automatic = await coordinator.refresh(todayGate());
    expect(automatic.status).toBe("error");
    expect(automatic.data).toBeNull();
    expect(readStorePanelErrorCode(automatic.lastError)).toBe("wix_unavailable");

    await coordinator.refresh(todayGate());
    expect(flaky).toHaveBeenCalledTimes(1);

    const manual = await coordinator.refresh();
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(manual.status).toBe("ready");
    expect(manual.data?.orders).toHaveLength(1);
  });

  it("estado vazio antes da primeira carga e snapshot de formato antigo é tratado como vazio", async () => {
    const store = newStore();
    expect(await store.read()).toMatchObject({ status: "empty", data: null, collectedAt: null, lastAttemptedAt: null });

    expect(isStoreOrdersPayload({ orders: [{ id: 1 }] })).toBe(false);
    // Retrato salvo antes de e-mail/telefone/valores novos (order() não os tem) continua válido; com os campos novos também.
    expect(isStoreOrdersPayload({ orders: [order("a")] })).toBe(true);
    expect(
      isStoreOrdersPayload({
        orders: [{ ...order("a"), email: null, phone: "+5511999990000", subtotal: 1, discount: null, tax: 0, shippingMethod: "PAC" }],
      }),
    ).toBe(true);
    expect(isStoreOrdersPayload({ orders: [{ ...order("a"), email: 123 }] })).toBe(false);
  });

  it("snapshot pronto com conteúdo de formato antigo aparece como vazio; primeira carga sem conteúdo mantém o status", () => {
    const config = {
      key: "k",
      schemaVersion: STORE_ORDERS_SCHEMA_VERSION,
      isPayload: isStoreOrdersPayload,
      interruptedMessage: "interrupted",
    };
    const base = {
      key: "k",
      schemaVersion: STORE_ORDERS_SCHEMA_VERSION,
      collectedAt: new Date(),
      lastAttemptedAt: new Date(),
      lastError: null,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: new Date(),
    };
    const stale = snapshotRowToState({ ...base, status: "ready", payload: { orders: [{ id: 1 }] } }, config);
    expect(stale).toMatchObject({ status: "empty", data: null, collectedAt: null });

    const outdatedVersion = snapshotRowToState(
      { ...base, schemaVersion: STORE_ORDERS_SCHEMA_VERSION + 1, status: "ready", payload: { orders: [] } },
      config,
    );
    expect(outdatedVersion.status).toBe("empty");

    const firstLoadFailed = snapshotRowToState({ ...base, status: "error", payload: null, lastError: "wix_unavailable" }, config);
    expect(firstLoadFailed).toMatchObject({ status: "error", data: null, lastError: "wix_unavailable" });

    const interrupted = snapshotRowToState(
      { ...base, status: "refreshing", payload: { orders: [] }, leaseUntil: new Date(Date.now() - 1000) },
      config,
    );
    expect(interrupted).toMatchObject({ status: "error", lastError: "interrupted" });
  });

  it("todo código de erro tem mensagem em português e códigos desconhecidos viram erro genérico", () => {
    for (const [code, message] of Object.entries(STORE_PANEL_ERROR_MESSAGES)) {
      expect(readStorePanelErrorCode(code)).toBe(code);
      expect(message.length).toBeGreaterThan(10);
    }
    expect(readStorePanelErrorCode("qualquer coisa")).toBe("unknown");
    expect(readStorePanelErrorCode(null)).toBeNull();
  });
});
