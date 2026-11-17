import { saoPauloDate } from "./saoPauloTime";

const OMIE_API_BASE = "https://app.omie.com.br/api/v1";
const omieQueues = new Map<OmieBase, Promise<void>>();

export type OmieBase = "education" | "store";

export const OMIE_BASE_NAMES: Record<OmieBase, string> = {
  education: "Soundfulness Education",
  store: "Soundfulness Store",
};

export class OmieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmieError";
  }
}

function getCredentials(base: OmieBase): { appKey: string; appSecret: string } {
  const appKey = base === "education" ? process.env.OMIE_EDUCATION_APP_KEY : process.env.OMIE_STORE_APP_KEY;
  const appSecret = base === "education" ? process.env.OMIE_EDUCATION_APP_SECRET : process.env.OMIE_STORE_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new OmieError(`Credenciais Omie da base "${OMIE_BASE_NAMES[base]}" não configuradas (variáveis de ambiente ausentes).`);
  }
  return { appKey, appSecret };
}

export async function omieCall<T = Record<string, unknown>>(
  base: OmieBase,
  endpoint: string,
  call: string,
  param: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const previous = omieQueues.get(base) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  omieQueues.set(base, current);
  await previous.catch(() => undefined);
  try {
  const { appKey, appSecret } = getCredentials(base);
  const url = `${OMIE_API_BASE}/${endpoint}/`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call, app_key: appKey, app_secret: appSecret, param: [param] }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new OmieError(`Falha de rede ao chamar a API Omie (${call}): ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new OmieError(`Resposta inválida da API Omie (${call}, HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  const obj = data as Record<string, unknown>;
  if (!res.ok || obj.faultstring || obj.faultcode) {
    const fault = typeof obj.faultstring === "string" ? obj.faultstring : `HTTP ${res.status}`;
    throw new OmieError(`Erro da API Omie (${call}): ${fault}`);
  }

    return obj as T;
  } finally {
    release();
    if (omieQueues.get(base) === current) omieQueues.delete(base);
  }
}

export interface OmieClienteRaw {
  codigo_cliente_omie: number;
  razao_social?: string;
  nome_fantasia?: string;
  email?: string;
  cnpj_cpf?: string;
  cidade?: string;
}

export interface OmieListaClientes {
  pagina: number;
  total_de_paginas: number;
  registros: number;
  total_de_registros: number;
  clientes_cadastro?: OmieClienteRaw[];
}

export interface OmieContaReceberRaw {
  codigo_lancamento_omie: number;
  codigo_cliente_fornecedor?: number;
  numero_documento_fiscal?: string;
  numero_parcela?: string;
  data_vencimento?: string;
  data_emissao?: string;
  valor_documento?: number;
  status_titulo?: string;
  nCodCC?: number;
  id_conta_corrente?: number;
}

export interface OmieListaContasReceber {
  pagina: number;
  total_de_paginas: number;
  registros: number;
  total_de_registros: number;
  conta_receber_cadastro?: OmieContaReceberRaw[];
}

export interface OmieContasFiltros {
  status?: string;
  dataDe?: string;
  dataAte?: string;
  nCodCC?: number;
  /** Multi-account filter applied client-side in agregarTitulos/resumirTitulos; overrides nCodCC when present. */
  nCodCCs?: number[];
}

export async function listarContasReceber(
  base: OmieBase,
  pagina: number,
  registrosPorPagina: number,
  filtros?: OmieContasFiltros,
  signal?: AbortSignal,
): Promise<OmieListaContasReceber> {
  return omieCall<OmieListaContasReceber>(base, "financas/contareceber", "ListarContasReceber", {
    pagina,
    registros_por_pagina: registrosPorPagina,
    apenas_importado_api: "N",
    ...(filtros?.status ? { filtrar_por_status: filtros.status } : {}),
    ...(filtros?.dataDe ? { filtrar_por_data_de: filtros.dataDe } : {}),
    ...(filtros?.dataAte ? { filtrar_por_data_ate: filtros.dataAte } : {}),
  }, signal);
}

export interface OmieContaPagarRaw {
  codigo_lancamento_omie: number;
  codigo_cliente_fornecedor?: number;
  numero_documento_fiscal?: string;
  numero_parcela?: string;
  data_vencimento?: string;
  data_emissao?: string;
  valor_documento?: number;
  status_titulo?: string;
  nCodCC?: number;
  id_conta_corrente?: number;
}

export interface OmieListaContasPagar {
  pagina: number;
  total_de_paginas: number;
  registros: number;
  total_de_registros: number;
  conta_pagar_cadastro?: OmieContaPagarRaw[];
}

export async function listarContasPagar(
  base: OmieBase,
  pagina: number,
  registrosPorPagina: number,
  filtros?: OmieContasFiltros,
  signal?: AbortSignal,
): Promise<OmieListaContasPagar> {
  return omieCall<OmieListaContasPagar>(base, "financas/contapagar", "ListarContasPagar", {
    pagina,
    registros_por_pagina: registrosPorPagina,
    apenas_importado_api: "N",
    ...(filtros?.status ? { filtrar_por_status: filtros.status } : {}),
    ...(filtros?.dataDe ? { filtrar_por_data_de: filtros.dataDe } : {}),
    ...(filtros?.dataAte ? { filtrar_por_data_ate: filtros.dataAte } : {}),
  }, signal);
}

// ─── Contas Correntes ──────────────────────────────────────────────────────

// Campos confirmados na resposta real da API Omie (não confiar em docs de terceiros —
// ver .agents/memory/omie-api-shapes.md). "Não Considerada" no Financeiro corresponde
// a nao_resumo/nao_fluxo (sempre iguais nas amostras verificadas), não a "cNaoConsiderar"
// (que não existe na resposta real).
interface OmieContaCorrenteRaw {
  nCodCC?: number;
  descricao?: string;
  nao_resumo?: string;
  nao_fluxo?: string;
  tipo?: string;
  codigo_banco?: string;
  inativo?: string;
  codigo_agencia?: string;
  numero_conta_corrente?: string;
  saldo_inicial?: number;
  cobr_sn?: string;
}

interface OmieListaContasCorrentes {
  pagina?: number;
  total_de_paginas?: number;
  total_de_registros?: number;
  ListarContasCorrentes?: OmieContaCorrenteRaw[];
}

export interface OmieContaCorrenteDiag {
  codigo: number;
  descricao: string;
  excluida: boolean;
  tipo?: string;
  banco?: string;
  ativa: boolean;
  agencia?: string;
  numeroConta?: string;
  saldo: number;
  emiteBoleto: boolean;
}

function mapContaCorrenteDiag(cc: OmieContaCorrenteRaw): OmieContaCorrenteDiag | null {
  if (!cc.nCodCC) return null;
  return {
    codigo: cc.nCodCC,
    descricao: cc.descricao ?? `Conta ${cc.nCodCC}`,
    excluida: cc.nao_resumo === "S" || cc.nao_fluxo === "S",
    tipo: cc.tipo || undefined,
    banco: cc.codigo_banco || undefined,
    ativa: cc.inativo !== "S",
    agencia: cc.codigo_agencia || undefined,
    numeroConta: cc.numero_conta_corrente || undefined,
    saldo: cc.saldo_inicial ?? 0,
    emiteBoleto: cc.cobr_sn === "S",
  };
}

export async function listarContasCorrentesDiag(
  base: OmieBase,
  options?: { signal?: AbortSignal; validateComplete?: boolean },
): Promise<OmieContaCorrenteDiag[]> {
  const contas: OmieContaCorrenteDiag[] = [];
  let pagina = 1;
  let expectedPages: number | null = null;
  let expectedRecords: number | null = null;
  for (;;) {
    const data = await omieCall<OmieListaContasCorrentes>(
      base,
      "geral/contacorrente",
      "ListarContasCorrentes",
      { pagina, registros_por_pagina: 50 },
      options?.signal,
    );
    const items = data.ListarContasCorrentes ?? [];
    if (options?.validateComplete) {
      const totalPages = data.total_de_paginas ?? 0;
      const totalRecords = data.total_de_registros ?? 0;
      if (data.pagina !== undefined && data.pagina !== pagina) {
        throw new OmieError(`Página inesperada ao listar contas correntes de "${OMIE_BASE_NAMES[base]}".`);
      }
      expectedPages ??= totalPages;
      expectedRecords ??= totalRecords;
      if (totalPages !== expectedPages || totalRecords !== expectedRecords) {
        throw new OmieError(`Totais mudaram durante a listagem de contas correntes de "${OMIE_BASE_NAMES[base]}".`);
      }
      if (items.length === 0 && pagina < totalPages) {
        throw new OmieError(`Página vazia antes do fim da listagem de contas correntes de "${OMIE_BASE_NAMES[base]}".`);
      }
    }
    for (const cc of items) {
      const mapped = mapContaCorrenteDiag(cc);
      if (mapped) contas.push(mapped);
    }
    const totalPaginas = data.total_de_paginas ?? 0;
    if (pagina >= totalPaginas || items.length === 0) break;
    pagina += 1;
  }
  if (options?.validateComplete && expectedRecords !== null && contas.length !== expectedRecords) {
    throw new OmieError(
      `Listagem incompleta de contas correntes de "${OMIE_BASE_NAMES[base]}": esperados ${expectedRecords}, recebidos ${contas.length}.`,
    );
  }
  return contas;
}

interface OmieExtratoSaldoRaw {
  nCodCC?: number;
  dPeriodoInicial?: string;
  dPeriodoFinal?: string;
  nSaldoAnterior?: number;
  nSaldoAtual?: number;
}

export interface OmieSaldosContaCorrente {
  saldoAnterior: number;
  saldoAtual: number;
}

export async function obterSaldosContaCorrente(
  base: OmieBase,
  accountCode: number,
  date: string,
  signal?: AbortSignal,
): Promise<OmieSaldosContaCorrente> {
  if (!Number.isSafeInteger(accountCode) || accountCode <= 0) {
    throw new OmieError(`Conta corrente inválida para consultar extrato de "${OMIE_BASE_NAMES[base]}".`);
  }
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    throw new OmieError(`Data inválida para consultar extrato de "${OMIE_BASE_NAMES[base]}".`);
  }
  const data = await omieCall<OmieExtratoSaldoRaw>(
    base,
    "financas/extrato",
    "ListarExtrato",
    {
      nCodCC: accountCode,
      cCodIntCC: "",
      dPeriodoInicial: date,
      dPeriodoFinal: date,
      cExibirApenasSaldo: "S",
    },
    signal,
  );
  if (
    data.nCodCC !== accountCode
    || data.dPeriodoInicial !== date
    || data.dPeriodoFinal !== date
    || typeof data.nSaldoAnterior !== "number"
    || !Number.isFinite(data.nSaldoAnterior)
    || typeof data.nSaldoAtual !== "number"
    || !Number.isFinite(data.nSaldoAtual)
  ) {
    throw new OmieError(
      `Extrato inválido para a conta ${accountCode} de "${OMIE_BASE_NAMES[base]}".`,
    );
  }
  return {
    saldoAnterior: data.nSaldoAnterior,
    saldoAtual: data.nSaldoAtual,
  };
}

