import { and, asc, eq, ilike, isNotNull, sql } from "drizzle-orm";
import { classesTable, coursesTable, cursosInscricao, db } from "@workspace/db";
import { officialEventUrlFromObservations } from "./officialEventAgenda.js";
import { ocultarValoresEmReais, ocultarValoresOpcional } from "./ocultarValores.js";

export interface OfficialEventCatalogItem {
  eventId: number;
  slug: string;
  name: string;
  description: string | null;
  startDate: string;
  endDate: string | null;
  location: string | null;
  nucleus: string;
  eventType: string;
  classId: number | null;
  courseId: number | null;
  modality: string | null;
  workload: number | null;
  /** Página oficial do evento no site, quando sincronizada. */
  sourceUrl: string | null;
}

export interface OfficialEventCatalog {
  source: {
    tables: ["cursos_inscricao", "classes", "courses"];
    fetchedAt: string;
    policy: "public_event_agenda";
  };
  items: OfficialEventCatalogItem[];
}

export interface OfficialEventCatalogFilters {
  query?: string;
  requireNameMatch?: boolean;
  modality?: string;
  location?: string;
  now?: Date;
  /** Devolve todas as edições futuras, não só as da data mais próxima. */
  allDates?: boolean;
}

type EventCatalogRow = Omit<OfficialEventCatalogItem, "sourceUrl"> & {
  classCode: string | null;
  observations: string | null;
};

function normalize(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR").trim();
}

function todayInSaoPaulo(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function matchesRequestedName(name: string, query: string): boolean {
  const normalizedName = normalize(name);
  const normalizedQuery = normalize(query);
  if (normalizedQuery.includes(normalizedName)) return true;
  const genericTokens = new Set([
    "curso", "cursos", "ciclo", "evento", "eventos", "formacao", "quando", "onde", "qual", "quais", "como",
    "funciona", "preco", "valor", "conteudo", "data", "local", "sobre", "para", "uma",
    "uns", "das", "dos", "com", "sem", "proximo", "proxima",
  ]);
  const tokens = (value: string) => value
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !genericTokens.has(token));
  const requestedIdentity = tokens(normalizedQuery);
  if (requestedIdentity.length === 0) return false;
  const nameIdentity = new Set(tokens(normalizedName));
  return requestedIdentity.every(token => nameIdentity.has(token));
}

function isAutomaticClassSignupLink(row: EventCatalogRow): boolean {
  if (row.classId === null || !row.classCode?.trim()) return false;
  return normalize(row.name).includes(normalize(row.classCode));
}

/** Fixtures de teste automatizado que às vezes ficam ativas no banco. */
function isTestFixture(row: EventCatalogRow): boolean {
  return /^e2e\b/i.test(row.name.trim());
}

function requestedEventSubtype(query: string | undefined): RegExp | null {
  const normalizedQuery = normalize(query ?? "");
  if (/\bretiro\b/.test(normalizedQuery)) return /\bretiro\b/i;
  if (/\bcerimonia\b/.test(normalizedQuery)) return /\bcerim[oô]nia\b/i;
  if (/\bvivencia\b/.test(normalizedQuery)) return /\bviv[eê]ncia\b/i;
  if (/\bimersao\b/.test(normalizedQuery)) return /\bimers[aã]o\b/i;
  if (/\bworkshop\b/.test(normalizedQuery)) return /\bworkshop\b/i;
  return null;
}

export async function getOfficialEventCatalog(
  filters: OfficialEventCatalogFilters = {},
): Promise<OfficialEventCatalog> {
  const today = todayInSaoPaulo(filters.now ?? new Date());
  const location = filters.location?.trim() ? normalize(filters.location) : null;
  const modality = filters.modality?.trim() ? normalize(filters.modality) : null;
  const normalizedLocationSql = sql`TRANSLATE(LOWER(${cursosInscricao.local}), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`;
  const normalizedModalitySql = sql`TRANSLATE(LOWER(${coursesTable.modality}), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`;
  const rows = await db
    .select({
      eventId: cursosInscricao.id,
      slug: cursosInscricao.slug,
      name: cursosInscricao.nome,
      description: sql<string | null>`COALESCE(${cursosInscricao.descricao}, ${coursesTable.description})`,
      startDate: cursosInscricao.dataInicio,
      endDate: cursosInscricao.dataFim,
      location: cursosInscricao.local,
      nucleus: cursosInscricao.nucleo,
      eventType: cursosInscricao.tipoEvento,
      classId: cursosInscricao.classId,
      classCode: classesTable.code,
      courseId: sql<number | null>`COALESCE(${cursosInscricao.courseId}, ${classesTable.courseId})`,
      observations: cursosInscricao.observacoes,
      modality: coursesTable.modality,
      workload: coursesTable.workload,
    })
    .from(cursosInscricao)
    .leftJoin(classesTable, eq(classesTable.id, cursosInscricao.classId))
    .leftJoin(
      coursesTable,
      sql`${coursesTable.id} = COALESCE(${cursosInscricao.courseId}, ${classesTable.courseId})`,
    )
    .where(and(
      eq(cursosInscricao.ativo, true),
      isNotNull(cursosInscricao.dataInicio),
      sql`COALESCE(${cursosInscricao.dataFim}, ${cursosInscricao.dataInicio}) >= ${today}`,
      ...(location
        ? /^[a-z]{2}$/.test(location)
          ? [sql`${normalizedLocationSql} ~ ${`(^|[^a-z])${location}([^a-z]|$)`}`]
          : [sql`${normalizedLocationSql} LIKE ${`%${location}%`}`]
        : []),
      ...(modality ? [ilike(normalizedModalitySql, `%${modality}%`)] : []),
    ))
    .orderBy(asc(cursosInscricao.dataInicio), asc(cursosInscricao.id));

  const subtype = requestedEventSubtype(filters.query);
  const publicRows = (rows as EventCatalogRow[])
    .filter(row => !isAutomaticClassSignupLink(row) && !isTestFixture(row))
    .filter(row => !subtype || subtype.test(`${row.name} ${row.eventType}`))
    .filter(row => !filters.requireNameMatch || Boolean(filters.query?.trim()) && matchesRequestedName(row.name, filters.query!))
    .map(({ classCode: _classCode, observations, ...row }) => {
      const normalizedModality = normalize(row.modality ?? "");
      const placeholderDescription = /^importado da base hist[oó]rica\b/i.test(row.description ?? "");
      return {
        ...row,
        // Preço de evento nunca sai deste catálogo: nem como campo, nem escrito em texto livre.
        name: ocultarValoresEmReais(row.name),
        description: placeholderDescription ? null : ocultarValoresOpcional(row.description),
        location: ocultarValoresOpcional(row.location),
        modality: !normalizedModality || normalizedModality === "nao informada" ? null : ocultarValoresOpcional(row.modality),
        workload: row.workload !== null && row.workload > 0 ? row.workload : null,
        sourceUrl: officialEventUrlFromObservations(observations),
      };
    });
  const nearestDate = publicRows[0]?.startDate;
  return {
    source: {
      tables: ["cursos_inscricao", "classes", "courses"],
      fetchedAt: new Date().toISOString(),
      policy: "public_event_agenda",
    },
    items: filters.allDates
      ? publicRows
      : nearestDate ? publicRows.filter(item => item.startDate === nearestDate) : [],
  };
}