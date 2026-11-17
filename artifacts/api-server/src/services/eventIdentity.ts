import { randomInt } from "node:crypto";
import { eq, ilike, sql } from "drizzle-orm";
import { db, pessoasTable } from "@workspace/db";
import { normalizeBrazilianPhone } from "./phone";
import { namesLikelySame, resolveContactMatches } from "./identityMatching";
import { registrarDeclaracaoPublica } from "./evidencias";
import { nomeEhPlaceholder } from "./sofiaPessoa";

export type EventTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class EventFlowError extends Error {
  constructor(message: string, public status = 409, public code = "EVENT_FLOW_CONFLICT") { super(message); }
}
export function normalizeCpf(input: unknown): string | null {
  if (input == null || input === "") return null;
  if (typeof input !== "string" || !/^[\d.\s-]+$/.test(input)) throw new EventFlowError("Informe um CPF válido.", 400, "INVALID_CPF");
  const cpf = input.replace(/\D/g, "");
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) throw new EventFlowError("Informe um CPF válido.", 400, "INVALID_CPF");
  for (const size of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += Number(cpf[i]) * (size + 1 - i);
    const digit = (sum * 10) % 11 % 10;
    if (digit !== Number(cpf[size])) throw new EventFlowError("Informe um CPF válido.", 400, "INVALID_CPF");
  }
  return cpf;
}
const KNOWN = new Set(["nome","sobrenome","email","celular","instagram","cpf","dataNascimento","sexo","profissao","enderecoRua","cidade","estadoUf","cep","comoFicouSabendo","qualAmigoParceiro","conectadoProposito","lugarMusicaSom","participouTrabalhoSom","qualTrabalhoSom","buscaEspiritual","formacaoMusicaTerapia","outroCurso","terapeuta","objetivoCurso","intencaoPrincipal","cursoExpectativas","servicoInteresse"]);

export type PessoaRow = typeof pessoasTable.$inferSelect;

export interface IdentityReviewDetails {
  /** Todas as fichas que algum identificador informado encontrou (sem repetir). */
  candidatos: PessoaRow[];
  cpfIds: number[];
  emailIds: number[];
  phoneIds: number[];
}

/**
 * Identidade que só a equipe resolve (contatos divergentes, CPF em duas fichas, ficha arquivada...).
 * A mensagem é a de sempre, porque a formalização (link com pessoa já definida) ainda a devolve;
 * os formulários públicos de interesse nunca a repassam ao cliente: veja identidadeConferencia.ts.
 */
export class IdentityReviewError extends EventFlowError {
  constructor(message: string, public readonly detalhes: IdentityReviewDetails, status = 409, code = "EVENT_FLOW_CONFLICT") {
    super(message, status, code);
  }
  /** O motivo sem o pedido ao cliente ("Peça conferência à equipe."). */
  get motivo(): string {
    return this.message.replace(/\s*Peça conferência à equipe\.?$/, "").trim();
  }
}

export interface SubmittedIdentifiers { cpf: string | null; email: string; phone: string }

export function submittedIdentifiers(answers: Record<string, string>): SubmittedIdentifiers {
  return {
    cpf: normalizeCpf(answers.cpf),
    email: answers.email?.trim().toLowerCase() ?? "",
    phone: normalizeBrazilianPhone(answers.celular ?? "").key ?? "",
  };
}

/** Campos da ficha que a pessoa declarou, já normalizados para identificação. */
export function declaredFields(answers: Record<string, string>, { cpf, email, phone }: SubmittedIdentifiers): Record<string, unknown> {
  const declared: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) if (KNOWN.has(key) && value?.trim()) declared[key] = value.trim();
  if (cpf) declared.cpf = cpf;
  if (email) declared.email = email;
  if (phone) declared.celularNormalizado = phone;
  return declared;
}

/** Lê a ficha de novo sob trava: outro caminho pode arquivá-la ou editá-la. */
export async function readPersonLocked(tx: EventTx, personId: number): Promise<PessoaRow | undefined> {
  const [current] = await tx.select().from(pessoasTable).where(eq(pessoasTable.id, personId)).for("update");
  return current;
}

/** Grava a declaração pela trilha de evidências (campos confirmados por humano nunca são sobrescritos). */
export async function applyDeclaration(tx: EventTx, personId: number, declared: Record<string, unknown>): Promise<void> {
  const { aplicaveis } = await registrarDeclaracaoPublica(personId, declared, "formulario_evento", tx);
  if (Object.keys(aplicaveis).length) await tx.update(pessoasTable).set({ ...aplicaveis, updatedAt: new Date() }).where(eq(pessoasTable.id, personId));
}