export async function obterSaldoAtualContaCorrente(
  base: OmieBase,
  accountCode: number,
  date: string,
  signal?: AbortSignal,
): Promise<number> {
  return (await obterSaldosContaCorrente(base, accountCode, date, signal)).saldoAtual;
}

const CC_CACHE_TTL_MS = 60 * 60 * 1000;

interface ContasExcluidasEntry {
  excludedCodes: Set<number>;
  expiresAt: number;
}

const contasExcluidasCache = new Map<OmieBase, ContasExcluidasEntry>();

async function getContasExcluidas(
  base: OmieBase,
  signal?: AbortSignal,
  strict = false,
): Promise<Set<number>> {
  const now = Date.now();
  const cached = contasExcluidasCache.get(base);
  if (cached && cached.expiresAt > now) return cached.excludedCodes;

  const excludedCodes = new Set<number>();
  try {
    let pagina = 1;
    for (;;) {
      const data = await omieCall<OmieListaContasCorrentes>(
        base,
        "geral/contacorrente",
        "ListarContasCorrentes",
        { pagina, registros_por_pagina: 50 },
        signal,
      );
      const contas = data.ListarContasCorrentes ?? [];
      for (const cc of contas) {
        if ((cc.nao_resumo === "S" || cc.nao_fluxo === "S") && cc.nCodCC) {
          excludedCodes.add(cc.nCodCC);
        }
      }
      const totalPaginas = data.total_de_paginas ?? 0;
      if (pagina >= totalPaginas || contas.length === 0) break;
      pagina += 1;
    }
  } catch (error) {
    if (strict) throw error;
    // Omie unavailable — return empty set so we don't exclude anything
  }

  contasExcluidasCache.set(base, { excludedCodes, expiresAt: now + CC_CACHE_TTL_MS });
  return excludedCodes;
}

