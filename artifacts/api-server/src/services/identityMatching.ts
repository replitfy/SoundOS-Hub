export type IdentityCandidate = {
  id: number;
  nome?: string | null;
  sobrenome?: string | null;
};

export type ContactResolution<T extends IdentityCandidate> =
  | { kind: "none" }
  | { kind: "match"; person: T; matchedBy: "email" | "phone" | "both" }
  | { kind: "conflict"; reason: "contradictory" | "ambiguous" };

export function resolveContactMatches<T extends IdentityCandidate>(
  emailMatches: T[],
  phoneMatches: T[],
): ContactResolution<T> {
  if (emailMatches.length > 0 && phoneMatches.length > 0) {
    const phoneIds = new Set(phoneMatches.map(person => person.id));
    const intersection = emailMatches.filter(person => phoneIds.has(person.id));
    if (intersection.length === 1) return { kind: "match", person: intersection[0]!, matchedBy: "both" };
    if (intersection.length === 0) return { kind: "conflict", reason: "contradictory" };
    return { kind: "conflict", reason: "ambiguous" };
  }
  if (emailMatches.length === 1) return { kind: "match", person: emailMatches[0]!, matchedBy: "email" };
  if (phoneMatches.length === 1) return { kind: "match", person: phoneMatches[0]!, matchedBy: "phone" };
  if (emailMatches.length > 1 || phoneMatches.length > 1) {
    return { kind: "conflict", reason: "ambiguous" };
  }
  return { kind: "none" };
}

export function normalizedName(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Igualdade estrita (sem acento, caixa ou pontuação); nome vazio nunca é igual a nada. */
export function namesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizedName(a ?? "");
  const right = normalizedName(b ?? "");
  return left.length > 0 && left.join(" ") === right.join(" ");
}

export function namesLikelySame(existing: string | null | undefined, incoming: unknown): boolean {
  if (typeof incoming !== "string" || !incoming.trim() || !existing?.trim()) return true;
  const current = normalizedName(existing);
  const next = normalizedName(incoming);
  if (!current.length || !next.length) return true;
  if (current.join(" ") === next.join(" ")) return true;
  // Sofia often learns the first name before the full name. That is compatible,
  // but different first names on a shared phone are not.
  return current[0] === next[0] && (current.length === 1 || next.length === 1);
}