export async function createDeclaredPerson(tx: EventTx, nome: string, declared: Record<string, unknown>): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const [created] = await tx.insert(pessoasTable).values({
      codigo: `PS-${randomInt(100000, 1000000)}`, nome, ...declared,
    }).onConflictDoNothing({ target: pessoasTable.codigo }).returning({ id: pessoasTable.id });
    if (!created) continue;
    await registrarDeclaracaoPublica(created.id, declared, "formulario_evento", tx);
    return created.id;
  }
  throw new EventFlowError("Não foi possível criar o cadastro. Tente novamente.", 503);
}

/** Serializa envios com os mesmos identificadores (CPF, e-mail, celular). */
export async function lockIdentifiers(tx: EventTx, { cpf, email, phone }: SubmittedIdentifiers): Promise<void> {
  const locks = [cpf && `pessoa-cpf:${cpf}`, email && `pessoa-email:${email}`, phone && `pessoa-phone:${phone}`].filter(Boolean).sort();
  for (const lock of locks) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`);
}

/** A public declaration is never allowed to select an arbitrary shared contact. */
export async function resolveEventPerson(tx: EventTx, answers: Record<string, string>, boundId?: number): Promise<number> {
  const identifiers = submittedIdentifiers(answers);
  const { cpf, email, phone } = identifiers;
  await lockIdentifiers(tx, identifiers);
  const emails = email ? await tx.select().from(pessoasTable).where(ilike(pessoasTable.email, email)).limit(4) : [];
  const phones = phone ? await tx.select().from(pessoasTable).where(eq(pessoasTable.celularNormalizado, phone)).limit(4) : [];
  const cpfs = cpf ? await tx.select().from(pessoasTable).where(sql`regexp_replace(coalesce(${pessoasTable.cpf}, ''), '[^0-9]', '', 'g') = ${cpf}`).limit(4) : [];
  const review = (message: string, status?: number, code?: string) => {
    const candidatos = new Map<number, PessoaRow>();
    for (const row of [...cpfs, ...emails, ...phones]) candidatos.set(row.id, row);
    return new IdentityReviewError(message, {
      candidatos: [...candidatos.values()],
      cpfIds: cpfs.map(row => row.id), emailIds: emails.map(row => row.id), phoneIds: phones.map(row => row.id),
    }, status, code);
  };
  if (cpfs.length > 1) throw review("CPF associado a mais de uma ficha. Peça conferência à equipe.");
  const contact = resolveContactMatches(emails, phones);
  let person = cpfs[0];
  if (person) {
    // A shared number is acceptable only when it includes the CPF owner.
    if ((emails.length && !emails.some(p => p.id === person!.id)) || (phones.length && !phones.some(p => p.id === person!.id))) {
      throw review("CPF e contatos apontam para pessoas diferentes. Peça conferência à equipe.");
    }
  } else {
    if (contact.kind === "conflict") throw review("Contatos ambíguos ou divergentes. Peça conferência à equipe.");
    if (contact.kind === "match") {
      person = contact.person;
      const existingCpf = person.cpf?.replace(/\D/g, "");
      if (cpf && existingCpf && cpf !== existingCpf) throw review("CPF e contatos apontam para pessoas diferentes.");
      // Ficha aberta pelo WhatsApp/Instagram só tem um nome provisório: o nome do formulário vale, não é divergência.
      if (contact.matchedBy === "phone" && !nomeEhPlaceholder(person.nome) && !namesLikelySame([person.nome, person.sobrenome].filter(Boolean).join(" "), [answers.nome, answers.sobrenome].filter(Boolean).join(" "))) {
        throw review("O celular informado pode pertencer a outra pessoa. Peça conferência à equipe.");
      }
    }
  }
  if (boundId && (!person || person.id !== boundId)) throw review("Os dados não correspondem à pessoa deste link. Peça conferência à equipe.", 409, "PERSON_MISMATCH");
  const declared = declaredFields(answers, identifiers);
  if (person) {
    const current = await readPersonLocked(tx, person.id);
    if (!current || current.arquivadoEm || !current.ativo) throw review("Esta pessoa está arquivada e precisa de conferência da equipe.");
    if (cpf && current.cpf?.replace(/\D/g, "") && current.cpf.replace(/\D/g, "") !== cpf) throw review("CPF divergente. Peça conferência à equipe.");
    await applyDeclaration(tx, person.id, declared);
    return person.id;
  }
  return createDeclaredPerson(tx, answers.nome.trim(), declared);
}
