import { describe, expect, it } from "vitest";
import { validateFormFields, withOptionalInstagram } from "./event-forms.validation";

const interest = [
  { key: "nome", label: "Nome", type: "text", required: true },
  { key: "celular", label: "Celular", type: "tel", required: true },
  { key: "instagram", label: "Instagram", type: "text", required: true },
  { key: "email", label: "E-mail", type: "email", required: true },
];

describe("event form validation", () => {
  it("requires immutable interest core fields and canonical types", () => {
    expect(validateFormFields("INTERESSE", interest).ok).toBe(true);
    expect(validateFormFields("INTERESSE", interest.filter(f => f.key !== "instagram")).ok).toBe(false);
    expect(validateFormFields("INTERESSE", interest.map(f => f.key === "celular" ? { ...f, type: "text" } : f)).ok).toBe(false);
    expect(validateFormFields("INTERESSE", interest.map(f => f.key === "email" ? { ...f, active: false } : f)).ok).toBe(false);
  });

  it("keeps Instagram as an essential interest field that is never required", () => {
    const optional = interest.map(f => f.key === "instagram" ? { ...f, required: false } : f);
    const result = validateFormFields("INTERESSE", optional);
    expect(result.ok).toBe(true);
    // Mesmo que o administrador envie o campo como obrigatório (versões antigas), ele é gravado como opcional.
    const forced = validateFormFields("INTERESSE", interest);
    expect(forced.ok && forced.fields.find(f => f.key === "instagram")?.required).toBe(false);
    expect(forced.ok && forced.fields.find(f => f.key === "email")?.required).toBe(true);
    expect(validateFormFields("INTERESSE", optional.map(f => f.key === "instagram" ? { ...f, active: false } : f)).ok).toBe(false);
    expect(validateFormFields("INTERESSE", optional.map(f => f.key === "email" ? { ...f, required: false } : f)).ok).toBe(false);
  });

  it("normalizes stored versions on read, only for the interest form", () => {
    const stored = withOptionalInstagram("INTERESSE", interest) as typeof interest;
    expect(stored.find(f => f.key === "instagram")?.required).toBe(false);
    expect(stored.filter(f => f.key !== "instagram").every(f => f.required)).toBe(true);
    expect(withOptionalInstagram("COMPLETO", interest)).toBe(interest);
    expect(withOptionalInstagram("INTERESSE", null)).toBeNull();
  });

  it("requires complete core fields", () => {
    expect(validateFormFields("COMPLETO", interest.filter(f => f.key !== "instagram")).ok).toBe(true);
    expect(validateFormFields("COMPLETO", interest.filter(f => f.key !== "instagram" && f.key !== "email")).ok).toBe(false);
  });

  it("rejects duplicate and unsafe keys", () => {
    expect(validateFormFields("INTERESSE", [...interest, { key: "email", label: "Outro", type: "text" }]).ok).toBe(false);
    expect(validateFormFields("INTERESSE", interest.map(f => f.key === "nome" ? { ...f, key: "nome;drop" } : f)).ok).toBe(false);
  });

  it("bounds field count and select options", () => {
    expect(validateFormFields("INTERESSE", [...interest, ...Array.from({ length: 97 }, (_, i) => ({ key: `x${i}`, label: "X", type: "text" }))]).ok).toBe(false);
    expect(validateFormFields("INTERESSE", [...interest, { key: "choice", label: "Escolha", type: "select", options: [] }]).ok).toBe(false);
    expect(validateFormFields("INTERESSE", [...interest, { key: "choice", label: "Escolha", type: "select", options: Array.from({ length: 101 }, (_, i) => String(i)) }]).ok).toBe(false);
    expect(validateFormFields("INTERESSE", [...interest, { key: "choice", label: "Escolha", type: "select", options: ["A", "B"] }]).ok).toBe(true);
    expect(validateFormFields("INTERESSE", [...interest, { key: "extra", label: "Extra", type: "text", active: false }]).ok).toBe(true);
  });
});