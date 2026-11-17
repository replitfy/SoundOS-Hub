import {
  db,
  enrollmentsTable,
  eventoFormularioSubmissoes,
  eventoFormularios,
  interesseGeralSubmissoes,
} from "@workspace/db";
import { and, eq, gte, lt } from "drizzle-orm";

export interface LeadGrowthRow {
  pessoaId: number;
  createdAt: Date;
}

export interface LeadGrowthPoint {
  day: string;
  leads: number;
}

export interface LeadGrowthWindow {
  days: string[];
  start: Date;
  end: Date;
}

const REPORT_TIME_ZONE = "America/Sao_Paulo";
const zonedPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: REPORT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date): ZonedDateParts {
  const parts = Object.fromEntries(
    zonedPartsFormatter.formatToParts(date)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function localMidnightUtc(year: number, month: number, day: number): Date {
  // Treat the requested São Paulo wall-clock time as UTC first, then use the
  // offset reported by Intl to convert it to the corresponding UTC instant.
  // Repeating the calculation handles offset changes around DST transitions
  // and historical timezone rules without maintaining a manual offset table.
  const wallClockUtc = Date.UTC(year, month - 1, day);
  let utc = wallClockUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(utc));
    const representedAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    utc = wallClockUtc - (representedAsUtc - utc);
  }
  return new Date(utc);
}

function addDays(year: number, month: number, day: number, offset: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function currentLeadGrowthWindow(now = new Date()): LeadGrowthWindow {
  const current = zonedParts(now);
  const firstDay = addDays(current.year, current.month, current.day, -29);
  const nextDay = addDays(current.year, current.month, current.day, 1);
  const start = localMidnightUtc(firstDay.year, firstDay.month, firstDay.day);
  const end = localMidnightUtc(nextDay.year, nextDay.month, nextDay.day);
  const days: string[] = [];
  for (let offset = -29; offset <= 0; offset += 1) {
    const date = addDays(current.year, current.month, current.day, offset);
    days.push(dayKey(date.year, date.month, date.day));
  }
  return { days, start, end };
}

function dayKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function countDistinctPeopleByDay(rows: LeadGrowthRow[], days: Set<string>): Map<string, number> {
  const peopleByDay = new Map<string, Set<number>>();
  for (const row of rows) {
    const local = zonedParts(row.createdAt);
    const day = dayKey(local.year, local.month, local.day);
    if (!days.has(day)) continue;
    const people = peopleByDay.get(day) ?? new Set<number>();
    people.add(row.pessoaId);
    peopleByDay.set(day, people);
  }
  return new Map([...peopleByDay].map(([day, people]) => [day, people.size]));
}

export function aggregateLeadGrowth(
  days: string[],
  leadRows: LeadGrowthRow[],
): LeadGrowthPoint[] {
  const daySet = new Set(days);
  const leadCounts = countDistinctPeopleByDay(leadRows, daySet);
  return days.map(day => ({
    day,
    leads: leadCounts.get(day) ?? 0,
  }));
}

export async function collectLeadGrowth(): Promise<LeadGrowthPoint[]> {
  const window = currentLeadGrowthWindow();
  const leadRows = await db
    .select({
      pessoaId: eventoFormularioSubmissoes.pessoaId,
      createdAt: eventoFormularioSubmissoes.createdAt,
    })
    .from(eventoFormularioSubmissoes)
    .innerJoin(
      eventoFormularios,
      eq(eventoFormularioSubmissoes.formularioId, eventoFormularios.id),
    )
    .where(and(
      eq(eventoFormularios.tipo, "INTERESSE"),
      gte(eventoFormularioSubmissoes.createdAt, window.start),
      lt(eventoFormularioSubmissoes.createdAt, window.end),
    ));
  // O formulário de interesse genérico (Wix) não tem evento, mas também é lead.
  const generalRows = await db
    .select({
      pessoaId: interesseGeralSubmissoes.pessoaId,
      createdAt: interesseGeralSubmissoes.createdAt,
    })
    .from(interesseGeralSubmissoes)
    .where(and(
      gte(interesseGeralSubmissoes.createdAt, window.start),
      lt(interesseGeralSubmissoes.createdAt, window.end),
    ));
  return aggregateLeadGrowth(window.days, [...leadRows, ...generalRows]);
}