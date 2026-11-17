import { Router, type IRouter } from "express";
import { requireArea } from "../middlewares/roleAuth";
import { agregarTitulos, listarClientes, listarContasPagar, listarContasReceber, listarContasCorrentesDiag, resolverNomesClientes, resumirTitulos, OmieError, OMIE_BASE_NAMES, type OmieBase } from "../lib/omie";
import {
  getFinancialSnapshot,
  listPersistedFinancialAccounts,
  refreshFinancialSnapshot,
  type FinancialSnapshotFilters,
} from "../services/financialLedger";

// Dados financeiros do Omie pertencem à tela Visão Financeira (não exigem perfil administrador).
const requireFinanceiro = requireArea("visao-financeira");

const router: IRouter = Router();

const BASES: OmieBase[] = ["education", "store"];

function isOmieBase(value: string): value is OmieBase {
  return (BASES as string[]).includes(value);
}

const CR_STATUSES: string[] = ["RECEBIDO", "AVENCER", "ATRASADO", "CANCELADO"];
const CP_STATUSES: string[] = ["PAGO", "AVENCER", "ATRASADO", "CANCELADO"];

function parseIsoDateToOmie(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

router.get("/admin/omie/status", requireFinanceiro, async (req, res): Promise<void> => {
  const results = await Promise.all(
    BASES.map(async (base) => {
      try {
        const data = await listarClientes(base, 1, 1);
        return {
          base,
          name: OMIE_BASE_NAMES[base],
          connected: true,
          totalClientes: data.total_de_registros ?? 0,
          error: null,
        };
      } catch (err) {
        const message = err instanceof OmieError ? err.message : "Erro inesperado ao verificar conexão.";
        req.log.error({ err, base }, "Omie status check failed");
        return { base, name: OMIE_BASE_NAMES[base], connected: false, totalClientes: null, error: message };
      }
    }),
  );
  res.json(results);
});

router.get("/admin/omie/:base/clientes", requireFinanceiro, async (req, res): Promise<void> => {
  const base = String(req.params.base);
  if (!isOmieBase(base)) {
    res.status(400).json({ error: "Base inválida. Use 'education' ou 'store'." });
    return;
  }

  const pagina = Math.max(1, parseInt(String(req.query.pagina ?? "1"), 10) || 1);
  const rppRaw = parseInt(String(req.query.registrosPorPagina ?? "20"), 10) || 20;
  const registrosPorPagina = Math.min(100, Math.max(1, rppRaw));

  try {
    const data = await listarClientes(base, pagina, registrosPorPagina);
    res.json({
      pagina: data.pagina ?? pagina,
      totalDePaginas: data.total_de_paginas ?? 0,
      registros: data.registros ?? 0,
      totalDeRegistros: data.total_de_registros ?? 0,
      clientes: (data.clientes_cadastro ?? []).map((c) => ({
        codigo: c.codigo_cliente_omie,
        razaoSocial: c.razao_social ?? "—",
        nomeFantasia: c.nome_fantasia || null,
        email: c.email || null,
        cnpjCpf: c.cnpj_cpf || null,
        cidade: c.cidade || null,
      })),
    });
  } catch (err) {
    const message = err instanceof OmieError ? err.message : "Erro inesperado ao consultar a API Omie.";
    req.log.error({ err, base }, "Omie ListarClientes failed");
    res.status(502).json({ error: message });
  }
});

router.get("/admin/omie/:base/contas-receber", requireFinanceiro, async (req, res): Promise<void> => {
  const base = String(req.params.base);
  if (!isOmieBase(base)) {
    res.status(400).json({ error: "Base inválida. Use 'education' ou 'store'." });
    return;
  }

  const pagina = Math.max(1, parseInt(String(req.query.pagina ?? "1"), 10) || 1);
  const rppRaw = parseInt(String(req.query.registrosPorPagina ?? "20"), 10) || 20;
  const registrosPorPagina = Math.min(100, Math.max(1, rppRaw));

  const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
  if (statusRaw !== undefined && !CR_STATUSES.includes(statusRaw)) {
    res.status(400).json({ error: "Status inválido. Use RECEBIDO, AVENCER, ATRASADO ou CANCELADO." });
    return;
  }
  const dataDe = parseIsoDateToOmie(req.query.dataDe);
  const dataAte = parseIsoDateToOmie(req.query.dataAte);
  if (dataDe === null || dataAte === null) {
    res.status(400).json({ error: "Data inválida. Use o formato YYYY-MM-DD." });
    return;
  }

  try {
    const data = await listarContasReceber(base, pagina, registrosPorPagina, {
      status: statusRaw,
      dataDe,
      dataAte,
    });
    const titulosRaw = data.conta_receber_cadastro ?? [];
    const codigosClientes = titulosRaw
      .map((t) => t.codigo_cliente_fornecedor)
      .filter((c): c is number => typeof c === "number" && c > 0);
    const nomes = await resolverNomesClientes(base, codigosClientes, (codigo, err) => {
      req.log.error({ err, base, codigo }, "Omie ConsultarCliente failed while resolving client name");
    });
    res.json({
      pagina: data.pagina ?? pagina,
      totalDePaginas: data.total_de_paginas ?? 0,
      registros: data.registros ?? 0,
      totalDeRegistros: data.total_de_registros ?? 0,
      titulos: titulosRaw.map((t) => ({
        codigoLancamento: t.codigo_lancamento_omie,
        nomeCliente: (t.codigo_cliente_fornecedor != null ? nomes.get(t.codigo_cliente_fornecedor) : null) ?? null,
        numeroDocumento: t.numero_documento_fiscal || null,
        numeroParcela: t.numero_parcela || null,
        dataEmissao: t.data_emissao || null,
        dataVencimento: t.data_vencimento || null,
        valorDocumento: t.valor_documento ?? 0,
        statusTitulo: t.status_titulo || null,
      })),
    });
  } catch (err) {
    const message = err instanceof OmieError ? err.message : "Erro inesperado ao consultar a API Omie.";
    req.log.error({ err, base }, "Omie ListarContasReceber failed");
    res.status(502).json({ error: message });
  }
});

function makeResumoHandler(tipo: "receber" | "pagar", statuses: string[]) {
  return async (req: import("express").Request, res: import("express").Response): Promise<void> => {
    const base = String(req.params.base);
    if (!isOmieBase(base)) {
      res.status(400).json({ error: "Base inválida. Use 'education' ou 'store'." });
      return;
    }

    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    if (statusRaw !== undefined && !statuses.includes(statusRaw)) {
      res.status(400).json({ error: `Status inválido. Use ${statuses.join(", ")}.` });
      return;
    }
    const dataDe = parseIsoDateToOmie(req.query.dataDe);
    const dataAte = parseIsoDateToOmie(req.query.dataAte);
    if (dataDe === null || dataAte === null) {
      res.status(400).json({ error: "Data inválida. Use o formato YYYY-MM-DD." });
      return;
    }

    try {
      const resumo = await resumirTitulos(base, tipo, { status: statusRaw, dataDe, dataAte });
      res.json(resumo);
    } catch (err) {
      const message = err instanceof OmieError ? err.message : "Erro inesperado ao consultar a API Omie.";
      req.log.error({ err, base, tipo }, "Omie resumo de títulos failed");
      res.status(502).json({ error: message });
    }
  };
}

router.get("/admin/omie/:base/contas-receber/resumo", requireFinanceiro, makeResumoHandler("receber", CR_STATUSES));
router.get("/admin/omie/:base/contas-pagar/resumo", requireFinanceiro, makeResumoHandler("pagar", CP_STATUSES));

router.get("/admin/omie/:base/contas-pagar", requireFinanceiro, async (req, res): Promise<void> => {
  const base = String(req.params.base);
  if (!isOmieBase(base)) {
    res.status(400).json({ error: "Base inválida. Use 'education' ou 'store'." });
    return;
  }

  const pagina = Math.max(1, parseInt(String(req.query.pagina ?? "1"), 10) || 1);
  const rppRaw = parseInt(String(req.query.registrosPorPagina ?? "20"), 10) || 20;
  const registrosPorPagina = Math.min(100, Math.max(1, rppRaw));

  const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
  if (statusRaw !== undefined && !CP_STATUSES.includes(statusRaw)) {
    res.status(400).json({ error: "Status inválido. Use PAGO, AVENCER, ATRASADO ou CANCELADO." });
    return;
  }
  const dataDe = parseIsoDateToOmie(req.query.dataDe);
  const dataAte = parseIsoDateToOmie(req.query.dataAte);
  if (dataDe === null || dataAte === null) {
    res.status(400).json({ error: "Data inválida. Use o formato YYYY-MM-DD." });
    return;
  }

  try {
    const data = await listarContasPagar(base, pagina, registrosPorPagina, {
      status: statusRaw,
      dataDe,
      dataAte,
    });
    res.json({
      pagina: data.pagina ?? pagina,
      totalDePaginas: data.total_de_paginas ?? 0,
      registros: data.registros ?? 0,
      totalDeRegistros: data.total_de_registros ?? 0,
      titulos: (data.conta_pagar_cadastro ?? []).map((t) => ({
        codigoLancamento: t.codigo_lancamento_omie,
        numeroDocumento: t.numero_documento_fiscal || null,
        numeroParcela: t.numero_parcela || null,
        dataEmissao: t.data_emissao || null,
        dataVencimento: t.data_vencimento || null,
        valorDocumento: t.valor_documento ?? 0,
        statusTitulo: t.status_titulo || null,
      })),
    });
  } catch (err) {
    const message = err instanceof OmieError ? err.message : "Erro inesperado ao consultar a API Omie.";
    req.log.error({ err, base }, "Omie ListarContasPagar failed");
    res.status(502).json({ error: message });
  }
});

router.get("/admin/omie/:base/contas-correntes", requireFinanceiro, async (req, res): Promise<void> => {
  const base = String(req.params.base);
  if (!isOmieBase(base)) {
    res.status(400).json({ error: "Base inválida. Use 'education' ou 'store'." });
    return;
  }
  try {
    const contas = await listarContasCorrentesDiag(base);
    res.json({ contas });
  } catch (err) {
    const message = err instanceof OmieError ? err.message : "Erro inesperado ao consultar a API Omie.";
    req.log.error({ err, base }, "Omie ListarContasCorrentes failed");
    res.status(502).json({ error: message });
  }
});

export function parseFinancialFilters(
  query: import("express").Request["query"],
): { filters: FinancialSnapshotFilters } | { error: string } {
  const dataDeRaw = typeof query.dataDe === "string" && query.dataDe !== "" ? query.dataDe : undefined;
  const dataAteRaw = typeof query.dataAte === "string" && query.dataAte !== "" ? query.dataAte : undefined;
  const dataDe = parseIsoDateToOmie(dataDeRaw);
  const dataAte = parseIsoDateToOmie(dataAteRaw);
  if (dataDe === null || dataAte === null) {
    return { error: "Data inválida. Use o formato YYYY-MM-DD." };
  }
  if (dataDeRaw && dataAteRaw && dataDeRaw > dataAteRaw) {
    return { error: "Período inválido: a data inicial deve ser anterior ou igual à data final." };
  }
  // nCodCC accepts base-scoped account keys (e.g. "education:123,store:456").
  let accountKeys: string[] | undefined;
  if (query.nCodCC !== undefined) {
    const parts = String(query.nCodCC).split(",").map(s => s.trim());
    if (parts.some(part => !/^(education|store):[1-9]\d*$/.test(part))) {
      return { error: "nCodCC inválido." };
    }
    accountKeys = parts;
  }

  const baseRaw = query.base ? String(query.base) : undefined;
  if (baseRaw && !isOmieBase(baseRaw)) {
    return { error: "base inválida. Use education ou store." };
  }
  const excludeNonConsideredRaw = query.excludeNonConsidered;
  if (
    excludeNonConsideredRaw !== undefined
    && excludeNonConsideredRaw !== "true"
    && excludeNonConsideredRaw !== "false"
  ) {
    return { error: "excludeNonConsidered inválido. Use true ou false." };
  }
  return {
    filters: {
      ...(dataDeRaw ? { dataDe: dataDeRaw } : {}),
      ...(dataAteRaw ? { dataAte: dataAteRaw } : {}),
      ...(accountKeys ? { accountKeys } : {}),
      ...(baseRaw ? { base: baseRaw as OmieBase } : {}),
      ...(excludeNonConsideredRaw === "false" ? { excludeNonConsidered: false } : {}),
    },
  };
}

router.get("/admin/omie/resumo-financeiro", requireFinanceiro, async (req, res): Promise<void> => {
  const parsed = parseFinancialFilters(req.query);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  res.json(await getFinancialSnapshot(parsed.filters));
});

router.get("/admin/omie/resumo-financeiro/contas", requireFinanceiro, async (req, res): Promise<void> => {
  const baseRaw = req.query.base ? String(req.query.base) : undefined;
  if (baseRaw && !isOmieBase(baseRaw)) {
    res.status(400).json({ error: "base inválida. Use education ou store." });
    return;
  }
  res.json({ contas: await listPersistedFinancialAccounts(baseRaw as OmieBase | undefined) });
});

router.post("/admin/omie/resumo-financeiro", requireFinanceiro, async (req, res): Promise<void> => {
  const parsed = parseFinancialFilters(req.query);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  res.json(await refreshFinancialSnapshot(parsed.filters));
});

export default router;
