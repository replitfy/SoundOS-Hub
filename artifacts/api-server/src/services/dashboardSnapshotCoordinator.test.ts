import { describe, expect, it, vi } from "vitest";
import {
  createDashboardSnapshotCoordinator,
  type DashboardSnapshotPayload,
  type DashboardSnapshotState,
  type DashboardSnapshotStore,
} from "./dashboardSnapshotCoordinator";

const payload: DashboardSnapshotPayload = {
  kpis: { totalRevenue: 100 },
  ordersChart: [{ month: "Set" }],
  alerts: [],
  financeSummary: { totalRevenue: 100 },
  peopleAnalytics: { totalPeople: 10 },
};

function createFakeStore(initial?: DashboardSnapshotState): DashboardSnapshotStore {
  let state: DashboardSnapshotState = initial ?? {
    status: "empty",
    schemaVersion: 1,
    data: null,
    collectedAt: null,
    lastAttemptedAt: null,
    lastError: null,
  };
  let currentOwner: string | null = null;

  return {
    async read() {
      return structuredClone(state);
    },
    async tryClaim(owner, attemptedAt) {
      if (currentOwner) return false;
      currentOwner = owner;
      state = {
        ...state,
        status: "refreshing",
        lastAttemptedAt: attemptedAt.toISOString(),
        lastError: null,
      };
      return true;
    },
    async renewClaim(owner) {
      if (owner !== currentOwner) return;
    },
    async saveSuccess(owner, nextPayload, collectedAt) {
      if (owner !== currentOwner) return;
      state = {
        ...state,
        status: "ready",
        data: nextPayload,
        collectedAt: collectedAt.toISOString(),
        lastError: null,
      };
      currentOwner = null;
    },
    async saveFailure(owner, message) {
      if (owner !== currentOwner) return;
      state = { ...state, status: "error", lastError: message };
      currentOwner = null;
    },
  };
}

describe("dashboard snapshot coordinator", () => {
  it("returns an explicit empty state before the first collection", async () => {
    const coordinator = createDashboardSnapshotCoordinator(createFakeStore(), async () => payload);
    await expect(coordinator.read()).resolves.toMatchObject({
      status: "empty",
      data: null,
      collectedAt: null,
    });
  });

  it("persists one complete payload that another coordinator can read", async () => {
    const store = createFakeStore();
    const firstProcess = createDashboardSnapshotCoordinator(store, async () => payload);
    await expect(firstProcess.refresh()).resolves.toMatchObject({
      status: "ready",
      data: payload,
    });

    const restartedProcess = createDashboardSnapshotCoordinator(store, async () => {
      throw new Error("must not collect while reading");
    });
    await expect(restartedProcess.read()).resolves.toMatchObject({
      status: "ready",
      data: payload,
    });
  });

  it("preserves the previous payload when a refresh fails", async () => {
    const store = createFakeStore();
    await createDashboardSnapshotCoordinator(store, async () => payload).refresh();

    const failing = createDashboardSnapshotCoordinator(store, async () => {
      throw new Error("Omie unavailable");
    });
    await expect(failing.refresh()).resolves.toMatchObject({
      status: "error",
      data: payload,
      lastError: expect.stringContaining("dados anteriores"),
    });
  });

  it("preserves a legacy payload and its collection time when a refresh fails", async () => {
    const collectedAt = "2025-01-15T10:30:00.000Z";
    const store = createFakeStore({
      status: "ready",
      schemaVersion: 1,
      data: payload,
      collectedAt,
      lastAttemptedAt: collectedAt,
      lastError: null,
    });
    const failing = createDashboardSnapshotCoordinator(store, async () => {
      throw new Error("Omie unavailable");
    });

    await expect(failing.refresh()).resolves.toMatchObject({
      status: "error",
      schemaVersion: 1,
      data: payload,
      collectedAt,
      lastError: expect.stringContaining("dados anteriores"),
    });
  });

  it("shares concurrent refreshes and runs the collector once", async () => {
    const store = createFakeStore();
    const collect = vi.fn(async () => payload);
    const coordinator = createDashboardSnapshotCoordinator(store, collect);

    const [first, second] = await Promise.all([
      coordinator.refresh(),
      coordinator.refresh(),
    ]);

    expect(collect).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.status).toBe("ready");
  });
});
