import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../middlewares/roleAuth";
import {
  buildStoreOrderDetail,
  buildStorePanel,
  DEFAULT_STORE_PANEL_PERIOD,
  STORE_PANEL_PERIODS,
  STORE_SITUATIONS,
} from "../services/storePanel";
import {
  getStorePanelSnapshot,
  readStorePanelErrorCode,
  refreshStorePanelSnapshot,
  STORE_PANEL_ERROR_MESSAGES,
  type StorePanelSnapshotState,
} from "../services/storePanelSnapshot";
import { linkOrdersToPessoas, type OrderPessoaLink } from "../services/storeOrderPessoa";
import { getPublishedCatalog, WixCatalogError } from "../services/wixCatalog";
import { createIncompleteProductsWorkbook } from "../services/productCompletenessReport";

const router: IRouter = Router();

const MOCK_ORDERS = [
  { id: 1, externalRef: "WX-00142", customer: "Ana Lima", product: "Tigela Tibetana G", status: "shipped", total: 380.0, date: "2026-07-08", paymentMethod: "cartão" },
  { id: 2, externalRef: "WX-00141", customer: "Carlos Menezes", product: "Kit Iniciante", status: "paid", total: 520.0, date: "2026-07-07", paymentMethod: "pix" },
  { id: 3, externalRef: "WX-00140", customer: "Fernanda Costa", product: "Óleo Essencial", status: "pending", total: 95.0, date: "2026-07-06", paymentMethod: null },
  { id: 4, externalRef: "WX-00139", customer: "Roberto Silva", product: "Diapasão 432Hz", status: "delivered", total: 240.0, date: "2026-07-05", paymentMethod: "pix" },
  { id: 5, externalRef: "WX-00138", customer: "Mariana Souza", product: "Tibela de Cristal", status: "shipped", total: 890.0, date: "2026-07-04", paymentMethod: "cartão" },
  { id: 6, externalRef: "WX-00137", customer: "Paulo Alves", product: "Curso Online", status: "paid", total: 350.0, date: "2026-07-03", paymentMethod: "boleto" },
  { id: 7, externalRef: "WX-00136", customer: "Juliana Ramos", product: "Tigela Tibetana P", status: "cancelled", total: 180.0, date: "2026-07-02", paymentMethod: "cartão" },
  { id: 8, externalRef: "WX-00135", customer: "Diego Ferreira", product: "Kit Chakra", status: "delivered", total: 620.0, date: "2026-07-01", paymentMethod: "pix" },
];

const MOCK_CUSTOMERS = [
  { id: 1, name: "Ana Lima", email: "ana@email.com", phone: "(11) 99999-0001", soundsBalance: 120, isStudent: true, totalOrders: 5 },
  { id: 2, name: "Carlos Menezes", email: "carlos@email.com", phone: "(11) 99999-0002", soundsBalance: 80, isStudent: false, totalOrders: 3 },
  { id: 3, name: "Fernanda Costa", email: "fernanda@email.com", phone: "(21) 99999-0003", soundsBalance: 0, isStudent: true, totalOrders: 1 },
  { id: 4, name: "Roberto Silva", email: "roberto@email.com", phone: "(31) 99999-0004", soundsBalance: 200, isStudent: true, totalOrders: 8 },
  { id: 5, name: "Mariana Souza", email: "mariana@email.com", phone: "(11) 99999-0005", soundsBalance: 50, isStudent: false, totalOrders: 2 },
  { id: 6, name: "Paulo Alves", email: "paulo@email.com", phone: "(41) 99999-0006", soundsBalance: 350, isStudent: true, totalOrders: 12 },
];

const panelQuerySchema = z.object({
  period: z.enum(STORE_PANEL_PERIODS).default(DEFAULT_STORE_PANEL_PERIOD),
  situation: z.enum(STORE_SITUATIONS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  dataDe: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dataAte: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  product: z.string().min(1).max(500).optional(),
}).refine(
  query => (!query.dataDe || !query.dataAte || query.dataDe <= query.dataAte)
    && [query.dataDe, query.dataAte].filter(Boolean).every(value => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    }),
);

const refreshQuerySchema = z.object({
  trigger: z.enum(["manual", "automatic"]).default("manual"),
});

function panelMeta(state: StorePanelSnapshotState) {
  const errorCode = readStorePanelErrorCode(state.lastError);
  return {
    status: state.status,
    schemaVersion: state.schemaVersion,
    collectedAt: state.collectedAt,
    lastAttemptedAt: state.lastAttemptedAt,
    lastError: errorCode ? STORE_PANEL_ERROR_MESSAGES[errorCode] : null,
    lastErrorCode: errorCode,
  };
}

/** Só quem tem a área Pessoas vê qualquer coisa de ficha, inclusive se existe. */
function canSeePessoas(req: AuthedRequest): boolean {
  return req.authedUser?.areas.includes("pessoas") ?? false;
}

