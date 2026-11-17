export const OFFICIAL_EVENT_SOURCE_PREFIX = "Fonte oficial sincronizada: ";
const MANAGED_EVENT_SLUG_PREFIX = "site-event-";

export interface OfficialEventSnapshot {
  name: string;
  description: string | null;
  startDate: string;
  endDate: string | null;
  location: string | null;
  address: string | null;
  sourceUrl: string;
}

export interface ExistingEventAgendaRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  location: string | null;
  observations: string | null;
  active: boolean;
  nucleus: string;
  eventType: string;
  classId: number | null;
  courseId: number | null;
}

export interface OfficialEventAgendaValues {
  slug: string;
  name: string;
  description: string | null;
  startDate: string;
  endDate: string | null;
  location: string | null;
  observations: string;
  active: true;
  nucleus: string;
  eventType: string;
}

export interface OfficialEventAgendaChange {
  status: "created" | "updated" | "unchanged";
  existingId: number | null;
  sourceUrl: string;
  values: OfficialEventAgendaValues;
}

export interface OfficialEventAgendaPlan {
  changes: OfficialEventAgendaChange[];
  archiveIds: number[];
}

function canonicalSourceUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function normalizedIdentity(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function sourceUrlFromObservations(observations: string | null): string | null {
  const sourceLine = observations
    ?.split(/\r?\n/)
    .find(line => line.trim().startsWith(OFFICIAL_EVENT_SOURCE_PREFIX));
  if (!sourceLine) return null;
  const rawUrl = sourceLine.trim().slice(OFFICIAL_EVENT_SOURCE_PREFIX.length).trim();
  try {
    return canonicalSourceUrl(rawUrl);
  } catch {
    return null;
  }
}

/**
 * URL pública do evento, apenas quando aponta para uma página oficial de evento
 * do site (`https://www.soundfulness.online/event-details/...`).
 */
export function officialEventUrlFromObservations(observations: string | null): string | null {
  const url = sourceUrlFromObservations(observations);
  return url && isOfficialEventUrl(url) ? url : null;
}

export function isOfficialEventUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "www.soundfulness.online"
      && /^\/event-details\/[^/]+/.test(url.pathname);
  } catch {
    return false;
  }
}

export function registrationLinkUpdateValues<T extends { courseId: number }>(
  observations: string | null,
  generatedValues: T,
): T | Pick<T, "courseId"> {
  return sourceUrlFromObservations(observations) === null
    ? generatedValues
    : { courseId: generatedValues.courseId };
}

export function officialEventSourceObservation(
  observations: string | null,
  sourceUrl: string,
): string {
  const preservedLines = (observations ?? "")
    .split(/\r?\n/)
    .filter(line => !line.trim().startsWith(OFFICIAL_EVENT_SOURCE_PREFIX))
    .join("\n")
    .trim();
  const sourceLine = `${OFFICIAL_EVENT_SOURCE_PREFIX}${canonicalSourceUrl(sourceUrl)}`;
  return preservedLines ? `${preservedLines}\n${sourceLine}` : sourceLine;
}

function managedSlug(sourceUrl: string): string {
  const pathname = new URL(sourceUrl).pathname;
  const pageSlug = decodeURIComponent(pathname.split("/").filter(Boolean).pop() ?? "evento")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "evento";
  return `${MANAGED_EVENT_SLUG_PREFIX}${pageSlug}`;
}

function availableSlug(base: string, reservedSlugs: Set<string>): string {
  if (!reservedSlugs.has(base)) {
    reservedSlugs.add(base);
    return base;
  }
  for (let suffix = 2; suffix <= 1_000; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!reservedSlugs.has(candidate)) {
      reservedSlugs.add(candidate);
      return candidate;
    }
  }
  throw new Error(`Não foi possível gerar um slug livre para ${base}.`);
}

function eventClassification(name: string): { nucleus: string; eventType: string } {
  const identity = normalizedIdentity(name);
  if (identity.startsWith("ciclo ")) {
    return { nucleus: "EDUCATION", eventType: "CURSO" };
  }
  if (/\bconcerto\b/.test(identity)) return { nucleus: "EXPERIENCES", eventType: "CONCERTO" };
  if (/\bvivencia\b/.test(identity)) return { nucleus: "EXPERIENCES", eventType: "VIVENCIA" };
  if (/\bworkshop\b/.test(identity)) return { nucleus: "EXPERIENCES", eventType: "WORKSHOP" };
  if (/\bcerimonia\b/.test(identity)) return { nucleus: "EXPERIENCES", eventType: "CERIMONIA" };
  if (/\bretiro\b/.test(identity)) return { nucleus: "EXPERIENCES", eventType: "RETIRO" };
  return { nucleus: "EDUCATION", eventType: "CURSO" };
}

