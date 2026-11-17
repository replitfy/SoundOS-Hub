import { eq } from "drizzle-orm";
import { pessoasTable } from "@workspace/db";
import { registrarDeclaracaoNaConversa, registrarEvidencia, withPessoaLock } from "../evidencias.js";
import { nomeEhPlaceholder } from "../sofiaPessoa.js";
import { logger } from "../../lib/logger.js";

/**
 * `atualizar_ficha`: única tool de gravação do modo simples. O backend injeta
 * pessoaId e conversationId; nada que o modelo mande nesses nomes é usado.
 * Nunca sobrescreve valor existente e nunca revela o valor atual.
 */

type CampoDb =
  | "nome" | "sobrenome" | "dataNascimento" | "idadeDeclarada" | "cidade" | "estadoUf" | "profissao"
  | "email" | "instagram" | "servicoInteresse" | "objetivosDeclarados" | "comoFicouSabendo" | "preferredLanguage";

export const CAMPOS_FICHA: Readonly<Record<string, CampoDb>> = {
  nome: "nome",
  sobrenome: "sobrenome",
  data_nascimento: "dataNascimento",
  idade: "idadeDeclarada",
  cidade: "cidade",
  estado: "estadoUf",
  profissao: "profissao",
  email: "email",
  instagram: "instagram",
  servico_interesse: "servicoInteresse",
  objetivos_declarados: "objetivosDeclarados",
  como_ficou_sabendo: "comoFicouSabendo",
  preferred_language: "preferredLanguage",
};

const CAMPO_DA_TOOL = Object.fromEntries(Object.entries(CAMPOS_FICHA).map(([tool, campo]) => [campo, tool])) as Record<CampoDb, string>;

const UFS = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI",
  "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);
const IDIOMAS = new Set(["pt-BR", "fr", "en", "es"]);

export interface Rejeitado { campo: string; motivo: string }
export interface Conflito { campo: string; valor_atual_existe: true }
export interface AtualizarFichaResultado {
  aplicados: string[];
  conflitos: Conflito[];
  rejeitados: Rejeitado[];
  instrucao?: string;
}

function texto(valor: unknown, maximo = 200): string | null {
  if (typeof valor !== "string" && typeof valor !== "number") return null;
  const limpo = String(valor).replace(/\s+/g, " ").trim();
  return limpo && limpo.length <= maximo ? limpo : null;
}