// ─── Agregação de Títulos ──────────────────────────────────────────────────

export interface OmieAgregadoTitulos {
  total: number;
  quantidade: number;
  porMes: Map<string, number>;
  /** Títulos com status que o sistema não conhece: ficam fora do total e devem ser avisados. */
  statusDesconhecido: OmieTituloStatusDesconhecido[];
}

const RESUMO_RPP = 500;
const RESUMO_MAX_PAGINAS = 40;

export type OmieTituloRaw = OmieContaReceberRaw | OmieContaPagarRaw;

export interface OmieMovimentoFinanceiroRaw {
  detalhes?: {
    cNatureza?: "P" | "R";
    cOrigem?: string;
    dDtPagamento?: string;
    nCodCC?: number;
    nCodMovCC?: number;
    nCodBaixa?: number;
    nValorMovCC?: number;
  };
  resumo?: {
    nValPago?: number;
    nValLiquido?: number;
  };
}

interface OmieListaMovimentosFinanceiros {
  nPagina?: number;
  nTotPaginas?: number;
  nRegistros?: number;
  nTotRegistros?: number;
  movimentos?: OmieMovimentoFinanceiroRaw[];
}

export async function listarTodosMovimentosFinanceiros(
  base: OmieBase,
  filters: { dataDe: string; dataAte: string },
  options?: { signal?: AbortSignal },
): Promise<OmieMovimentoFinanceiroRaw[]> {
  const merged = new Map<number, {
    movement: OmieMovimentoFinanceiroRaw;
    settlements: Set<number>;
    firstSettlement: number | null;
  }>();
  let rowCount = 0;
  let expectedPages: number | null = null;
  let expectedRecords: number | null = null;

  for (let page = 1; ; page += 1) {
    if (page > RESUMO_MAX_PAGINAS) {
      throw new OmieError(
        `Período com movimentos demais na base "${OMIE_BASE_NAMES[base]}". Reduza o período.`,
      );
    }
    const data = await omieCall<OmieListaMovimentosFinanceiros>(
      base,
      "financas/mf",
      "ListarMovimentos",
      {
        nPagina: page,
        nRegPorPagina: RESUMO_RPP,
        cTpLancamento: "CC",
        dDtPagtoDe: filters.dataDe,
        dDtPagtoAte: filters.dataAte,
        lDadosCad: false,
      },
      options?.signal,
    );
    const movements = data.movimentos ?? [];
    const totalPages = data.nTotPaginas;
    const totalRecords = data.nTotRegistros;

    if (
      data.nPagina !== page
      || !Number.isInteger(totalPages)
      || totalPages === undefined
      || totalPages < 0
      || !Number.isInteger(totalRecords)
      || totalRecords === undefined
      || totalRecords < 0
      || data.nRegistros !== movements.length
      || (totalPages === 0 && (totalRecords !== 0 || movements.length !== 0))
    ) {
      throw new OmieError(`Página inesperada ao listar movimentos de "${OMIE_BASE_NAMES[base]}".`);
    }
    expectedPages ??= totalPages;
    expectedRecords ??= totalRecords;
    if (totalPages !== expectedPages || totalRecords !== expectedRecords) {
      throw new OmieError(`Totais mudaram durante a listagem de movimentos de "${OMIE_BASE_NAMES[base]}".`);
    }
    for (const movement of movements) {
      const id = movement.detalhes?.nCodMovCC;
      if (!Number.isInteger(id) || !id || id <= 0) {
        throw new OmieError(`Movimento sem identificador válido na base "${OMIE_BASE_NAMES[base]}".`);
      }
      rowCount += 1;
      const known = merged.get(id);
      if (!known) {
        const firstSettlement = validSettlementId(movement);
        merged.set(id, {
          movement,
          settlements: new Set(firstSettlement === null ? [] : [firstSettlement]),
          firstSettlement,
        });
        continue;
      }
      // O Omie lista um pagamento que quita vários títulos em uma linha por título,
      // todas com o mesmo nCodMovCC e o valor total do movimento. Só aceitamos a
      // repetição quando cada linha tem uma baixa própria e descreve o mesmo movimento.
      const settlement = validSettlementId(movement);
      if (
        known.firstSettlement === null
        || settlement === null
        || known.settlements.has(settlement)
      ) {
        throw new OmieError(
          `Movimento duplicado durante a listagem de "${OMIE_BASE_NAMES[base]}" (movimento ${id}).`,
        );
      }
      const divergent = divergentMovementField(known.movement, movement);
      if (divergent) {
        throw new OmieError(
          `Movimento ${id} de "${OMIE_BASE_NAMES[base]}" aparece em mais de uma linha com ${divergent} diferente.`,
        );
      }
      known.settlements.add(settlement);
    }
    if (totalPages === 0 || page >= totalPages) break;
    if (movements.length === 0) {
      throw new OmieError(`Página vazia antes do fim dos movimentos de "${OMIE_BASE_NAMES[base]}".`);
    }
  }

  // O total informado pelo Omie conta linhas, não movimentos únicos.
  if (expectedRecords !== null && rowCount !== expectedRecords) {
    throw new OmieError(
      `Listagem incompleta de movimentos de "${OMIE_BASE_NAMES[base]}": esperados ${expectedRecords}, recebidos ${rowCount}.`,
    );
  }
  return [...merged.values()].map(item => item.movement);
}

function validSettlementId(movement: OmieMovimentoFinanceiroRaw): number | null {
  const settlement = movement.detalhes?.nCodBaixa;
  return Number.isSafeInteger(settlement) && (settlement as number) > 0 ? (settlement as number) : null;
}

function divergentMovementField(
  first: OmieMovimentoFinanceiroRaw,
  other: OmieMovimentoFinanceiroRaw,
): string | null {
  const fields: Array<[string, keyof NonNullable<OmieMovimentoFinanceiroRaw["detalhes"]>]> = [
    ["conta", "nCodCC"],
    ["data de pagamento", "dDtPagamento"],
    ["natureza", "cNatureza"],
    ["origem", "cOrigem"],
    ["valor", "nValorMovCC"],
  ];
  for (const [label, key] of fields) {
    if (first.detalhes?.[key] !== other.detalhes?.[key]) return label;
  }
  return null;
}

