import { randomUUID } from "node:crypto";

export type DashboardSnapshotStatus = "empty" | "ready" | "refreshing" | "error";

export interface DashboardSnapshotPayload {
  kpis: Record<string, unknown>;
  ordersChart: Array<Record<string, unknown>>;
  alerts: Array<Record<string, unknown>>;
  financeSummary: Record<string, unknown>;
  peopleAnalytics: Record<string, unknown>;
}

/**
 * Estado persistido de um snapshot. O conteúdo (`data`) varia por tela; o
 * restante (status, horários, último erro) é o mesmo para todas.
 */
export interface SnapshotState<TPayload> {
  status: DashboardSnapshotStatus;
  schemaVersion: number;
  data: TPayload | null;
  collectedAt: string | null;
  lastAttemptedAt: string | null;
  lastError: string | null;
}

/** Condições extras para a reivindicação da atualização, avaliadas de forma atômica no banco. */
export interface SnapshotClaimOptions {
  /**
   * Só reivindica se nenhuma tentativa (bem-sucedida ou não) começou depois
   * deste instante. Usado para limitar uma atualização automática a uma por dia,
   * mesmo com várias abas ou processos chamando ao mesmo tempo.
   */
  notAttemptedSince?: Date;
}

export interface SnapshotStore<TPayload> {
  read(): Promise<SnapshotState<TPayload>>;
  tryClaim(
    owner: string,
    attemptedAt: Date,
    leaseUntil: Date,
    options?: SnapshotClaimOptions,
  ): Promise<boolean>;
  renewClaim(owner: string, leaseUntil: Date): Promise<void>;
  saveSuccess(owner: string, payload: TPayload, collectedAt: Date): Promise<void>;
  saveFailure(owner: string, message: string): Promise<void>;
}

export type DashboardSnapshotState = SnapshotState<DashboardSnapshotPayload>;
export type DashboardSnapshotStore = SnapshotStore<DashboardSnapshotPayload>;
export type DashboardSnapshotCollector = () => Promise<DashboardSnapshotPayload>;

export interface SnapshotCoordinatorOptions {
  leaseMs?: number;
  onCollectionError?: (error: unknown) => void;
  /** Texto gravado em `lastError` quando a coleta falha. */
  failureMessage?: (error: unknown) => string;
}

const DASHBOARD_FAILURE_MESSAGE =
  "Não foi possível atualizar o Dashboard. Os dados anteriores foram mantidos.";

export function createSnapshotCoordinator<TPayload>(
  store: SnapshotStore<TPayload>,
  collect: () => Promise<TPayload>,
  {
    leaseMs = 2 * 60 * 1000,
    onCollectionError = () => {},
    failureMessage = () => DASHBOARD_FAILURE_MESSAGE,
  }: SnapshotCoordinatorOptions = {},
) {
  let refreshInFlight: Promise<SnapshotState<TPayload>> | null = null;

  async function read(): Promise<SnapshotState<TPayload>> {
    return store.read();
  }

  async function refresh(options?: SnapshotClaimOptions): Promise<SnapshotState<TPayload>> {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      const attemptedAt = new Date();
      const owner = randomUUID();
      const claimed = await store.tryClaim(
        owner,
        attemptedAt,
        new Date(attemptedAt.getTime() + leaseMs),
        options,
      );

      if (!claimed) {
        return store.read();
      }

      const heartbeat = setInterval(() => {
        void store
          .renewClaim(owner, new Date(Date.now() + leaseMs))
          .catch(onCollectionError);
      }, Math.max(1_000, Math.floor(leaseMs / 3)));
      heartbeat.unref?.();

      try {
        const payload = await collect();
        await store.saveSuccess(owner, payload, new Date());
      } catch (error) {
        try {
          onCollectionError(error);
        } catch {
          // Observability must never prevent the previous snapshot from being preserved.
        }
        await store.saveFailure(owner, failureMessage(error));
      } finally {
        clearInterval(heartbeat);
      }

      return store.read();
    })();

    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  return { read, refresh };
}

export function createDashboardSnapshotCoordinator(
  store: DashboardSnapshotStore,
  collect: DashboardSnapshotCollector,
  leaseMs = 2 * 60 * 1000,
  onCollectionError: (error: unknown) => void = () => {},
) {
  return createSnapshotCoordinator(store, collect, { leaseMs, onCollectionError });
}
