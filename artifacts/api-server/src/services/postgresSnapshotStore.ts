import { dashboardSnapshotsTable, db, type DashboardSnapshotRow } from "@workspace/db";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { SnapshotState, SnapshotStore } from "./dashboardSnapshotCoordinator";

export interface PostgresSnapshotStoreConfig<TPayload> {
  /** Linha da tabela `dashboard_snapshots` que guarda este snapshot. */
  key: string;
  /** Mudar este número descarta (mostra como vazio) snapshots gravados com formato antigo. */
  schemaVersion: number;
  isPayload: (value: unknown) => value is TPayload;
  /** Texto de `lastError` quando uma atualização morreu sem registrar o fim. */
  interruptedMessage: string;
}

export function snapshotRowToState<TPayload>(
  row: DashboardSnapshotRow | undefined,
  config: PostgresSnapshotStoreConfig<TPayload>,
): SnapshotState<TPayload> {
  if (!row) {
    return {
      status: "empty",
      schemaVersion: config.schemaVersion,
      data: null,
      collectedAt: null,
      lastAttemptedAt: null,
      lastError: null,
    };
  }

  const compatible = row.schemaVersion === config.schemaVersion && config.isPayload(row.payload);
  const leaseExpired =
    row.status === "refreshing" &&
    row.leaseUntil !== null &&
    row.leaseUntil.getTime() <= Date.now();
  // Só um "pronto" com conteúdo de formato antigo vira vazio. Uma primeira carga em
  // andamento ou que falhou (ainda sem conteúdo) mantém o status, para a tela mostrar o motivo.
  const status: SnapshotState<TPayload>["status"] = leaseExpired
    ? "error"
    : compatible || row.status !== "ready"
      ? (row.status as SnapshotState<TPayload>["status"])
      : "empty";

  return {
    status,
    schemaVersion: config.schemaVersion,
    data: compatible ? (row.payload as TPayload) : null,
    collectedAt: compatible && row.collectedAt ? row.collectedAt.toISOString() : null,
    lastAttemptedAt: row.lastAttemptedAt?.toISOString() ?? null,
    lastError: leaseExpired ? config.interruptedMessage : row.lastError,
  };
}

export function createPostgresSnapshotStore<TPayload>(
  config: PostgresSnapshotStoreConfig<TPayload>,
): SnapshotStore<TPayload> {
  const { key, schemaVersion } = config;
  const table = dashboardSnapshotsTable;

  return {
    async read() {
      const [row] = await db.select().from(table).where(eq(table.key, key)).limit(1);
      return snapshotRowToState(row, config);
    },

    async tryClaim(owner, attemptedAt, leaseUntil, options) {
      await db
        .insert(table)
        .values({ key, schemaVersion, status: "empty" })
        .onConflictDoNothing();

      const [claimed] = await db
        .update(table)
        .set({
          status: "refreshing",
          lastAttemptedAt: attemptedAt,
          lastError: null,
          leaseOwner: owner,
          leaseUntil,
          updatedAt: attemptedAt,
        })
        .where(and(
          eq(table.key, key),
          or(isNull(table.leaseUntil), lt(table.leaseUntil, attemptedAt)),
          // A condição de "não tentado desde" fica no mesmo UPDATE da reivindicação:
          // duas chamadas simultâneas nunca passam as duas.
          options?.notAttemptedSince
            ? or(isNull(table.lastAttemptedAt), lt(table.lastAttemptedAt, options.notAttemptedSince))
            : undefined,
        ))
        .returning({ key: table.key });
      return Boolean(claimed);
    },

    async renewClaim(owner, leaseUntil) {
      await db
        .update(table)
        .set({ leaseUntil, updatedAt: new Date() })
        .where(and(eq(table.key, key), eq(table.leaseOwner, owner)));
    },

    async saveSuccess(owner, payload, collectedAt) {
      await db
        .update(table)
        .set({
          schemaVersion,
          payload,
          status: "ready",
          collectedAt,
          lastError: null,
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: collectedAt,
        })
        .where(and(eq(table.key, key), eq(table.leaseOwner, owner)));
    },

    async saveFailure(owner, message) {
      await db
        .update(table)
        .set({
          status: "error",
          lastError: message,
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: new Date(),
        })
        .where(and(eq(table.key, key), eq(table.leaseOwner, owner)));
    },
  };
}
