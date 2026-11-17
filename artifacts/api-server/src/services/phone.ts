/**
 * Normalizador único de telefone da aplicação.
 *
 * Espelha a função SQL VIVA `format_brazilian_phone` (migração 030) e o
 * trigger `normalize_celular`: remove o `55` de números com 12/13 dígitos e
 * considera válido DDD + número (10 ou 11 dígitos). A migração 032 não está
 * aplicada; não siga o arquivo dela. `key` é exatamente o que o trigger grava
 * em `celular_normalizado` — a aplicação só lê essa coluna, nunca escreve.
 */
export interface NormalizedPhone {
  valid: boolean;
  /** Valor equivalente a `pessoas.celular_normalizado` para comparação. */
  key: string | null;
  /** Valor equivalente a `pessoas.celular` depois do trigger. */
  display: string | null;
}

export function normalizeBrazilianPhone(raw: string | null | undefined): NormalizedPhone {
  if (raw == null || raw.trim() === "" || /#ERROR!/i.test(raw)) {
    return { valid: false, key: null, display: null };
  }
  let digits = raw.replace(/\D/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    digits = digits.slice(2);
  }
  if (digits.length === 10 || digits.length === 11) {
    return { valid: true, key: digits, display: `${digits.slice(0, 2)}-${digits.slice(2)}` };
  }
  const trimmed = raw.trim();
  return { valid: false, key: trimmed.replace(/\D/g, "") || null, display: trimmed };
}
