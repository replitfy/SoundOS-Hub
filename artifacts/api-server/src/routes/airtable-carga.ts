import { Router, type IRouter, type Response } from "express";
import { StartAirtableCargaLoadBody } from "@workspace/api-zod";
import { requireAdminRole, type AuthedRequest } from "../middlewares/roleAuth";
import {
  AIRTABLE_CARGA_SETTINGS,
  AirtableLoadError,
  listRuns,
  startRun,
} from "../services/airtableNovosClientes";
import { logger } from "../lib/logger";

// Carga de clientes novos do Airtable (Administração > Manutenção). A área `carga-airtable` é exclusiva de
// administrador e é exigida pelo areaGuard; requireAdminRole repete a checagem na própria rota.
const router: IRouter = Router();

function fail(res: Response, err: unknown): void {
  if (err instanceof AirtableLoadError) {
    res.status(err.httpStatus).json({ error: err.message, code: err.code });
    return;
  }
  // Nunca registre err.message: erros do banco podem citar e-mail ou telefone.
  logger.error({ name: err instanceof Error ? err.name : typeof err }, "Carga do Airtable: erro inesperado na rota");
  res.status(500).json({ error: "Erro interno.", code: "ERRO_INTERNO" });
}

router.get("/admin/airtable-carga", requireAdminRole, async (_req, res): Promise<void> => {
  try {
    res.json({ runs: await listRuns(), settings: AIRTABLE_CARGA_SETTINGS });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/admin/airtable-carga/previews", requireAdminRole, async (req, res): Promise<void> => {
  try {
    const user = (req as AuthedRequest).authedUser!;
    const { run } = await startRun({ kind: "preview", userId: user.id });
    res.status(202).json(run);
  } catch (err) {
    fail(res, err);
  }
});

router.post("/admin/airtable-carga/loads", requireAdminRole, async (req, res): Promise<void> => {
  const parsed = StartAirtableCargaLoadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Informe a prévia e a confirmação.", code: "CORPO_INVALIDO" });
    return;
  }
  try {
    const user = (req as AuthedRequest).authedUser!;
    const { run } = await startRun({
      kind: "load",
      userId: user.id,
      previewRunId: parsed.data.previewRunId,
      restoreConfirmed: parsed.data.restoreConfirmed,
    });
    res.status(202).json(run);
  } catch (err) {
    fail(res, err);
  }
});

export default router;