// ─── Contas a pagar planejadas (pesquisa de lançamentos) ────────────────────

// A listagem ListarContasPagar chegou a responder "Dados do WebService não foram
// encontrados!" (Client-1013) com títulos existentes. A pesquisa de lançamentos
// (financas/pesquisartitulos, PesquisarLancamentos) continuou devolvendo-os, então
// é a fonte dos títulos a pagar da Visão Financeira. Formato confirmado ao vivo:
// ver .agents/memory/omie-api-shapes.md.
const PESQUISA_LANCAMENTOS_RPP = 100;

interface OmieLancamentoPagarRaw {
  cabecTitulo?: {
    nCodTitulo?: number;
    nCodCliente?: number;
    nCodCC?: number;
    cNumDocFiscal?: string;
    cNumParcela?: string;
    dDtEmissao?: string;
    dDtVenc?: string;
    nValorTitulo?: number;
    cStatus?: string;
  };
  resumo?: {
    nValAberto?: number;
  };
}

interface OmiePesquisaLancamentos {
  nPagina?: number;
  nTotPaginas?: number;
  nRegistros?: number;
  nTotRegistros?: number;
  titulosEncontrados?: OmieLancamentoPagarRaw[];
}

const STATUS_TITULO_ABERTO: Record<string, "A VENCER" | "ATRASADO"> = {
  "A VENCER": "A VENCER",
  // Título que vence no próprio dia: continua em aberto e conta como a vencer.
  "VENCE HOJE": "A VENCER",
  "ATRASADO": "ATRASADO",
};
/**
 * Título pago só em parte. O Omie não diz se o saldo está atrasado ou a vencer; quem planeja decide
 * pela data de vencimento, então o status segue como veio e o valor é o saldo em aberto.
 */
export const STATUS_PAGAMENTO_PARCIAL = "PAGTO PARCIAL";
const STATUS_PAGAR_ENCERRADO = new Set(["PAGO", "CANCELADO"]);

async function pesquisarLancamentosPagar(
  base: OmieBase,
  pagina: number,
  filtros: OmieContasFiltros,
  signal?: AbortSignal,
): Promise<OmiePesquisaLancamentos> {
  if (filtros.status !== undefined || filtros.nCodCC !== undefined || filtros.nCodCCs !== undefined) {
    throw new OmieError("A pesquisa de contas a pagar aceita apenas filtro por período de vencimento.");
  }
  return omieCall<OmiePesquisaLancamentos>(base, "financas/pesquisartitulos", "PesquisarLancamentos", {
    nPagina: pagina,
    nRegPorPagina: PESQUISA_LANCAMENTOS_RPP,
    cNatureza: "P",
    ...(filtros.dataDe ? { dDtVencDe: filtros.dataDe } : {}),
    ...(filtros.dataAte ? { dDtVencAte: filtros.dataAte } : {}),
  }, signal);
}

function numeroValido(valor: unknown): valor is number {
  return typeof valor === "number" && Number.isFinite(valor);
}

function mapLancamentoPagar(base: OmieBase, lancamento: OmieLancamentoPagarRaw): OmieContaPagarRaw {
  const head = lancamento.cabecTitulo;
  const id = head?.nCodTitulo;
  if (!head || !Number.isSafeInteger(id) || (id as number) <= 0) {
    throw new OmieError(`Título sem identificador válido na base "${OMIE_BASE_NAMES[base]}".`);
  }
  const status = head.cStatus ?? "";
  const open = STATUS_TITULO_ABERTO[status];
  const emAberto = open !== undefined || status === STATUS_PAGAMENTO_PARCIAL;
  const encerrado = STATUS_PAGAR_ENCERRADO.has(status);
  const aberto = lancamento.resumo?.nValAberto;
  let amount: number;
  if (emAberto) {
    // O planejado é o que ainda falta pagar, nunca o valor do documento.
    if (!numeroValido(aberto)) {
      throw new OmieError(`Título ${id} da base "${OMIE_BASE_NAMES[base]}" sem valor válido nas contas a pagar.`);
    }
    amount = aberto;
  } else if (encerrado) {
    // Para títulos encerrados o valor não entra no planejado.
    if (!numeroValido(head.nValorTitulo)) {
      throw new OmieError(`Título ${id} da base "${OMIE_BASE_NAMES[base]}" sem valor válido nas contas a pagar.`);
    }
    amount = head.nValorTitulo;
  } else {
    // Status que o sistema não conhece não cancela a coleta: o título segue com o status original
    // e quem planeja o deixa de fora com aviso. O valor aqui só serve para informar o tamanho do que ficou de fora.
    amount = numeroValido(aberto) ? aberto : numeroValido(head.nValorTitulo) ? head.nValorTitulo : 0;
  }
  return {
    codigo_lancamento_omie: id as number,
    codigo_cliente_fornecedor: head.nCodCliente,
    numero_documento_fiscal: head.cNumDocFiscal,
    numero_parcela: head.cNumParcela,
    data_emissao: head.dDtEmissao,
    data_vencimento: head.dDtVenc,
    valor_documento: amount,
    status_titulo: open ?? status,
    nCodCC: head.nCodCC,
  };
}

interface PaginaTitulos {
  pagina: number | undefined;
  totalPaginas: number;
  totalRegistros: number;
  titles: OmieTituloRaw[];
}

