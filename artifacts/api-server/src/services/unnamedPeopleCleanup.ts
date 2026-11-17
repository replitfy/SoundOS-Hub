import { db, pessoasTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { filtrarAtualizacaoInferida } from "./evidencias";

const PLACEHOLDER_NAME = "(sem nome)";
const FALLBACK_NAME = "Fulano de Tal";
const GENERIC_EMAIL_WORDS = new Set([
  "admin",
  "atendimento",
  "comercial",
  "contato",
  "education",
  "eventos",
  "financeiro",
  "hello",
  "info",
  "loja",
  "marketing",
  "noreply",
  "office",
  "oi",
  "sac",
  "shop",
  "soundfulness",
  "store",
  "suporte",
  "vendas",
]);

function capitalizeWord(word: string): string {
  return word.charAt(0).toLocaleUpperCase("pt-BR") + word.slice(1).toLocaleLowerCase("pt-BR");
}

export function inferNameFromEmail(email: string): string | null {
  const trimmed = email.trim();
  const separator = trimmed.indexOf("@");
  if (separator <= 0 || separator === trimmed.length - 1) return null;

  const localPart = trimmed.slice(0, separator).split("+", 1)[0] ?? "";
  const tokens = localPart
    .normalize("NFKC")
    .replace(/[._-]+/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^\p{L}\s']/gu, " ")
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2 && !GENERIC_EMAIL_WORDS.has(token.toLocaleLowerCase("pt-BR")));

  if (tokens.length === 0) return null;
  return tokens.map(capitalizeWord).join(" ");
}

export interface UnnamedPeopleCleanupResult {
  inferred: number;
  fallback: number;
  deleted: number;
  preservedWithLinks: number;
}

interface LockedPerson {
  id: number;
  email: string | null;
}

export async function cleanupUnnamedPeople(
  options: { personIds?: number[] } = {},
): Promise<UnnamedPeopleCleanupResult> {
  const personIds = options.personIds;
  if (personIds && (
    personIds.length === 0
    || personIds.some(id => !Number.isSafeInteger(id) || id <= 0)
  )) {
    throw new Error("O escopo da limpeza contém identificadores inválidos.");
  }
  const personIdList = personIds
    ? sql.join(personIds.map(id => sql`${id}`), sql`, `)
    : null;
  const personScope = personIdList
    ? sql`AND id IN (${personIdList})`
    : sql.empty();
  const aliasedPersonScope = personIdList
    ? sql`AND p.id IN (${personIdList})`
    : sql.empty();

  return db.transaction(async tx => {
    const locked = await tx.execute(sql`
      SELECT id, email
      FROM pessoas
      WHERE LOWER(BTRIM(nome)) = ${PLACEHOLDER_NAME}
        ${personScope}
      FOR UPDATE
    `);
    const people = locked.rows as unknown as LockedPerson[];
    const withEmail = people.filter(
      person => typeof person.email === "string" && person.email.trim().length > 0,
    );

    let inferred = 0;
    let fallback = 0;
    for (const person of withEmail) {
      const inferredName = inferNameFromEmail(person.email!);
      const name = inferredName ?? FALLBACK_NAME;
      const { aplicaveis } = await filtrarAtualizacaoInferida(
        person.id,
        { nome: name },
        "manutencao:inferencia-email",
        tx,
      );
      if (typeof aplicaveis.nome !== "string") continue;
      const updated = await tx
        .update(pessoasTable)
        .set({ nome: aplicaveis.nome, updatedAt: new Date() })
        .where(eq(pessoasTable.id, person.id))
        .returning({ id: pessoasTable.id });
      if (updated.length !== 1) throw new Error(`Não foi possível atualizar a pessoa ${person.id}.`);
      if (inferredName) inferred += 1;
      else fallback += 1;
    }

    const deletable = await tx.execute(sql`
      SELECT p.id
      FROM pessoas p
      WHERE LOWER(BTRIM(p.nome)) = ${PLACEHOLDER_NAME}
        AND NULLIF(BTRIM(p.email), '') IS NULL
        ${aliasedPersonScope}
        AND NOT EXISTS (SELECT 1 FROM commercial_opportunities x WHERE x.pessoa_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM enrollments x WHERE x.pessoa_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM evento_formulario_submissoes x WHERE x.pessoa_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM interesse_geral_submissoes x WHERE x.pessoa_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM evento_preinscricoes x WHERE x.pessoa_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM conversations x WHERE x.pessoa_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM video_envios x WHERE x.pessoa_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM sofia_decision_runs x WHERE x.pessoa_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM pessoa_evidencias x WHERE x.pessoa_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM pessoa_campos_confirmados x WHERE x.pessoa_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM pessoa_servicos x WHERE x.pessoa_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM pessoa_participacoes x WHERE x.pessoa_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM pessoa_instrumentos x WHERE x.pessoa_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM pessoa_contato_registros x WHERE x.pessoa_id = p.id)
      FOR UPDATE OF p
    `);
    const deletableIds = deletable.rows.map(row => Number((row as { id: unknown }).id));
    if (deletableIds.some(id => !Number.isSafeInteger(id))) {
      throw new Error("A seleção de pessoas excluíveis retornou um identificador inválido.");
    }
    if (deletableIds.length > 0) {
      await tx.delete(pessoasTable).where(inArray(pessoasTable.id, deletableIds));
    }

    const remaining = await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM pessoas
      WHERE LOWER(BTRIM(nome)) = ${PLACEHOLDER_NAME}
        AND NULLIF(BTRIM(email), '') IS NULL
        ${personScope}
    `);
    const preservedWithLinks = Number((remaining.rows[0] as { count?: unknown } | undefined)?.count);
    if (!Number.isSafeInteger(preservedWithLinks)) {
      throw new Error("Não foi possível validar as pessoas preservadas.");
    }

    const remainingWithEmail = await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM pessoas
      WHERE LOWER(BTRIM(nome)) = ${PLACEHOLDER_NAME}
        AND NULLIF(BTRIM(email), '') IS NOT NULL
        ${personScope}
    `);
    if (Number((remainingWithEmail.rows[0] as { count?: unknown } | undefined)?.count) !== 0) {
      throw new Error("Ainda existem pessoas com e-mail e nome não identificado.");
    }

    return {
      inferred,
      fallback,
      deleted: deletableIds.length,
      preservedWithLinks,
    };
  });
}