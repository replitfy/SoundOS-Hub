/**
 * Liga pedidos do Painel Loja às fichas de Pessoas, calculado na hora (nada é gravado).
 *
 * 1. E-mail e telefone: mesma regra dos formulários públicos (`resolveContactMatches`),
 *    só com fichas ativas, não arquivadas e não fundidas em outra.
 * 2. Nome: só quando e-mail e telefone não encontram NENHUMA ficha. Compara o nome do
 *    comprador com o nome completo da ficha pela semelhança de texto (Dice sobre pares de
 *    letras) e exige 75% ou mais, primeira e última palavra idênticas e dois nomes com
 *    pelo menos duas palavras. Só liga se exatamente uma ficha passar.
 *
 * O percentual é semelhança entre textos, não probabilidade, e é sempre arredondado para baixo.
 */
import { and, inArray, isNull, eq, or, sql } from "drizzle-orm";
import { db, pessoasTable } from "@workspace/db";
import { resolveContactMatches } from "./identityMatching";
import { normalizeBrazilianPhone } from "./phone";
import type { StoreOrder } from "./wixOrders";

export const NAME_MIN_SIMILARITY = 75;
export const MAX_REVIEW_CANDIDATES = 5;

/** Conectivos ignorados na comparação ("Maria de Souza" = "Maria Souza"). */
const NAME_CONNECTORS = new Set(["de", "da", "do", "das", "dos", "e"]);

export interface PessoaRef {
  id: number;
  codigo: string;
  /** Nome completo (nome + sobrenome) como está na ficha. */
  nome: string;
}

export interface PessoaCandidate extends PessoaRef {
  /** Semelhança de nome, em %, só quando a candidata veio da comparação por nome. */
  similarity: number | null;
}

export type OrderLinkMode = "email" | "phone" | "both" | "name";

export type OrderPessoaLink =
  | { state: "linked"; mode: OrderLinkMode; person: PessoaRef; similarity: number | null }
  | {
      state: "review";
      /** Origem das candidatas: contato (e-mail/telefone) ou nome. */
      source: "contact" | "name";
      reason: "ambiguous" | "contradictory";
      candidates: PessoaCandidate[];
    }
  /** Nenhuma ficha por e-mail, telefone ou nome. */
  | { state: "none" }
  /** O pedido não traz e-mail, telefone utilizável nem nome. */
  | { state: "unidentifiable" }
  /** Pedido de um retrato antigo, sem e-mail/telefone guardados, e o nome não bastou. */
  | { state: "contact_pending" };

/** Palavras do nome sem acento, caixa, pontuação e conectivos. */
export function nameWords(value: string | null | undefined): string[] {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(word => word && !NAME_CONNECTORS.has(word));
}