async function lerPaginaTitulos(
  base: OmieBase,
  tipo: "receber" | "pagar",
  pagina: number,
  filtros: OmieContasFiltros,
  signal?: AbortSignal,
): Promise<PaginaTitulos> {
  if (tipo === "receber") {
    const data = await listarContasReceber(base, pagina, RESUMO_RPP, filtros, signal);
    return {
      pagina: data.pagina,
      totalPaginas: data.total_de_paginas ?? 0,
      totalRegistros: data.total_de_registros ?? 0,
      titles: data.conta_receber_cadastro ?? [],
    };
  }
  const data = await pesquisarLancamentosPagar(base, pagina, filtros, signal);
  const { nPagina, nTotPaginas, nRegistros, nTotRegistros, titulosEncontrados } = data;
  const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
  if (
    !Array.isArray(titulosEncontrados)
    || !isCount(nPagina)
    || !isCount(nTotPaginas)
    || !isCount(nTotRegistros)
    || nRegistros !== titulosEncontrados.length
  ) {
    throw new OmieError(`Página inesperada ao listar contas a pagar de "${OMIE_BASE_NAMES[base]}".`);
  }
  if (nTotPaginas === 0) {
    // Sem títulos no filtro o Omie responde com nPagina 0 e todos os totais zerados.
    // Qualquer outra combinação com zero páginas é resposta contraditória, não lista vazia.
    if (nPagina !== 0 || nTotRegistros !== 0 || titulosEncontrados.length !== 0) {
      throw new OmieError(`Página inesperada ao listar contas a pagar de "${OMIE_BASE_NAMES[base]}".`);
    }
    return { pagina, totalPaginas: 0, totalRegistros: 0, titles: [] };
  }
  return {
    pagina: nPagina,
    totalPaginas: nTotPaginas,
    totalRegistros: nTotRegistros,
    titles: titulosEncontrados.map(item => mapLancamentoPagar(base, item)),
  };
}

/**
 * A listagem de contas a receber só traz o valor do documento. Para título pago em parte, o saldo
 * em aberto vem da pesquisa de lançamentos (resumo.nValAberto), consultada pelo código do título.
 * A listagem não serve de fonte única: o filtro de datas dela não é o de vencimento, e a pesquisa
 * de lançamentos devolveria outro conjunto de títulos para o mesmo período.
 */
async function consultarSaldoEmAberto(
  base: OmieBase,
  codigoTitulo: number,
  signal?: AbortSignal,
): Promise<number> {
  const data = await omieCall<OmiePesquisaLancamentos>(base, "financas/pesquisartitulos", "PesquisarLancamentos", {
    nPagina: 1,
    nRegPorPagina: PESQUISA_LANCAMENTOS_RPP,
    nCodTitulo: codigoTitulo,
  }, signal);
  const encontrados = Array.isArray(data.titulosEncontrados) ? data.titulosEncontrados : [];
  const doTitulo = encontrados.filter(item => item.cabecTitulo?.nCodTitulo === codigoTitulo);
  const saldo = doTitulo.length === 1 ? doTitulo[0]?.resumo?.nValAberto : undefined;
  if (!numeroValido(saldo) || saldo < 0) {
    throw new OmieError(
      `Saldo em aberto indisponível para o título ${codigoTitulo} (pagamento parcial) da base "${OMIE_BASE_NAMES[base]}".`,
    );
  }
  return saldo;
}

async function completarSaldoDosParciais(
  base: OmieBase,
  titulos: OmieTituloRaw[],
  signal?: AbortSignal,
): Promise<OmieTituloRaw[]> {
  const completos: OmieTituloRaw[] = [];
  for (const titulo of titulos) {
    if (titulo.status_titulo !== STATUS_PAGAMENTO_PARCIAL) {
      completos.push(titulo);
      continue;
    }
    const saldo = await consultarSaldoEmAberto(base, titulo.codigo_lancamento_omie, signal);
    completos.push({ ...titulo, valor_documento: saldo });
  }
  return completos;
}

export async function listarTodosTitulos(
  base: OmieBase,
  tipo: "receber" | "pagar",
  filtros: OmieContasFiltros,
  options?: { signal?: AbortSignal },
): Promise<OmieTituloRaw[]> {
  const result: OmieTituloRaw[] = [];
  const ids = new Set<number>();
  let expectedPages: number | null = null;
  let expectedRecords: number | null = null;

  for (let pagina = 1; ; pagina += 1) {
    if (pagina > RESUMO_MAX_PAGINAS) {
      throw new OmieError(
        `Período com títulos demais na base "${OMIE_BASE_NAMES[base]}" (mais de ${RESUMO_MAX_PAGINAS * RESUMO_RPP} títulos).`,
      );
    }
    const data = await lerPaginaTitulos(base, tipo, pagina, filtros, options?.signal);
    const { titles, totalPaginas: totalPages, totalRegistros: totalRecords } = data;

    if (data.pagina !== pagina) {
      throw new OmieError(`Página inesperada ao listar contas a ${tipo} de "${OMIE_BASE_NAMES[base]}".`);
    }
    expectedPages ??= totalPages;
    expectedRecords ??= totalRecords;
    if (totalPages !== expectedPages || totalRecords !== expectedRecords) {
      throw new OmieError(`Totais mudaram durante a listagem de contas a ${tipo} de "${OMIE_BASE_NAMES[base]}".`);
    }
    if (titles.length === 0 && pagina < totalPages) {
      throw new OmieError(`Página vazia antes do fim da listagem de contas a ${tipo} de "${OMIE_BASE_NAMES[base]}".`);
    }
    for (const title of titles) {
      if (!Number.isInteger(title.codigo_lancamento_omie) || title.codigo_lancamento_omie <= 0) {
        throw new OmieError(`Título sem identificador válido na base "${OMIE_BASE_NAMES[base]}".`);
      }
      if (ids.has(title.codigo_lancamento_omie)) {
        throw new OmieError(`Título duplicado durante a listagem de contas a ${tipo} de "${OMIE_BASE_NAMES[base]}".`);
      }
      ids.add(title.codigo_lancamento_omie);
      result.push(title);
    }
    if (pagina >= totalPages) break;
  }

  if (expectedRecords !== null && result.length !== expectedRecords) {
    throw new OmieError(
      `Listagem incompleta de contas a ${tipo} de "${OMIE_BASE_NAMES[base]}": esperados ${expectedRecords}, recebidos ${result.length}.`,
    );
  }
  return tipo === "receber" ? completarSaldoDosParciais(base, result, options?.signal) : result;
}

function mesDaDataOmie(data?: string): string | null {
  if (!data) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(data);
  if (!m) return null;
  return `${m[3]}-${m[2]}`;
}

function contaCorrenteDoTitulo(
  title: OmieContaReceberRaw | OmieContaPagarRaw,
): number | undefined {
  return title.id_conta_corrente ?? title.nCodCC;
}

// ─── Avaliação de títulos para os totais (Omie ERP e Visão Geral) ───────────

export interface OmieTituloStatusDesconhecido {
  base: OmieBase;
  tipo: "receber" | "pagar";
  codigo: number;
  status: string;
  valor: number;
}

