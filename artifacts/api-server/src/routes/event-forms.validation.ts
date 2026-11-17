export type EventFormField = { key: string; label?: string; type?: string; required?: boolean; active?: boolean; options?: string[] };

export function validateSubmission(inputFields: unknown, answers: unknown): { ok: true; answers: Record<string, string> } | { ok: false; error: string } {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return { ok: false, error: "Respostas inválidas." };
  const fields = (inputFields as EventFormField[]).filter(f => f.active !== false);
  if (Object.keys(answers).some(k => !fields.some(f => f.key === k))) return { ok: false, error: "Campo não permitido." };
  const values = answers as Record<string, string>;
  for (const f of fields) {
    const value = values[f.key];
    if (value != null && typeof value !== "string") return { ok: false, error: `${f.label ?? f.key} deve ser texto.` };
    if (f.required && !value?.trim()) return { ok: false, error: `${f.label ?? f.key} é obrigatório.` };
    if (value && value.length > (f.type === "textarea" ? 10000 : 1000)) return { ok: false, error: "Resposta muito longa." };
    if (value && f.type === "select" && !f.options?.includes(value)) return { ok: false, error: `${f.label ?? f.key} inválido.` };
    if (value && f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { ok: false, error: "E-mail inválido." };
    if (value && f.type === "tel" && value.replace(/\D/g, "").length < 10) return { ok: false, error: "Celular inválido." };
    if (value && f.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))) return { ok: false, error: "Data inválida." };
  }
  return { ok: true, answers: Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === "string")) };
}

/**
 * No formulário de interesse o Instagram existe, mas nunca é obrigatório. Versões antigas o gravaram
 * como obrigatório (era a única opção), então a regra vale na leitura e não depende de migração de dados.
 */
export function withOptionalInstagram(tipo: string, fields: unknown): unknown {
  if (tipo !== "INTERESSE" || !Array.isArray(fields)) return fields;
  return (fields as EventFormField[]).map(field => field?.key === "instagram" && field.required ? { ...field, required: false } : field);
}

const FIELD_TYPES = new Set(["text", "email", "tel", "date", "textarea", "select"]);
const CORE_FIELDS: Record<string, string[]> = {
  INTERESSE: ["nome", "celular", "instagram", "email"],
  COMPLETO: ["nome", "celular", "email"],
};

export function validateFormFields(tipo: string, input: unknown): { ok: true; fields: EventFormField[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) return { ok: false, error: "campos deve ser uma lista entre 1 e 100 itens" };
  const fields = input as EventFormField[];
  const keys = new Set<string>();
  for (const field of fields) {
    if (!field || typeof field.key !== "string" || !/^[a-z][a-zA-Z0-9_]{0,63}$/.test(field.key) || keys.has(field.key)) return { ok: false, error: "cada campo deve ter uma chave segura e única" };
    if (typeof field.label !== "string" || !field.label.trim()) return { ok: false, error: `label inválido para ${field.key}` };
    if (typeof field.type !== "string" || !FIELD_TYPES.has(field.type)) return { ok: false, error: `tipo inválido para ${field.key}` };
    if (field.active !== undefined && typeof field.active !== "boolean") return { ok: false, error: `estado inválido para ${field.key}` };
    if (field.type === "select" && (!Array.isArray(field.options) || field.options.length === 0 || field.options.length > 100 || field.options.some(o => typeof o !== "string" || !o.trim() || o.length > 200))) return { ok: false, error: `select ${field.key} precisa de 1 a 100 opções válidas` };
    if (field.type !== "select" && field.options !== undefined) return { ok: false, error: `opções só são permitidas em select (${field.key})` };
    keys.add(field.key);
  }
  const canonical: Record<string, Record<string, string>> = { INTERESSE: { nome: "text", celular: "tel", instagram: "text", email: "email" }, COMPLETO: { nome: "text", celular: "tel", email: "email" } };
  for (const [key, type] of Object.entries(canonical[tipo] ?? {})) {
    const field = fields.find(f => f.key === key);
    const optionalByRule = tipo === "INTERESSE" && key === "instagram";
    if (!field || field.type !== type || (field.required !== true && !optionalByRule) || field.active === false) return { ok: false, error: `campo ${key} deve ser ${type}, obrigatório e ativo` };
  }
  return { ok: true, fields: withOptionalInstagram(tipo, fields) as EventFormField[] };
}