function bigramCounts(text: string): Map<string, number> {
  const padded = ` ${text} `;
  const counts = new Map<string, number>();
  for (let index = 0; index < padded.length - 1; index++) {
    const pair = padded.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/**
 * Semelhança em % (inteiro, arredondado para baixo) entre dois nomes já normalizados em palavras.
 * Dice sobre pares de letras de " texto ", feito em inteiros para o limite de 75% ser exato.
 */
export function nameSimilarityPercent(left: string[], right: string[]): number {
  const a = bigramCounts(left.join(" "));
  const b = bigramCounts(right.join(" "));
  let shared = 0;
  let sizeA = 0;
  let sizeB = 0;
  for (const count of a.values()) sizeA += count;
  for (const count of b.values()) sizeB += count;
  for (const [pair, count] of a) shared += Math.min(count, b.get(pair) ?? 0);
  const total = sizeA + sizeB;
  return total === 0 ? 0 : Math.floor((200 * shared) / total);
}

/** Duas palavras ou mais, primeira e última idênticas e semelhança mínima. Devolve o % ou null. */
export function nameMatchPercent(orderWords: string[], fichaWords: string[]): number | null {
  if (orderWords.length < 2 || fichaWords.length < 2) return null;
  if (orderWords[0] !== fichaWords[0]) return null;
  if (orderWords[orderWords.length - 1] !== fichaWords[fichaWords.length - 1]) return null;
  const percent = nameSimilarityPercent(orderWords, fichaWords);
  return percent >= NAME_MIN_SIMILARITY ? percent : null;
}

export function fullName(row: { nome: string; sobrenome: string | null }): string {
  return [row.nome, row.sobrenome].map(part => part?.trim()).filter(Boolean).join(" ");
}

/** Resolve por nome entre as fichas já pré-filtradas. */
export function resolveByName(
  customerName: string | null,
  pool: readonly PessoaRef[],
): OrderPessoaLink | null {
  const orderWords = nameWords(customerName);
  if (orderWords.length < 2) return null;

  const hits: PessoaCandidate[] = [];
  for (const ficha of pool) {
    const similarity = nameMatchPercent(orderWords, nameWords(ficha.nome));
    if (similarity !== null) hits.push({ ...ficha, similarity });
  }
  if (hits.length === 0) return null;
  if (hits.length === 1) {
    const [only] = hits as [PessoaCandidate];
    return {
      state: "linked",
      mode: "name",
      person: { id: only.id, codigo: only.codigo, nome: only.nome },
      similarity: only.similarity,
    };
  }
  hits.sort((x, y) => (y.similarity ?? 0) - (x.similarity ?? 0) || x.id - y.id);
  return { state: "review", source: "name", reason: "ambiguous", candidates: hits.slice(0, MAX_REVIEW_CANDIDATES) };
}

interface ContactIdentity {
  email: string | null;
  phone: string | null;
}

export function contactIdentityOf(order: Pick<StoreOrder, "email" | "phone">): ContactIdentity {
  const email = order.email?.trim().toLowerCase() || null;
  const normalized = normalizeBrazilianPhone(order.phone);
  return { email, phone: normalized.valid ? normalized.key : null };
}

interface FichaContactRow extends PessoaRef {
  emailKey: string | null;
  phoneKey: string | null;
}

/** Decisão por e-mail/telefone, a partir das fichas já encontradas para este pedido. */
export function resolveByContact(
  emailMatches: PessoaRef[],
  phoneMatches: PessoaRef[],
): OrderPessoaLink | null {
  const resolution = resolveContactMatches(emailMatches, phoneMatches);
  if (resolution.kind === "none") return null;
  if (resolution.kind === "match") {
    return { state: "linked", mode: resolution.matchedBy, person: resolution.person, similarity: null };
  }
  const byId = new Map<number, PessoaRef>();
  for (const person of [...emailMatches, ...phoneMatches]) byId.set(person.id, person);
  const candidates = [...byId.values()]
    .sort((x, y) => x.id - y.id)
    .slice(0, MAX_REVIEW_CANDIDATES)
    .map(person => ({ ...person, similarity: null }));
  return { state: "review", source: "contact", reason: resolution.reason, candidates };
}

/** Pedidos de retratos anteriores não têm e-mail/telefone guardados (campos ausentes, não nulos). */
export function orderHasContactData(order: Pick<StoreOrder, "email" | "phone">): boolean {
  return order.email !== undefined || order.phone !== undefined;
}

const ACTIVE_FICHA = and(
  eq(pessoasTable.ativo, true),
  isNull(pessoasTable.arquivadoEm),
  isNull(pessoasTable.mergedIntoPessoaId),
);

type Executor = Pick<typeof db, "select" | "execute">;

async function findFichasByContact(
  executor: Executor,
  emails: string[],
  phones: string[],
): Promise<FichaContactRow[]> {
  if (emails.length === 0 && phones.length === 0) return [];
  const emailExpr = sql<string | null>`lower(btrim(${pessoasTable.email}))`;
  const conditions = [
    emails.length > 0 ? inArray(emailExpr, emails) : undefined,
    phones.length > 0 ? inArray(pessoasTable.celularNormalizado, phones) : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> => condition !== undefined);

  const rows = await executor
    .select({
      id: pessoasTable.id,
      codigo: pessoasTable.codigo,
      nome: pessoasTable.nome,
      sobrenome: pessoasTable.sobrenome,
      emailKey: emailExpr,
      phoneKey: pessoasTable.celularNormalizado,
    })
    .from(pessoasTable)
    .where(and(ACTIVE_FICHA, or(...conditions)));
  return rows.map(row => ({
    id: row.id,
    codigo: row.codigo,
    nome: fullName(row),
    emailKey: row.emailKey,
    phoneKey: row.phoneKey,
  }));
}

const ACCENTS_FROM = "ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäéèêëíìîïóòôõöúùûüçñ";
const ACCENTS_TO = "AAAAAEEEEIIIIOOOOOUUUUCNaaaaaeeeeiiiiooooouuuucn";

/**
 * Fichas ativas cuja primeira e última palavra do nome (sem acento/pontuação) estão nas listas.
 * É só um filtro para não trazer as ~30 mil fichas; a regra de verdade roda em `nameMatchPercent`.
 */
async function findFichasByNameEnds(
  executor: Executor,
  firstWords: string[],
  lastWords: string[],
): Promise<PessoaRef[]> {
  if (firstWords.length === 0 || lastWords.length === 0) return [];
  const result = await executor.execute(sql`
    WITH normalized AS (
      SELECT id, codigo, nome, sobrenome,
        btrim(regexp_replace(
          lower(translate(btrim(coalesce(nome, '') || ' ' || coalesce(sobrenome, '')), ${ACCENTS_FROM}, ${ACCENTS_TO})),
          '[^a-z0-9]+', ' ', 'g'
        )) AS norm
      FROM pessoas
      WHERE ativo = true AND arquivado_em IS NULL AND merged_into_pessoa_id IS NULL
    )
    SELECT id, codigo, nome, sobrenome
    FROM normalized
    WHERE split_part(norm, ' ', 1) IN ${firstWords}
      AND (regexp_match(norm, '([^ ]+)$'))[1] IN ${lastWords}
    ORDER BY id
  `);
  return (result.rows as Array<{ id: number; codigo: string; nome: string; sobrenome: string | null }>).map(row => ({
    id: row.id,
    codigo: row.codigo,
    nome: fullName(row),
  }));
}

/**
 * Resolve a ficha de cada pedido, com no máximo duas leituras de Pessoas por chamada
 * (contato e, só se algum pedido precisar, nome).
 */
export async function linkOrdersToPessoas(
  orders: readonly StoreOrder[],
  executor: Executor = db,
): Promise<Map<string, OrderPessoaLink>> {
  const identities = new Map<string, ContactIdentity>();
  for (const order of orders) identities.set(order.id, contactIdentityOf(order));

  const emails = [...new Set([...identities.values()].map(identity => identity.email).filter((v): v is string => v !== null))];
  const phones = [...new Set([...identities.values()].map(identity => identity.phone).filter((v): v is string => v !== null))];
  const contactRows = await findFichasByContact(executor, emails, phones);

  const byEmail = new Map<string, PessoaRef[]>();
  const byPhone = new Map<string, PessoaRef[]>();
  for (const row of contactRows) {
    const ref: PessoaRef = { id: row.id, codigo: row.codigo, nome: row.nome };
    if (row.emailKey) byEmail.set(row.emailKey, [...(byEmail.get(row.emailKey) ?? []), ref]);
    if (row.phoneKey) byPhone.set(row.phoneKey, [...(byPhone.get(row.phoneKey) ?? []), ref]);
  }

  const results = new Map<string, OrderPessoaLink>();
  const needName: StoreOrder[] = [];
  for (const order of orders) {
    const identity = identities.get(order.id)!;
    const byContact = resolveByContact(
      identity.email ? (byEmail.get(identity.email) ?? []) : [],
      identity.phone ? (byPhone.get(identity.phone) ?? []) : [],
    );
    if (byContact) {
      results.set(order.id, byContact);
      continue;
    }
    if (nameWords(order.customerName).length >= 2) needName.push(order);
    else results.set(order.id, emptyLink(order, identity));
  }

  if (needName.length > 0) {
    const words = needName.map(order => nameWords(order.customerName));
    const pool = await findFichasByNameEnds(
      executor,
      [...new Set(words.map(list => list[0]!))],
      [...new Set(words.map(list => list[list.length - 1]!))],
    );
    for (const order of needName) {
      results.set(
        order.id,
        resolveByName(order.customerName, pool) ?? emptyLink(order, identities.get(order.id)!),
      );
    }
  }
  return results;
}

export interface PessoaOrderLink {
  order: StoreOrder;
  mode: OrderLinkMode;
  similarity: number | null;
}

/**
 * Pedidos que `linkOrdersToPessoas` liga a esta ficha: o caminho inverso da tela de Pedidos,
 * com exatamente a mesma regra (um pedido só aparece aqui se a ficha dele também for esta).
 * Antes de resolver, só descarta pedidos que não poderiam ligar a esta ficha por e-mail,
 * telefone ou nome; quem decide de verdade é `linkOrdersToPessoas`, que também vê as outras fichas.
 */
export async function findOrdersOfPessoa(
  pessoaId: number,
  orders: readonly StoreOrder[],
  executor: Executor = db,
): Promise<PessoaOrderLink[]> {
  if (orders.length === 0) return [];
  const emailExpr = sql<string | null>`lower(btrim(${pessoasTable.email}))`;
  const [ficha] = await executor
    .select({
      nome: pessoasTable.nome,
      sobrenome: pessoasTable.sobrenome,
      emailKey: emailExpr,
      phoneKey: pessoasTable.celularNormalizado,
    })
    .from(pessoasTable)
    .where(and(eq(pessoasTable.id, pessoaId), ACTIVE_FICHA))
    .limit(1);
  if (!ficha) return [];

  const fichaWords = nameWords(fullName(ficha));
  const candidates = orders.filter(order => {
    const identity = contactIdentityOf(order);
    if (ficha.emailKey && identity.email === ficha.emailKey) return true;
    if (ficha.phoneKey && identity.phone === ficha.phoneKey) return true;
    return nameMatchPercent(nameWords(order.customerName), fichaWords) !== null;
  });
  if (candidates.length === 0) return [];

  const links = await linkOrdersToPessoas(candidates, executor);
  return candidates.flatMap(order => {
    const link = links.get(order.id);
    return link?.state === "linked" && link.person.id === pessoaId
      ? [{ order, mode: link.mode, similarity: link.similarity }]
      : [];
  });
}

/** Sem ficha por nenhum critério: separa "não achei", "não há como identificar" e "dado ainda não guardado". */
function emptyLink(order: StoreOrder, identity: ContactIdentity): OrderPessoaLink {
  const hasName = nameWords(order.customerName).length > 0;
  if (!orderHasContactData(order)) return { state: "contact_pending" };
  if (!identity.email && !identity.phone && !hasName) return { state: "unidentifiable" };
  return { state: "none" };
}