type TituloAvaliado =
  | { situacao: "cancelado" }
  | { situacao: "quitado"; valor: number }
  // `pago` só existe em título com pagamento parcial: a parte do documento que já foi paga.
  | { situacao: "aberto"; valor: number; atrasado: boolean; pago?: number }
  | { situacao: "desconhecido"; status: string; valor: number };

const STATUS_TITULO_QUITADO = new Set(["RECEBIDO", "PAGO"]);

function vencimentoIso(data: string | undefined): string | null {
  const m = data ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(data) : null;
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function hojeIso(): string {
  const { year, month, day } = saoPauloDate(new Date());
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// A listagem de contas a receber/pagar só traz o valor do documento. Os totais da Visão Geral e do
// Omie ERP consultam o saldo de cada título parcial várias vezes na mesma atualização (janelas que se
// sobrepõem), e o Omie bloqueia chamadas idênticas repetidas; por isso o saldo fica em memória por pouco tempo.
const SALDO_PARCIAL_TTL_MS = 60 * 1000;
const saldoParcialCache = new Map<string, { saldo: number; expiresAt: number }>();

async function saldoEmAbertoRecente(
  base: OmieBase,
  codigoTitulo: number,
  signal?: AbortSignal,
): Promise<number> {
  const key = `${base}:${codigoTitulo}`;
  const now = Date.now();
  const cached = saldoParcialCache.get(key);
  if (cached && cached.expiresAt > now) return cached.saldo;
  const saldo = await consultarSaldoEmAberto(base, codigoTitulo, signal);
  saldoParcialCache.set(key, { saldo, expiresAt: now + SALDO_PARCIAL_TTL_MS });
  return saldo;
}

/** Parte do documento já paga num título parcial, em centavos exatos; nunca negativa. */
function parteJaPaga(valorDocumento: number, saldoEmAberto: number): number {
  return Math.max(0, Math.round((valorDocumento - saldoEmAberto) * 100) / 100);
}

/**
 * Decide como um título da listagem entra nos totais. Pagamento parcial se divide em duas partes:
 * o saldo em aberto (atrasado ou a vencer pelo vencimento, já que o Omie não diz) e a parte já paga
 * (valor do documento menos o saldo), que conta como recebido/pago. As duas somam o valor do documento,
 * então o título não é contado duas vezes. "VENCE HOJE" é a vencer.
 * Status que o sistema não conhece não entram no total: voltam como "desconhecido" para serem avisados.
 */
async function avaliarTitulo(
  base: OmieBase,
  titulo: OmieTituloRaw,
  hoje: string,
  signal?: AbortSignal,
): Promise<TituloAvaliado> {
  const status = titulo.status_titulo ?? "";
  const valorDocumento = numeroValido(titulo.valor_documento) ? titulo.valor_documento : 0;
  if (status === "CANCELADO") return { situacao: "cancelado" };
  if (STATUS_TITULO_QUITADO.has(status)) return { situacao: "quitado", valor: valorDocumento };
  const aberto = STATUS_TITULO_ABERTO[status];
  if (aberto) return { situacao: "aberto", valor: valorDocumento, atrasado: aberto === "ATRASADO" };
  if (status === STATUS_PAGAMENTO_PARCIAL) {
    const vencimento = vencimentoIso(titulo.data_vencimento);
    if (!vencimento) {
      throw new OmieError(
        `Título ${titulo.codigo_lancamento_omie} da base "${OMIE_BASE_NAMES[base]}" com pagamento parcial e sem vencimento válido.`,
      );
    }
    if (!numeroValido(titulo.valor_documento)) {
      // Sem o valor do documento não há como saber quanto já foi pago; contar só o saldo subestimaria o total.
      throw new OmieError(
        `Título ${titulo.codigo_lancamento_omie} da base "${OMIE_BASE_NAMES[base]}" com pagamento parcial e sem valor de documento válido.`,
      );
    }
    const saldo = await saldoEmAbertoRecente(base, titulo.codigo_lancamento_omie, signal);
    return {
      situacao: "aberto",
      valor: saldo,
      atrasado: vencimento < hoje,
      pago: parteJaPaga(titulo.valor_documento, saldo),
    };
  }
  return { situacao: "desconhecido", status: status || "(sem status)", valor: valorDocumento };
}

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/** Texto do aviso quando há títulos de status desconhecido fora dos totais; null quando nenhum ficou. */
export function descreverTitulosComStatusDesconhecido(
  titulos: Iterable<OmieTituloStatusDesconhecido>,
): string | null {
  const grupos = new Map<string, { tipo: "receber" | "pagar"; status: string; quantidade: number; valor: number }>();
  for (const titulo of titulos) {
    const key = `${titulo.tipo}:${titulo.status}`;
    const grupo = grupos.get(key) ?? { tipo: titulo.tipo, status: titulo.status, quantidade: 0, valor: 0 };
    grupo.quantidade += 1;
    grupo.valor += titulo.valor;
    grupos.set(key, grupo);
  }
  if (grupos.size === 0) return null;
  const partes = [...grupos.values()].map(grupo => {
    const natureza = grupo.tipo === "pagar" ? "contas a pagar" : "contas a receber";
    const quantidade = grupo.quantidade === 1 ? "1 título" : `${grupo.quantidade} títulos`;
    return `${natureza} com status "${grupo.status}" (${quantidade}, ${brl.format(Math.round(grupo.valor * 100) / 100)})`;
  });
  return `O Omie enviou títulos com um status que o sistema não conhece. Eles ficaram fora dos totais, que estão incompletos: ${partes.join("; ")}.`;
}

interface AgregadoCacheEntry {
  data: OmieAgregadoTitulos;
  expiresAt: number;
}
const OMIE_CACHE_TTL_MS = 15 * 60 * 1000;
const agregadoCache = new Map<string, AgregadoCacheEntry>();

function agregadoCacheKey(base: OmieBase, tipo: string, filtros: OmieContasFiltros) {
  const ccKey = filtros.nCodCCs?.length
    ? filtros.nCodCCs.slice().sort((a, b) => a - b).join(",")
    : (filtros.nCodCC ?? "");
  return `${base}:${tipo}:${filtros.status ?? ""}:${filtros.dataDe ?? ""}:${filtros.dataAte ?? ""}:${ccKey}`;
}

export async function agregarTitulos(
  base: OmieBase,
  tipo: "receber" | "pagar",
  filtros: OmieContasFiltros,
  options?: { signal?: AbortSignal; strictExcludedAccounts?: boolean },
): Promise<OmieAgregadoTitulos> {
  const cacheKey = agregadoCacheKey(base, tipo, filtros);
  const now = Date.now();
  const cached = agregadoCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.data;

  const contasExcluidas = await getContasExcluidas(
    base,
    options?.signal,
    options?.strictExcludedAccounts,
  );

  const total: OmieAgregadoTitulos = {
    total: 0,
    quantidade: 0,
    porMes: new Map<string, number>(),
    statusDesconhecido: [],
  };
  const hoje = hojeIso();
  let pagina = 1;
  for (;;) {
    if (pagina > RESUMO_MAX_PAGINAS) {
      throw new OmieError(
        `Período com títulos demais na base "${OMIE_BASE_NAMES[base]}" (mais de ${RESUMO_MAX_PAGINAS * RESUMO_RPP} títulos). Reduza o período.`,
      );
    }
    const data =
      tipo === "receber"
        ? await listarContasReceber(base, pagina, RESUMO_RPP, filtros, options?.signal)
        : await listarContasPagar(base, pagina, RESUMO_RPP, filtros, options?.signal);
    const titulos: Array<OmieContaReceberRaw | OmieContaPagarRaw> =
      tipo === "receber"
        ? ((data as OmieListaContasReceber).conta_receber_cadastro ?? [])
        : ((data as OmieListaContasPagar).conta_pagar_cadastro ?? []);
    for (const t of titulos) {
      if (t.status_titulo === "CANCELADO") continue;
      const accountCode = contaCorrenteDoTitulo(t);
      if (filtros.nCodCCs && filtros.nCodCCs.length > 0) {
        const ccsSet = new Set(filtros.nCodCCs);
        if (!accountCode || !ccsSet.has(accountCode)) continue;
      } else if (filtros.nCodCC !== undefined) {
        if (accountCode !== filtros.nCodCC) continue;
      } else {
        if (accountCode && contasExcluidas.has(accountCode)) continue;
      }
      const avaliado = await avaliarTitulo(base, t, hoje, options?.signal);
      if (avaliado.situacao === "cancelado") continue;
      if (avaliado.situacao === "desconhecido") {
        total.statusDesconhecido.push({
          base,
          tipo,
          codigo: t.codigo_lancamento_omie,
          status: avaliado.status,
          valor: avaliado.valor,
        });
        continue;
      }
      // Pagamento parcial: o saldo e a parte já paga somam o valor do documento.
      const valor = avaliado.situacao === "aberto" ? avaliado.valor + (avaliado.pago ?? 0) : avaliado.valor;
      total.total += valor;
      total.quantidade += 1;
      const mes = mesDaDataOmie(t.data_vencimento) ?? mesDaDataOmie(t.data_emissao);
      if (mes) total.porMes.set(mes, (total.porMes.get(mes) ?? 0) + valor);
    }
    const totalPaginas = data.total_de_paginas ?? 0;
    if (pagina >= totalPaginas || titulos.length === 0) break;
    pagina += 1;
  }

  agregadoCache.set(cacheKey, { data: total, expiresAt: now + OMIE_CACHE_TTL_MS });
  return total;
}

export interface OmieResumoTitulos {
  totalRecebido: number;
  totalAVencer: number;
  totalAtrasado: number;
  quantidade: number;
  /** Avisos para a tela; hoje, só títulos de status desconhecido deixados fora dos totais. */
  avisos: string[];
}

interface ResumoCacheEntry {
  data: OmieResumoTitulos;
  expiresAt: number;
}
const resumoCache = new Map<string, ResumoCacheEntry>();

export async function resumirTitulos(
  base: OmieBase,
  tipo: "receber" | "pagar",
  filtros: OmieContasFiltros,
): Promise<OmieResumoTitulos> {
  const cacheKey = agregadoCacheKey(base, tipo, filtros);
  const now = Date.now();
  const cached = resumoCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.data;

  const contasExcluidas = await getContasExcluidas(base);

  const resumo: OmieResumoTitulos = { totalRecebido: 0, totalAVencer: 0, totalAtrasado: 0, quantidade: 0, avisos: [] };
  const desconhecidos: OmieTituloStatusDesconhecido[] = [];
  const hoje = hojeIso();
  let pagina = 1;
  for (;;) {
    if (pagina > RESUMO_MAX_PAGINAS) {
      throw new OmieError(
        `Filtro com títulos demais na base "${OMIE_BASE_NAMES[base]}" (mais de ${RESUMO_MAX_PAGINAS * RESUMO_RPP} títulos). Reduza o período.`,
      );
    }
    const data =
      tipo === "receber"
        ? await listarContasReceber(base, pagina, RESUMO_RPP, filtros)
        : await listarContasPagar(base, pagina, RESUMO_RPP, filtros);
    const titulos: Array<OmieContaReceberRaw | OmieContaPagarRaw> =
      tipo === "receber"
        ? ((data as OmieListaContasReceber).conta_receber_cadastro ?? [])
        : ((data as OmieListaContasPagar).conta_pagar_cadastro ?? []);
    for (const t of titulos) {
      if (t.status_titulo === "CANCELADO") continue;
      const accountCode = contaCorrenteDoTitulo(t);
      if (filtros.nCodCCs && filtros.nCodCCs.length > 0) {
        const ccsSet = new Set(filtros.nCodCCs);
        if (!accountCode || !ccsSet.has(accountCode)) continue;
      } else if (filtros.nCodCC !== undefined) {
        if (accountCode !== filtros.nCodCC) continue;
      } else {
        if (accountCode && contasExcluidas.has(accountCode)) continue;
      }
      const avaliado = await avaliarTitulo(base, t, hoje);
      if (avaliado.situacao === "cancelado") continue;
      if (avaliado.situacao === "desconhecido") {
        desconhecidos.push({
          base,
          tipo,
          codigo: t.codigo_lancamento_omie,
          status: avaliado.status,
          valor: avaliado.valor,
        });
        continue;
      }
      if (avaliado.situacao === "quitado") {
        resumo.totalRecebido += avaliado.valor;
      } else {
        if (avaliado.atrasado) resumo.totalAtrasado += avaliado.valor;
        else resumo.totalAVencer += avaliado.valor;
        // A parte já paga de um título parcial é recebido/pago; o saldo segue em a vencer/atrasado.
        resumo.totalRecebido += avaliado.pago ?? 0;
      }
      resumo.quantidade += 1;
    }
    const totalPaginas = data.total_de_paginas ?? 0;
    if (pagina >= totalPaginas || titulos.length === 0) break;
    pagina += 1;
  }

  const aviso = descreverTitulosComStatusDesconhecido(desconhecidos);
  if (aviso) resumo.avisos.push(aviso);
  resumoCache.set(cacheKey, { data: resumo, expiresAt: now + OMIE_CACHE_TTL_MS });
  return resumo;
}

interface ClienteNomeCacheEntry {
  nome: string | null;
  expiresAt: number;
}

const CLIENTE_NOME_TTL_MS = 30 * 60 * 1000;
const CLIENTE_NOME_CACHE_MAX = 5000;
const clienteNomeCache = new Map<string, ClienteNomeCacheEntry>();

async function consultarClienteNome(base: OmieBase, codigo: number): Promise<string | null> {
  const data = await omieCall<OmieClienteRaw>(base, "geral/clientes", "ConsultarCliente", {
    codigo_cliente_omie: codigo,
  });
  return data.razao_social || data.nome_fantasia || null;
}

export async function resolverNomesClientes(
  base: OmieBase,
  codigos: number[],
  onError?: (codigo: number, err: unknown) => void,
): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>();
  const now = Date.now();
  const pendentes: number[] = [];

  for (const codigo of new Set(codigos)) {
    const cached = clienteNomeCache.get(`${base}:${codigo}`);
    if (cached && cached.expiresAt > now) {
      result.set(codigo, cached.nome);
    } else {
      pendentes.push(codigo);
    }
  }

  const CONCURRENCY = 4;
  for (let i = 0; i < pendentes.length; i += CONCURRENCY) {
    const lote = pendentes.slice(i, i + CONCURRENCY);
    await Promise.all(
      lote.map(async (codigo) => {
        try {
          const nome = await consultarClienteNome(base, codigo);
          if (clienteNomeCache.size >= CLIENTE_NOME_CACHE_MAX) {
            const oldest = clienteNomeCache.keys().next().value;
            if (oldest !== undefined) clienteNomeCache.delete(oldest);
          }
          clienteNomeCache.set(`${base}:${codigo}`, { nome, expiresAt: Date.now() + CLIENTE_NOME_TTL_MS });
          result.set(codigo, nome);
        } catch (err) {
          onError?.(codigo, err);
          result.set(codigo, null);
        }
      }),
    );
  }

  return result;
}

export async function listarClientes(
  base: OmieBase,
  pagina: number,
  registrosPorPagina: number,
): Promise<OmieListaClientes> {
  return omieCall<OmieListaClientes>(base, "geral/clientes", "ListarClientes", {
    pagina,
    registros_por_pagina: registrosPorPagina,
    apenas_importado_api: "N",
  });
}

// ─── Produtos e posição de estoque ─────────────────────────────────────────

export interface OmieProdutoEstoqueRaw {
  cCodInt?: string;
  cCodigo?: string;
  cDescricao?: string;
  codigo_local_estoque?: number;
  estoque_minimo?: number;
  fisico?: number;
  nCMC?: number;
  nCodProd?: number;
  nPendente?: number;
  nPrecoUnitario?: number;
  nSaldo?: number;
  reservado?: number;
}

export interface OmieListaPosEstoque {
  nPagina?: number;
  nTotPaginas?: number;
  nRegistros?: number;
  nTotRegistros?: number;
  dDataPosicao?: string;
  produtos?: OmieProdutoEstoqueRaw[];
}

/** A posição é somente leitura e é a fonte oficial do saldo do catálogo Store. */
export async function listarPosEstoque(
  base: OmieBase,
  pagina: number,
  registrosPorPagina: number,
  dataPosicao: string,
): Promise<OmieListaPosEstoque> {
  return omieCall<OmieListaPosEstoque>(base, "estoque/consulta", "ListarPosEstoque", {
    nPagina: pagina,
    nRegPorPagina: registrosPorPagina,
    dDataPosicao: dataPosicao,
    cExibeTodos: "S",
    codigo_local_estoque: 0,
  });
}

export function hasOmieStoreCredentials(): boolean {
  return Boolean(
    process.env.OMIE_STORE_APP_KEY?.trim() &&
    process.env.OMIE_STORE_APP_SECRET?.trim(),
  );
}

export async function listarTodaPosicaoEstoque(
  base: OmieBase,
  dataPosicao: string,
  registrosPorPagina = 50,
): Promise<OmieProdutoEstoqueRaw[]> {
  const produtos: OmieProdutoEstoqueRaw[] = [];
  let pagina = 1;
  const maxPaginas = 200;
  let totalPaginasEsperado: number | null = null;
  let totalRegistrosEsperado: number | null = null;

  for (;;) {
    if (pagina > maxPaginas) {
      throw new OmieError(`A posição de estoque da base "${OMIE_BASE_NAMES[base]}" excedeu o limite seguro de paginação.`);
    }
    const data = await listarPosEstoque(base, pagina, registrosPorPagina, dataPosicao);
    const items = data.produtos ?? [];
    const totalPaginas = data.nTotPaginas;
    const totalRegistros = data.nTotRegistros;
    if (
      data.nPagina !== pagina ||
      !Number.isInteger(totalPaginas) ||
      (totalPaginas ?? 0) < 1 ||
      !Number.isInteger(totalRegistros) ||
      (totalRegistros ?? -1) < 0 ||
      data.nRegistros !== items.length
    ) {
      throw new OmieError("A API Omie retornou metadados incompletos ou incoerentes na paginação do estoque.");
    }
    if (totalPaginasEsperado === null) {
      totalPaginasEsperado = totalPaginas!;
      totalRegistrosEsperado = totalRegistros!;
    } else if (totalPaginas !== totalPaginasEsperado || totalRegistros !== totalRegistrosEsperado) {
      throw new OmieError("A API Omie alterou a paginação durante a leitura do estoque.");
    }
    if (items.length === 0 && pagina < totalPaginas!) {
      throw new OmieError("A API Omie retornou uma página intermediária vazia na leitura do estoque.");
    }
    produtos.push(...items);
    if (pagina >= totalPaginas!) break;
    pagina += 1;
  }

  if (totalRegistrosEsperado !== produtos.length) {
    throw new OmieError("A API Omie retornou uma posição de estoque parcial.");
  }
  return produtos;
}
