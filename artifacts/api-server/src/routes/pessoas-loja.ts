import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/roleAuth";
import { listLojaInstrumentos } from "../services/pessoaLojaInstrumentos";

const router: IRouter = Router();

// Compras da loja na ficha (Histórico > Instrumentos). Fica fora de pessoas.ts para não
// arrastar o Painel Loja para as rotas de ficha. O areaGuard já exige a área Pessoas.
router.get("/pessoas/:id/instrumentos-loja", requireAuth, async (req, res): Promise<void> => {
  const raw = String(req.params["id"] ?? "");
  const id = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    res.json(await listLojaInstrumentos(id));
  } catch (err) {
    req.log.error({ err }, "Pessoa store purchases read failed");
    res.status(500).json({ error: "Não foi possível carregar as compras da loja." });
  }
});

export default router;