function hojeEmSaoPaulo(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function validar(campo: CampoDb, valor: unknown, now: Date): unknown | null {
  switch (campo) {
    case "email": {
      const email = texto(valor)?.toLowerCase();
      return email && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email) ? email : null;
    }
    case "dataNascimento": {
      const data = texto(valor);
      if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return null;
      const parsed = new Date(`${data}T12:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== data) return null;
      const hoje = hojeEmSaoPaulo(now);
      const anoMinimo = Number(hoje.slice(0, 4)) - 120;
      return data < hoje && Number(data.slice(0, 4)) >= anoMinimo ? data : null;
    }
    case "idadeDeclarada": {
      const idade = typeof valor === "number" ? valor : typeof valor === "string" && /^\s*\d{1,3}\s*$/.test(valor) ? Number(valor) : NaN;
      return Number.isInteger(idade) && idade >= 0 && idade <= 120 ? idade : null;
    }
    case "estadoUf": {
      const uf = texto(valor)?.toUpperCase();
      return uf && UFS.has(uf) ? uf : null;
    }
    case "instagram": {
      const bruto = texto(valor);
      if (!bruto) return null;
      const usuario = bruto
        .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
        .replace(/^@/, "")
        .replace(/[/?#].*$/, "");
      return /^[A-Za-z0-9._]{1,30}$/.test(usuario) ? usuario : null;
    }
    case "objetivosDeclarados": {
      const lista = (Array.isArray(valor) ? valor : [valor]).map(item => texto(item, 120)).filter((item): item is string => Boolean(item));
      return lista.length > 0 && lista.length <= 3 ? lista : null;
    }
    case "preferredLanguage": {
      const idioma = texto(valor);
      return idioma && IDIOMAS.has(idioma) ? idioma : null;
    }
    case "nome":
      return nomeEhPlaceholder(texto(valor)) ? null : texto(valor, 120);
    default:
      return texto(valor);
  }
}

/** Parte pura: aplica whitelist e validadores. */
export function validarCampos(campos: unknown, now = new Date()): { validos: Partial<Record<CampoDb, unknown>>; rejeitados: Rejeitado[] } {
  const validos: Partial<Record<CampoDb, unknown>> = {};
  const rejeitados: Rejeitado[] = [];
  if (!campos || typeof campos !== "object" || Array.isArray(campos)) {
    return { validos, rejeitados: [{ campo: "campos", motivo: "formato_invalido" }] };
  }
  for (const [chave, valor] of Object.entries(campos as Record<string, unknown>)) {
    const campo = CAMPOS_FICHA[chave];
    if (!campo) { rejeitados.push({ campo: chave, motivo: "campo_nao_permitido" }); continue; }
    if (valor === null || valor === undefined || (typeof valor === "string" && !valor.trim())) {
      rejeitados.push({ campo: chave, motivo: "vazio" });
      continue;
    }
    const validado = validar(campo, valor, now);
    if (validado === null) rejeitados.push({ campo: chave, motivo: "valor_invalido" });
    else validos[campo] = validado;
  }
  return { validos, rejeitados };
}

function preenchido(valor: unknown): boolean {
  if (valor === null || valor === undefined) return false;
  if (Array.isArray(valor)) return valor.length > 0;
  return String(valor).trim() !== "";
}

/**
 * Parte pura: decide o que gravar frente à ficha atual. `nome` só substitui
 * placeholder ou, quando estende o nome atual, completa o sobrenome vazio.
 */
export function planejarEscrita(
  atual: Partial<Record<CampoDb, unknown>>,
  validos: Partial<Record<CampoDb, unknown>>,
): { gravar: Partial<Record<CampoDb, unknown>>; conflitos: CampoDb[] } {
  const gravar: Partial<Record<CampoDb, unknown>> = {};
  const conflitos: CampoDb[] = [];
  for (const [campo, valor] of Object.entries(validos) as Array<[CampoDb, unknown]>) {
    if (campo === "nome") {
      const nomeAtual = typeof atual.nome === "string" ? atual.nome.trim() : "";
      if (nomeEhPlaceholder(nomeAtual)) { gravar.nome = valor; continue; }
      const novo = String(valor);
      const mesmoInicio = novo.toLowerCase().startsWith(`${nomeAtual.toLowerCase()} `);
      const resto = mesmoInicio ? novo.slice(nomeAtual.length).trim() : "";
      if (novo.toLowerCase() === nomeAtual.toLowerCase()) continue;
      if (resto && !preenchido(atual.sobrenome) && validos.sobrenome === undefined) { gravar.sobrenome = resto; continue; }
      conflitos.push("nome");
      continue;
    }
    if (preenchido(atual[campo])) {
      if (String(atual[campo]).toLowerCase() !== String(valor).toLowerCase()) conflitos.push(campo);
      continue;
    }
    gravar[campo] = valor;
  }
  return { gravar, conflitos };
}

export async function atualizarFicha(params: {
  pessoaId: number | null;
  conversationId: number;
  campos: unknown;
  now?: Date;
}): Promise<AtualizarFichaResultado> {
  const now = params.now ?? new Date();
  const { validos, rejeitados } = validarCampos(params.campos, now);
  if (!params.pessoaId) {
    return {
      aplicados: [],
      conflitos: [],
      rejeitados: [...rejeitados, ...Object.keys(validos).map(campo => ({ campo: CAMPO_DA_TOOL[campo as CampoDb], motivo: "conversa_sem_ficha" }))],
      instrucao: "Esta conversa não está ligada a uma ficha. Não diga que anotou nada.",
    };
  }
  if (Object.keys(validos).length === 0) return { aplicados: [], conflitos: [], rejeitados };

  const pessoaId = params.pessoaId;
  const origem = `sofia:conversa:${params.conversationId}`;
  const resultado = await withPessoaLock(pessoaId, async tx => {
    const [atual] = await tx.select().from(pessoasTable).where(eq(pessoasTable.id, pessoaId)).limit(1);
    const { gravar, conflitos } = planejarEscrita((atual ?? {}) as Partial<Record<CampoDb, unknown>>, validos);
    for (const campo of conflitos) {
      await registrarEvidencia({ pessoaId, campo, valor: validos[campo], tipoEvidencia: "declarada", origem, aplicada: false }, tx);
    }
    const comData: Record<string, unknown> = { ...gravar };
    if (gravar.idadeDeclarada !== undefined) comData.idadeDeclaradaEm = hojeEmSaoPaulo(now);
    const { aplicaveis, bloqueados } = await registrarDeclaracaoNaConversa(pessoaId, comData, origem, tx);
    if (Object.keys(aplicaveis).length > 0) {
      await tx.update(pessoasTable).set({ ...aplicaveis, updatedAt: now }).where(eq(pessoasTable.id, pessoaId));
    }
    return {
      aplicados: Object.keys(aplicaveis).filter(campo => campo in CAMPO_DA_TOOL).map(campo => CAMPO_DA_TOOL[campo as CampoDb]),
      conflitos: [...conflitos, ...bloqueados.filter(campo => campo in CAMPO_DA_TOOL) as CampoDb[]]
        .map(campo => ({ campo: CAMPO_DA_TOOL[campo], valor_atual_existe: true as const })),
    };
  });
  logger.info(
    { conversationId: params.conversationId, aplicados: resultado.aplicados.length, conflitos: resultado.conflitos.length, rejeitados: rejeitados.length },
    "Sofia simples: atualizar_ficha",
  );
  return { ...resultado, rejeitados };
}
