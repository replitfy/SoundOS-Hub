import { and, asc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { classesTable, coursesTable, cursosInscricao, db } from "@workspace/db";
import { getOfficialEventCatalog } from "./sofiaEventCatalog";
import { ocultarValoresEmReais, ocultarValoresOpcional } from "./ocultarValores.js";

const OPERATIONAL_STATUSES = ["scheduled", "in_progress", "planejada", "aberta", "em andamento"] as const;

export interface UpcomingOffering {
  eventId?: number;
  classId: number | null;
  courseId: number | null;
  courseName: string;
  startDate: string | null;
  endDate: string | null;
  location: string | null;
  modality: string | null;
  description: string | null;
  workload: number | null;
  status: string;
  /** Página oficial do evento, quando sincronizada do site. */
  url?: string | null;
}

export interface UpcomingOfferingsSource {
  tables: ["classes", "courses"] | ["cursos_inscricao", "classes", "courses"];
  fetchedAt: string;
  policy: "public_course_facts" | "public_event_agenda";
}

export interface UpcomingOfferingsResult {
  items: UpcomingOffering[];
  source: UpcomingOfferingsSource;
}

export interface UpcomingOfferingsFilters {
  kind?: "course" | "event";
  query?: string;
  requireNameMatch?: boolean;
  modality?: string;
  location?: string;
  now?: Date;
}

export type UpcomingOfferingField =
  | "name"
  | "date"
  | "location"
  | "link"
  | "modality"
  | "description"
  | "workload"
  | "price";

interface UpcomingOfferingRow {
  classId: number;
  courseId: number;
  courseName: string;
  startDate: string;
  endDate: string | null;
  location: string | null;
  modality: string;
  description: string | null;
  workload: number;
  status: string;
  eventType?: string | null;
}

interface CourseCatalogRow {
  courseId: number;
  courseName: string;
  modality: string;
  description: string | null;
  workload: number;
}

const EVENT_NAME_PATTERN = /(evento|retiro|viv[eê]ncia|imers[aã]o|cerim[oô]nia|concerto|workshop)/i;

function isEventRow(row: UpcomingOfferingRow): boolean {
  return Boolean(
    (row.eventType && row.eventType.toUpperCase() !== "CURSO")
    || EVENT_NAME_PATTERN.test(row.courseName),
  );
}

function normalizedMatchText(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function rowsMatchingNamedOffering<T extends { courseName: string }>(rows: T[], query: string | undefined): T[] {
  if (!query?.trim()) return [];
  const normalizedQuery = normalizedMatchText(query);
  return rows.filter(row => {
    const normalizedName = normalizedMatchText(row.courseName);
    if (normalizedQuery.includes(normalizedName)) return true;
    const distinctiveTokens = normalizedName
      .split(/[^a-z0-9]+/)
      .filter(token => token.length >= 5 && !["curso", "ciclo", "formacao", "sound", "healing"].includes(token));
    return distinctiveTokens.length > 0 && distinctiveTokens.every(token =>
      new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`).test(normalizedQuery),
    );
  });
}

function todayInSaoPaulo(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function normalizedFilter(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase() : null;
}

function toPublicOffering(row: UpcomingOfferingRow): UpcomingOffering {
  return {
    classId: row.classId,
    courseId: row.courseId,
    courseName: row.courseName,
    startDate: row.startDate,
    endDate: row.endDate,
    location: row.location,
    modality: row.modality,
    description: ocultarValoresOpcional(row.description),
    workload: row.workload,
    status: row.status,
  };
}

export async function listUpcomingOfferings(
  filters: UpcomingOfferingsFilters = {},
): Promise<UpcomingOfferingsResult> {
  if (filters.kind === "event") {
    const catalog = await getOfficialEventCatalog(filters);
    return {
      source: catalog.source,
      items: catalog.items.map(item => ({
        eventId: item.eventId,
        classId: item.classId,
        courseId: item.courseId,
        courseName: item.name,
        startDate: item.startDate,
        endDate: item.endDate,
        location: item.location,
        modality: item.modality,
        description: ocultarValoresOpcional(item.description),
        workload: item.workload,
        status: "active",
        url: item.sourceUrl,
      })),
    };
  }
  const today = todayInSaoPaulo(filters.now ?? new Date());
  const modality = normalizedFilter(filters.modality);
  const location = normalizedFilter(filters.location);
  const normalizedLocationSql = sql`TRANSLATE(LOWER(${classesTable.location}), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`;
  const conditions = [
    eq(coursesTable.active, true),
    isNotNull(classesTable.startDate),
    sql`COALESCE(${classesTable.endDate}, ${classesTable.startDate}) >= ${today}`,
    sql`LOWER(${classesTable.status}) IN (${sql.join(OPERATIONAL_STATUSES.map(status => sql`${status}`), sql`, `)})`,
    or(isNull(cursosInscricao.id), eq(cursosInscricao.ativo, true)),
    ...(modality ? [ilike(coursesTable.modality, `%${modality}%`)] : []),
    ...(location
      ? /^[a-z]{2}$/.test(location)
        ? [sql`${normalizedLocationSql} ~ ${`(^|[^a-z])${location}([^a-z]|$)`}`]
        : [sql`${normalizedLocationSql} LIKE ${`%${location}%`}`]
      : []),
  ];

  const rows = await db
    .select({
      classId: classesTable.id,
      courseId: coursesTable.id,
      courseName: coursesTable.name,
      startDate: classesTable.startDate,
      endDate: classesTable.endDate,
      location: classesTable.location,
      modality: coursesTable.modality,
      description: coursesTable.description,
      workload: coursesTable.workload,
      status: classesTable.status,
      eventType: cursosInscricao.tipoEvento,
    })
    .from(classesTable)
    .innerJoin(coursesTable, eq(classesTable.courseId, coursesTable.id))
    .leftJoin(cursosInscricao, eq(cursosInscricao.classId, classesTable.id))
    .where(and(...conditions))
    .orderBy(asc(classesTable.startDate), asc(classesTable.id));

  const allRows = rows as UpcomingOfferingRow[];
  const namedRows = rowsMatchingNamedOffering(allRows, filters.query);
  if (filters.requireNameMatch && namedRows.length === 0) {
    const catalogRows = await db
      .select({
        courseId: coursesTable.id,
        courseName: coursesTable.name,
        modality: coursesTable.modality,
        description: coursesTable.description,
        workload: coursesTable.workload,
      })
      .from(coursesTable)
      .where(eq(coursesTable.active, true))
      .orderBy(asc(coursesTable.id));
    const matchedCatalogRows = rowsMatchingNamedOffering(
      catalogRows as CourseCatalogRow[],
      filters.query,
    ).filter(row => {
      const event = EVENT_NAME_PATTERN.test(row.courseName);
      return filters.kind === "event" ? event : filters.kind === "course" ? !event : true;
    });
    return {
      items: matchedCatalogRows.map(row => ({
        classId: null,
        courseId: row.courseId,
        courseName: row.courseName,
        startDate: null,
        endDate: null,
        location: null,
        modality: row.modality,
        description: ocultarValoresOpcional(row.description),
        workload: row.workload,
        status: "catalog",
      })),
      source: {
        tables: ["classes", "courses"],
        fetchedAt: new Date().toISOString(),
        policy: "public_course_facts",
      },
    };
  }
  const identityRows = namedRows.length > 0
    ? namedRows
    : filters.requireNameMatch
      ? []
      : allRows;
  const classifiedRows = identityRows.filter(row =>
    filters.kind === "event" ? isEventRow(row) : filters.kind === "course" ? !isEventRow(row) : true,
  );
  const publicRows = classifiedRows.map(toPublicOffering);
  const nearestDate = publicRows[0]?.startDate;
  return {
    items: nearestDate ? publicRows.filter(item => item.startDate === nearestDate) : [],
    source: {
      tables: ["classes", "courses"],
      fetchedAt: new Date().toISOString(),
      policy: "public_course_facts",
    },
  };
}

function formatDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return date;
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "UTC",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formattedDate(item: UpcomingOffering): string | null {
  return item.startDate
    ? item.endDate && item.endDate !== item.startDate
      ? `${formatDate(item.startDate)} a ${formatDate(item.endDate)}`
      : formatDate(item.startDate)
    : null;
}

function formatOffering(
  item: UpcomingOffering,
  index?: number,
  requestedFields?: readonly UpcomingOfferingField[],
): string {
  const prefix = index === undefined ? "" : `${index}. `;
  const date = formattedDate(item);
  const fields = requestedFields?.length
    ? requestedFields
    : ["name", "date", "location"] as const;
  const values: Record<UpcomingOfferingField, string> = {
    name: `${prefix}${ocultarValoresEmReais(item.courseName)}`,
    date: date
      ? `Data: ${date}`
      : item.classId === null
        ? "Data: nenhuma turma futura confirmada."
        : "Data: ainda não informada.",
    location: item.location ? `Local: ${ocultarValoresEmReais(item.location)}` : "Local: ainda não informado.",
    link: item.url ? `Link oficial: ${item.url}` : "Link oficial: ainda não informado.",
    modality: item.modality ? `Modalidade: ${ocultarValoresEmReais(item.modality)}` : "Modalidade: ainda não informada.",
    description: item.description ? `Sobre: ${ocultarValoresEmReais(item.description)}` : "Sobre: ainda não informado.",
    workload: item.workload !== null ? `Carga horária: ${item.workload}h` : "Carga horária: ainda não informada.",
    // Valor de evento/curso nunca é informado pela Sofia (decisão do dono):
    // o time comercial retorna com valores e condições.
    price: "Valor: o time interno informa valores e condições.",
  };
  const separator = requestedFields?.length ? "\n" : " — ";
  return fields.map(field => values[field]).join(separator);
}

export function formatUpcomingOfferings(
  result: UpcomingOfferingsResult,
  requestedFields?: readonly UpcomingOfferingField[],
): string {
  if (result.items.length === 0) {
    return result.source.policy === "public_event_agenda"
      ? "Não há data publicada para um evento futuro compatível."
      : "Não encontrei curso ou turma futura com data confirmada.";
  }
  return result.items.length === 1
    ? formatOffering(result.items[0]!, undefined, requestedFields)
    : result.items
      .map((item, index) => formatOffering(item, index + 1, requestedFields))
      .join("\n");
}