function daysBetween(left: string | null, right: string): number {
  if (!left) return Number.POSITIVE_INFINITY;
  const leftMs = Date.parse(`${left}T00:00:00Z`);
  const rightMs = Date.parse(`${right}T00:00:00Z`);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs)
    ? Math.abs(leftMs - rightMs)
    : Number.POSITIVE_INFINITY;
}

function valuesMatch(
  existing: ExistingEventAgendaRow,
  values: OfficialEventAgendaValues,
): boolean {
  return existing.slug === values.slug
    && existing.name === values.name
    && existing.description === values.description
    && existing.startDate === values.startDate
    && existing.endDate === values.endDate
    && existing.location === values.location
    && existing.observations === values.observations
    && existing.active === values.active
    && existing.nucleus === values.nucleus
    && existing.eventType === values.eventType;
}

export function planOfficialEventAgendaReconciliation(input: {
  snapshots: OfficialEventSnapshot[];
  existingRows: ExistingEventAgendaRow[];
  confirmedMissingSourceUrls: string[];
}): OfficialEventAgendaPlan {
  const deduplicatedSnapshots = new Map<string, OfficialEventSnapshot>();
  for (const snapshot of input.snapshots) {
    deduplicatedSnapshots.set(canonicalSourceUrl(snapshot.sourceUrl), {
      ...snapshot,
      sourceUrl: canonicalSourceUrl(snapshot.sourceUrl),
    });
  }
  const snapshots = [...deduplicatedSnapshots.values()]
    .sort((left, right) => left.startDate.localeCompare(right.startDate) || left.name.localeCompare(right.name));
  const reservedSlugs = new Set(input.existingRows.map(row => row.slug));
  const unmatchedRows = new Map(input.existingRows.map(row => [row.id, row]));
  const liveSourceUrls = new Set(snapshots.map(snapshot => snapshot.sourceUrl));
  const confirmedMissingSourceUrls = new Set(
    input.confirmedMissingSourceUrls.map(canonicalSourceUrl),
  );
  const changes: OfficialEventAgendaChange[] = [];

  for (const snapshot of snapshots) {
    const expectedManagedSlug = managedSlug(snapshot.sourceUrl);
    const candidates = [...unmatchedRows.values()];
    let existing = candidates.find(row =>
      sourceUrlFromObservations(row.observations) === snapshot.sourceUrl,
    );
    existing ??= candidates.find(row => row.slug === expectedManagedSlug);
    existing ??= candidates.find(row =>
      normalizedIdentity(row.name) === normalizedIdentity(snapshot.name)
      && row.startDate === snapshot.startDate,
    );
    existing ??= candidates
      .filter(row =>
        sourceUrlFromObservations(row.observations) === null
        && normalizedIdentity(row.name) === normalizedIdentity(snapshot.name),
      )
      .sort((left, right) =>
        daysBetween(left.startDate, snapshot.startDate) - daysBetween(right.startDate, snapshot.startDate)
        || left.id - right.id,
      )[0];

    const classification = eventClassification(snapshot.name);
    const values: OfficialEventAgendaValues = {
      slug: existing?.slug ?? availableSlug(expectedManagedSlug, reservedSlugs),
      name: snapshot.name,
      description: snapshot.description ?? existing?.description ?? null,
      startDate: snapshot.startDate,
      endDate: snapshot.endDate,
      location: snapshot.location,
      observations: officialEventSourceObservation(existing?.observations ?? null, snapshot.sourceUrl),
      active: true,
      nucleus: existing?.nucleus ?? classification.nucleus,
      eventType: existing?.eventType ?? classification.eventType,
    };
    const status = !existing
      ? "created"
      : valuesMatch(existing, values)
        ? "unchanged"
        : "updated";
    changes.push({
      status,
      existingId: existing?.id ?? null,
      sourceUrl: snapshot.sourceUrl,
      values,
    });
    if (existing) unmatchedRows.delete(existing.id);
  }

  const archiveIds = [...unmatchedRows.values()]
      .filter(row => {
        const sourceUrl = sourceUrlFromObservations(row.observations);
        return row.active
          && sourceUrl !== null
          && !liveSourceUrls.has(sourceUrl)
          && confirmedMissingSourceUrls.has(sourceUrl);
      })
      .map(row => row.id)
      .sort((left, right) => left - right);

  return { changes, archiveIds };
}