import { eq, inArray } from "drizzle-orm";
import { cursosInscricao, db } from "@workspace/db";
import type { EventDocument } from "./soundfulnessEvents";
import {
  planOfficialEventAgendaReconciliation,
  type ExistingEventAgendaRow,
  type OfficialEventAgendaValues,
} from "./officialEventAgenda";

function toDatabaseValues(values: OfficialEventAgendaValues) {
  return {
    slug: values.slug,
    nome: values.name,
    descricao: values.description,
    dataInicio: values.startDate,
    dataFim: values.endDate,
    local: values.location,
    observacoes: values.observations,
    ativo: values.active,
    nucleo: values.nucleus,
    tipoEvento: values.eventType,
  };
}

export async function syncOfficialEventAgenda(
  documents: EventDocument[],
  confirmedMissingSourceUrls: string[],
) {
  const rows = await db.select({
    id: cursosInscricao.id,
    slug: cursosInscricao.slug,
    name: cursosInscricao.nome,
    description: cursosInscricao.descricao,
    startDate: cursosInscricao.dataInicio,
    endDate: cursosInscricao.dataFim,
    location: cursosInscricao.local,
    observations: cursosInscricao.observacoes,
    active: cursosInscricao.ativo,
    nucleus: cursosInscricao.nucleo,
    eventType: cursosInscricao.tipoEvento,
    classId: cursosInscricao.classId,
    courseId: cursosInscricao.courseId,
  }).from(cursosInscricao) as ExistingEventAgendaRow[];

  const plan = planOfficialEventAgendaReconciliation({
    snapshots: documents.map(document => document.event),
    existingRows: rows,
    confirmedMissingSourceUrls,
  });

  const syncedEvents: Array<{
    title: string;
    sourceUrl: string;
    status: "created" | "updated" | "unchanged";
    eventId: number;
  }> = [];
  await db.transaction(async tx => {
    for (const change of plan.changes) {
      if (change.status === "unchanged") {
        syncedEvents.push({
          title: change.values.name,
          sourceUrl: change.sourceUrl,
          status: change.status,
          eventId: change.existingId!,
        });
        continue;
      }
      const values = toDatabaseValues(change.values);
      if (change.existingId !== null) {
        await tx.update(cursosInscricao)
          .set(values)
          .where(eq(cursosInscricao.id, change.existingId));
        syncedEvents.push({
          title: change.values.name,
          sourceUrl: change.sourceUrl,
          status: change.status,
          eventId: change.existingId,
        });
      } else {
        const [created] = await tx.insert(cursosInscricao)
          .values(values)
          .returning({ id: cursosInscricao.id });
        syncedEvents.push({
          title: change.values.name,
          sourceUrl: change.sourceUrl,
          status: change.status,
          eventId: created!.id,
        });
      }
    }
    if (plan.archiveIds.length > 0) {
      await tx.update(cursosInscricao)
        .set({ ativo: false })
        .where(inArray(cursosInscricao.id, plan.archiveIds));
    }
  });

  return {
    events: syncedEvents,
    archived: plan.archiveIds.length,
  };
}