router.get("/store/panel", requireAuth, async (req, res): Promise<void> => {
  const query = panelQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Filtros do Painel Loja inválidos." });
    return;
  }
  try {
    const state = await getStorePanelSnapshot();
    if (!state.data) {
      res.json({ ...panelMeta(state), data: null });
      return;
    }
    const data = buildStorePanel(state.data.orders, {
      period: query.data.period,
      situation: query.data.situation ?? null,
      page: query.data.page,
      dataDe: query.data.dataDe,
      dataAte: query.data.dataAte,
      productKey: query.data.product,
    });
    if (canSeePessoas(req) && data.orders.rows.length > 0) {
      const byId = new Map(state.data.orders.map(order => [order.id, order]));
      const listed = data.orders.rows.flatMap(row => byId.get(row.id) ?? []);
      const links = await linkOrdersToPessoas(listed);
      data.orders.rows = data.orders.rows.map(row => {
        const link = links.get(row.id);
        return {
          ...row,
          pessoaLink: link?.state === "linked" ? { mode: link.mode, similarity: link.similarity } : null,
        };
      });
    }
    res.json({ ...panelMeta(state), data });
  } catch (err) {
    req.log.error({ err }, "Store panel read failed");
    res.status(500).json({ error: "Não foi possível carregar o Painel Loja." });
  }
});

router.get("/store/panel/orders/:orderId", requireAuth, async (req, res): Promise<void> => {
  const orderId = String(req.params["orderId"] ?? "");
  try {
    // Lê só o retrato salvo: abrir a ficha do pedido nunca chama a Wix.
    const state = await getStorePanelSnapshot();
    const order = state.data?.orders.find(candidate => candidate.id === orderId);
    if (!order) {
      res.status(404).json({ error: "Pedido não encontrado." });
      return;
    }
    const detail = buildStoreOrderDetail(order);
    if (!canSeePessoas(req)) {
      res.json(detail);
      return;
    }
    const link: OrderPessoaLink = (await linkOrdersToPessoas([order])).get(order.id) ?? { state: "none" };
    res.json({ ...detail, pessoa: link });
  } catch (err) {
    req.log.error({ err }, "Store panel order read failed");
    res.status(500).json({ error: "Não foi possível carregar o pedido." });
  }
});

router.post("/store/panel/refresh", requireAuth, async (req, res): Promise<void> => {
  const query = refreshQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Gatilho de atualização inválido." });
    return;
  }
  try {
    // Falha da Wix não vira erro HTTP: o estado devolvido traz o motivo e os dados anteriores seguem valendo.
    res.json(panelMeta(await refreshStorePanelSnapshot(query.data.trigger)));
  } catch (err) {
    req.log.error({ err }, "Store panel refresh failed");
    res.status(500).json({ error: "Não foi possível atualizar o Painel Loja." });
  }
});

router.get("/store/orders", requireAuth, async (req, res): Promise<void> => {
  const { status, limit = "50", offset = "0" } = req.query as { status?: string; limit?: string; offset?: string };
  let orders = MOCK_ORDERS;
  if (status) {
    orders = orders.filter(o => o.status === status);
  }
  const lim = parseInt(limit, 10);
  const off = parseInt(offset, 10);
  res.json(orders.slice(off, off + lim));
});

router.get("/store/products", requireAuth, async (req, res): Promise<void> => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim().toLocaleLowerCase("pt-BR") : "";
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const snapshot = await getPublishedCatalog();
    const filtered = search
      ? snapshot.products.filter(product => {
          const haystack = [product.name, product.description ?? "", ...product.skus]
            .join(" ")
            .toLocaleLowerCase("pt-BR");
          return haystack.includes(search);
        })
      : snapshot.products;
    res.json({
      source: snapshot.source,
      lastUpdated: snapshot.lastUpdated,
      inventory: snapshot.inventory,
      totalRegistered: snapshot.totalRegistered,
      totalPublished: snapshot.products.length,
      totalHidden: snapshot.totalHidden,
      total: filtered.length,
      products: filtered.slice(offset, offset + limit),
    });
  } catch (err) {
    const status = err instanceof WixCatalogError ? err.statusCode : 502;
    const message = err instanceof Error ? err.message : "Falha ao consultar o catálogo Wix.";
    req.log.error({ err }, "Wix catalog request failed");
    res.status(status).json({ error: message });
  }
});

router.get("/store/products/incomplete-export", requireAuth, async (req, res): Promise<void> => {
  try {
    const snapshot = await getPublishedCatalog();
    const workbook = createIncompleteProductsWorkbook(snapshot);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="produtos-pendencias-wix-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    );
    res.send(workbook);
  } catch (err) {
    const status = err instanceof WixCatalogError ? err.statusCode : 502;
    const message = err instanceof Error ? err.message : "Falha ao gerar o relatório de produtos.";
    req.log.error({ err }, "Wix incomplete product report failed");
    res.status(status).json({ error: message });
  }
});

router.get("/store/customers", requireAuth, async (_req, res): Promise<void> => {
  res.json(MOCK_CUSTOMERS);
});

export default router;
