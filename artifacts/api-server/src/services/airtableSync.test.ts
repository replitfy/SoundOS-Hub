import { describe, expect, it } from "vitest";
// The executable is intentionally plain ESM so it can be invoked as a
// one-shot script without adding it to the API build graph.
import { buildPlan, classStatus, enrollmentStatusPlan, exactDate, mappedContractStatus, mapPersonRecord, normalizedEmail, normalizedPhone, resolveIdentity, sufficientIdentity } from "../../scripts/importar-airtable-soundos.mjs";

describe("Airtable SoundOS pure import rules", () => {
  it("normalizes email and phone without using a shared phone arbitrarily", () => {
    expect(normalizedEmail("  Ana@Example.COM ")).toBe("ana@example.com");
    expect(normalizedPhone("+55 (11) 99999-0000")).toBe("5511999990000");
    const ana = { id: 1 };
    const bia = { id: 2 };
    expect(resolveIdentity([], [ana, bia])).toEqual({ kind: "conflict", reason: "ambiguous" });
  });

  it("accepts a consistent unique match and rejects contradictory contacts", () => {
    const ana = { id: 1 };
    const bia = { id: 2 };
    expect(resolveIdentity([ana], [ana])).toEqual({ kind: "match", person: ana, matchedBy: "both" });
    expect(resolveIdentity([ana], [bia])).toEqual({ kind: "conflict", reason: "contradictory" });
  });

  it("imports complete dates only and never invents a day", () => {
    expect(exactDate("2026-08-17")).toBe("2026-08-17");
    expect(exactDate("2026-08-17T00:00:00.000Z")).toBe("2026-08-17");
    expect(exactDate("08/2026")).toBeNull();
    expect(exactDate("2026-02-31")).toBeNull();
  });

  it("does not infer an end date or close a future class", () => {
    expect(classStatus("2026-12-01", null, "2026-09-14")).toBe("Planejada");
    expect(classStatus("2026-09-01", null, "2026-09-14")).toBe("Em Andamento");
    expect(classStatus("2020-01-01", "2020-01-02", "2026-09-14")).toBe("Encerrada");
  });

  it("never imports payment status and maps only an exact contract boolean", () => {
    expect(enrollmentStatusPlan(null)).toEqual({
      insert: { paymentStatus: "pending", contractStatus: "pending" },
      update: {},
    });
    expect(enrollmentStatusPlan(true)).toEqual({
      insert: { paymentStatus: "pending", contractStatus: "Assinado" },
      update: { contractStatus: "Assinado" },
    });
    expect(mappedContractStatus(true)).toBe("Assinado");
    expect(mappedContractStatus("assinado")).toBeNull();
    expect(mappedContractStatus("true")).toBeNull();
    expect(mappedContractStatus("sim")).toBeNull();
    expect(mappedContractStatus("não assinado")).toBeNull();
    expect(mappedContractStatus(false)).toBeNull();
  });

  it.each(["pago", "paid", "quitado", "não pago"])(
    "ignores the non-authoritative Airtable payment value %s",
    (paymentValue) => {
      const personId = "recPerson";
      const eventId = "recEvent";
      const plan = buildPlan({
        clientes: [{ id: personId, fields: { Nome: "Ana Silva", Email: "new@example.com" } }],
        eventos2026: [{ id: eventId, fields: { Nome: "Curso Seguro", "Data início": "2026-12-01" } }],
        eventosHistoricos: [],
        services: [],
        inscricoes: [{
          id: "recEnrollment",
          fields: {
            Cliente: [personId],
            Evento: [eventId],
            "Status de pagamento": paymentValue,
          },
        }],
      });
      const enrollment = (plan.enrollments as Array<{ contractStatus?: unknown }>)[0];
      expect(enrollment).not.toHaveProperty("paymentStatus");
      expect(enrollmentStatusPlan(enrollment?.contractStatus)).toEqual({
        insert: { paymentStatus: "pending", contractStatus: "pending" },
        update: {},
      });
    },
  );

  it("requires a name plus a usable identity for creation", () => {
    expect(sufficientIdentity({ nome: "Ana", email: "ana@example.com" })).toBe(true);
    expect(sufficientIdentity({ nome: "Ana", email: null, phone: "11999990000" })).toBe(true);
    expect(sufficientIdentity({ nome: "Ana", email: null, phone: null })).toBe(false);
    expect(sufficientIdentity({ nome: null, email: "ana@example.com" })).toBe(false);
  });

  it("maps common Portuguese contact fields without exposing them in a report", () => {
    expect(mapPersonRecord({
      id: "rec123",
      fields: { "Nome completo": "Ana Silva", "E-mail": "ANA@example.com", WhatsApp: "(11) 99999-0000" },
    })).toMatchObject({
      sourceRecordId: "rec123",
      nome: "Ana",
      sobrenome: "Silva",
      email: "ana@example.com",
      celular_normalizado: "11999990000",
    });
  });

  it("sends every duplicated source identity to review", () => {
    const source = {
      clientes: [
        { id: "rec1", fields: { Nome: "Ana Silva", Email: "same@example.com" } },
        { id: "rec2", fields: { Nome: "Outra Pessoa", Email: "same@example.com" } },
      ],
      eventos2026: [],
      eventosHistoricos: [],
      services: [],
      inscricoes: [],
    };
    const plan = buildPlan(source, [{ id: 1, email: "same@example.com" }]);
    expect(plan.counts.personConflicts).toBe(2);
    expect(plan.counts.matchedPeople).toBe(0);
    expect(plan.personPlans.map((item: { action: string }) => item.action)).toEqual(["conflict", "conflict"]);
  });

  it("does not let two source rows claim one existing person through different contacts", () => {
    const source = {
      clientes: [
        { id: "rec1", fields: { Nome: "Ana Silva", Email: "ana@example.com" } },
        { id: "rec2", fields: { Nome: "Bia Souza", WhatsApp: "11999990000" } },
      ],
      eventos2026: [],
      eventosHistoricos: [],
      services: [],
      inscricoes: [],
    };
    const existing = [{ id: 1, email: "ana@example.com", celular: "11999990000" }];
    const plan = buildPlan(source, existing);
    expect(plan.counts.personConflicts).toBe(2);
    expect(plan.counts.matchedPeople).toBe(0);
    expect(plan.sourcePersonToEntity.size).toBe(0);
  });

  it("plans an enrollment for a person created in the same transaction", () => {
    const personId = "recPerson";
    const eventId = "recEvent";
    const source = {
      clientes: [{ id: personId, fields: { Nome: "Ana Silva", Email: "new@example.com" } }],
      eventos2026: [{ id: eventId, fields: { Nome: "Curso Seguro", "Data início": "2026-12-01" } }],
      eventosHistoricos: [],
      services: [],
      inscricoes: [{
        id: "recEnrollment",
        fields: { Cliente: [personId], Evento: [eventId] },
      }],
    };
    const plan = buildPlan(source);
    expect(plan.counts.newPeople).toBe(1);
    expect(plan.counts.plannedEnrollments).toBe(1);
    expect(plan.counts.unresolvedEnrollments).toBe(0);
  });

  it("sends every duplicated source enrollment pair to review", () => {
    const personId = "recPerson";
    const eventId = "recEvent";
    const enrollmentFields = { Cliente: [personId], Evento: [eventId] };
    const source = {
      clientes: [{ id: personId, fields: { Nome: "Ana Silva", Email: "new@example.com" } }],
      eventos2026: [{ id: eventId, fields: { Nome: "Curso Seguro", "Data início": "2026-12-01" } }],
      eventosHistoricos: [],
      services: [],
      inscricoes: [
        { id: "recEnrollment1", fields: enrollmentFields },
        { id: "recEnrollment2", fields: enrollmentFields },
      ],
    };
    const plan = buildPlan(source);
    expect(plan.counts.plannedEnrollments).toBe(0);
    expect(plan.counts.unresolvedEnrollments).toBe(2);
    expect(plan.counts.duplicateSourceEnrollments).toBe(2);
  });
});