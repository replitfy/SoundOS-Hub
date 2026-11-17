import { describe, expect, it } from "vitest";
import {
  officialEventSourceObservation,
  planOfficialEventAgendaReconciliation,
  registrationLinkUpdateValues,
  type ExistingEventAgendaRow,
  type OfficialEventSnapshot,
} from "./officialEventAgenda";

const arEvent: OfficialEventSnapshot = {
  name: "CICLO AR - Retiro de Imersão em Arte Cerimonial",
  description: "Imersão residencial completa.",
  startDate: "2026-10-07",
  endDate: "2026-10-12",
  location: "Campos do Jordão",
  address: "Campos do Jordão, SP, Brasil",
  sourceUrl: "https://www.soundfulness.online/event-details/ciclo-ar",
};

const concertEvent: OfficialEventSnapshot = {
  name: "CONCERTO MEDITATIVO - Banho de Gongs com Cacau",
  description: "Jornada sonora imersiva.",
  startDate: "2026-10-28",
  endDate: "2026-10-28",
  location: "São Paulo",
  address: "São Paulo, SP, Brasil",
  sourceUrl: "https://www.soundfulness.online/event-details/concerto-meditativo",
};

function existingRow(overrides: Partial<ExistingEventAgendaRow> = {}): ExistingEventAgendaRow {
  return {
    id: 6,
    slug: "ciclo-ar-out-2026",
    name: arEvent.name,
    description: null,
    startDate: arEvent.startDate,
    endDate: null,
    location: "Aldeia do Holon — Serra da Mantiqueira, SP",
    observations: null,
    active: true,
    nucleus: "EDUCATION",
    eventType: "CURSO",
    classId: 4,
    courseId: 4,
    ...overrides,
  };
}

describe("official event agenda reconciliation", () => {
  it("prevents class and course edits from overwriting official event fields", () => {
    const generatedValues = {
      name: "Ciclo Ar — AR_PRESENCIAL_OUT/26_turma_01_SP",
      location: "MG",
      startDate: "2026-10-01",
      endDate: "2026-10-01",
      courseId: 4,
    };
    expect(registrationLinkUpdateValues(null, generatedValues)).toEqual(generatedValues);
    expect(registrationLinkUpdateValues(
      officialEventSourceObservation(null, arEvent.sourceUrl),
      generatedValues,
    )).toEqual({ courseId: 4 });
  });

  it("updates a matching event and creates an absent official event", () => {
    const result = planOfficialEventAgendaReconciliation({
      snapshots: [arEvent, concertEvent],
      existingRows: [existingRow()],
      confirmedMissingSourceUrls: [],
    });

    expect(result.changes).toEqual([
      expect.objectContaining({
        status: "updated",
        existingId: 6,
        values: expect.objectContaining({
          slug: "ciclo-ar-out-2026",
          location: "Campos do Jordão",
          endDate: "2026-10-12",
          observations: officialEventSourceObservation(null, arEvent.sourceUrl),
        }),
      }),
      expect.objectContaining({
        status: "created",
        existingId: null,
        values: expect.objectContaining({
          slug: "site-event-concerto-meditativo",
          name: concertEvent.name,
          eventType: "CONCERTO",
          active: true,
        }),
      }),
    ]);
    expect(result.archiveIds).toEqual([]);
  });

  it("is idempotent once an event matches the official snapshot", () => {
    const observations = officialEventSourceObservation("Equipe: confirmar alimentação.", arEvent.sourceUrl);
    const result = planOfficialEventAgendaReconciliation({
      snapshots: [arEvent],
      existingRows: [existingRow({
        description: arEvent.description,
        endDate: arEvent.endDate,
        location: arEvent.location,
        observations,
      })],
      confirmedMissingSourceUrls: [],
    });

    expect(result.changes).toEqual([
      expect.objectContaining({ status: "unchanged", existingId: 6 }),
    ]);
    expect(result.changes[0]!.values.observations).toBe(observations);
  });

  it("archives only previously synchronized rows and only for a complete snapshot", () => {
    const managed = existingRow({
      id: 7,
      slug: "site-event-antigo",
      name: "Evento antigo",
      observations: officialEventSourceObservation(null, "https://www.soundfulness.online/event-details/antigo"),
    });
    const manual = existingRow({ id: 8, slug: "evento-manual", name: "Evento manual" });

    expect(planOfficialEventAgendaReconciliation({
      snapshots: [],
      existingRows: [managed, manual],
      confirmedMissingSourceUrls: ["https://www.soundfulness.online/event-details/antigo"],
    }).archiveIds).toEqual([7]);

    expect(planOfficialEventAgendaReconciliation({
      snapshots: [],
      existingRows: [managed, manual],
      confirmedMissingSourceUrls: [],
    }).archiveIds).toEqual([]);
  });

  it("does not archive a consumed row when the official page URL changes", () => {
    const previousUrl = "https://www.soundfulness.online/event-details/ciclo-ar-antigo";
    const current = {
      ...arEvent,
      sourceUrl: "https://www.soundfulness.online/event-details/ciclo-ar-atual",
    };
    const result = planOfficialEventAgendaReconciliation({
      snapshots: [current],
      existingRows: [existingRow({
        observations: officialEventSourceObservation(null, previousUrl),
      })],
      confirmedMissingSourceUrls: [previousUrl],
    });

    expect(result.changes).toEqual([
      expect.objectContaining({ status: "updated", existingId: 6 }),
    ]);
    expect(result.archiveIds).toEqual([]);
  });

  it("creates a new recurring edition instead of reusing a provenanced historical row", () => {
    const januaryUrl = "https://www.soundfulness.online/event-details/ciclo-agua-2";
    const mayUrl = "https://www.soundfulness.online/event-details/ciclo-agua-3";
    const octoberUrl = "https://www.soundfulness.online/event-details/ciclo-agua-4";
    const waterBase = {
      name: "CICLO ÁGUA - Sound Healing Individual",
      description: "Formação em Sound Healing.",
      endDate: null,
      location: "São Paulo",
      address: "São Paulo, SP, Brasil",
    };
    const january = existingRow({
      id: 30,
      slug: "ciclo-agua-jan-2027",
      name: waterBase.name,
      startDate: "2027-01-13",
      observations: officialEventSourceObservation(null, januaryUrl),
    });
    const may = existingRow({
      id: 31,
      slug: "ciclo-agua-mai-2027",
      name: waterBase.name,
      description: waterBase.description,
      startDate: "2027-05-26",
      location: waterBase.location,
      observations: officialEventSourceObservation(null, mayUrl),
    });

    const result = planOfficialEventAgendaReconciliation({
      snapshots: [
        { ...waterBase, startDate: "2027-05-26", sourceUrl: mayUrl },
        { ...waterBase, startDate: "2027-10-20", sourceUrl: octoberUrl },
      ],
      existingRows: [january, may],
      confirmedMissingSourceUrls: [januaryUrl],
    });

    expect(result.changes).toEqual([
      expect.objectContaining({ status: "unchanged", existingId: 31 }),
      expect.objectContaining({
        status: "created",
        existingId: null,
        values: expect.objectContaining({
          slug: "site-event-ciclo-agua-4",
          startDate: "2027-10-20",
        }),
      }),
    ]);
    expect(result.archiveIds).toEqual([30]);
  });
});