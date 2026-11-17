const TIME_ZONE = "America/Sao_Paulo";

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export interface SaoPauloParts {
  year: number;
  month: number;
  day: number;
}

function zonedParts(date: Date): Record<string, number> {
  return Object.fromEntries(
    partsFormatter
      .formatToParts(date)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, Number(part.value)]),
  );
}

/** Diferença (UTC − horário de São Paulo) em ms no instante informado. */
function offsetMs(date: Date): number {
  const parts = zonedParts(date);
  return date.getTime() - Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second,
  );
}

/** Dia civil (ano/mês/dia) em que o instante cai em São Paulo. */
export function saoPauloDate(date: Date): SaoPauloParts {
  const parts = zonedParts(date);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** "AAAA-MM" do mês em que o instante cai em São Paulo. */
export function saoPauloMonthKey(date: Date): string {
  const { year, month } = saoPauloDate(date);
  return `${year}-${pad(month)}`;
}

/** Instante exato da meia-noite de São Paulo no dia civil informado. Dia/mês fora do intervalo são normalizados. */
export function startOfSaoPauloDay(year: number, month: number, day: number): Date {
  const localAsUtc = Date.UTC(year, month - 1, day);
  const first = localAsUtc + offsetMs(new Date(localAsUtc));
  return new Date(localAsUtc + offsetMs(new Date(first)));
}

/** Meia-noite de São Paulo do dia em que o instante cai. */
export function startOfSaoPauloDayContaining(date: Date): Date {
  const { year, month, day } = saoPauloDate(date);
  return startOfSaoPauloDay(year, month, day);
}
