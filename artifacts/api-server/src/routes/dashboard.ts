import { Router, type IRouter, type Request, type Response } from "express";
import { countDistinct } from "drizzle-orm";
import { db, enrollmentsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/roleAuth";
import {
  getDashboardSnapshot,
  refreshDashboardSnapshot,
} from "../services/dashboardSnapshot";
import type { DashboardSnapshotPayload } from "../services/dashboardSnapshotCoordinator";

const router: IRouter = Router();

async function sendSnapshotPart(
  req: Request,
  res: Response,
  select: (payload: DashboardSnapshotPayload) => unknown,
): Promise<void> {
  try {
    const snapshot = await getDashboardSnapshot();
    if (!snapshot.data) {
      res.status(404).json({ error: "O Dashboard ainda não possui um snapshot. Clique em Atualizar." });
      return;
    }
    res.json(select(snapshot.data));
  } catch (error) {
    req.log.error({ err: error }, "Failed to read persisted dashboard snapshot");
    res.status(500).json({ error: "Não foi possível carregar o Dashboard." });
  }
}

router.get("/dashboard/snapshot", requireAuth, async (req, res): Promise<void> => {
  try {
    res.json(await getDashboardSnapshot());
  } catch (error) {
    req.log.error({ err: error }, "Failed to read dashboard snapshot");
    res.status(500).json({ error: "Não foi possível carregar o Dashboard." });
  }
});

router.post("/dashboard/snapshot/refresh", requireAuth, async (req, res): Promise<void> => {
  try {
    const snapshot = await refreshDashboardSnapshot();
    if (snapshot.status === "error") {
      req.log.warn("Dashboard refresh failed; persisted snapshot was preserved");
    }
    res.json(snapshot);
  } catch (error) {
    req.log.error({ err: error }, "Failed to refresh dashboard snapshot");
    res.status(500).json({ error: "Não foi possível atualizar o Dashboard." });
  }
});

router.get("/dashboard/kpis", requireAuth, async (req, res): Promise<void> => {
  await sendSnapshotPart(req, res, payload => payload.kpis);
});

router.get("/dashboard/orders-chart", requireAuth, async (req, res): Promise<void> => {
  await sendSnapshotPart(req, res, payload => payload.ordersChart);
});

router.get("/dashboard/alerts", requireAuth, async (req, res): Promise<void> => {
  await sendSnapshotPart(req, res, payload => payload.alerts);
});

router.get("/dashboard/finance-summary", requireAuth, async (req, res): Promise<void> => {
  await sendSnapshotPart(req, res, payload => payload.financeSummary);
});

router.get("/dashboard/commercial-pipeline", requireAuth, async (_req, res): Promise<void> => {
  const [studentCount] = await db
    .select({ count: countDistinct(enrollmentsTable.pessoaId) })
    .from(enrollmentsTable);
  res.json({
    totalLeads: studentCount.count + 42,
    qualifiedLeads: studentCount.count + 18,
    avgFirstContactMin: 18,
    avgTicket: 2850,
    byCourse: [
      { label: "Formação Básica", value: 28, color: "#5A78A8" },
      { label: "Avançado", value: 18, color: "#1F344D" },
      { label: "Master", value: 9, color: "#C9A45D" },
      { label: "Retiro", value: 6, color: "#5F7F3F" },
    ],
    byStage: [
      { label: "Interesse", value: studentCount.count + 42, color: "#5777A6" },
      { label: "Qualificado", value: studentCount.count + 18, color: "#5A78A8" },
      { label: "Proposta", value: 12, color: "#C9A45D" },
      { label: "Matriculado", value: studentCount.count, color: "#5F7F3F" },
    ],
  });
});

export default router;