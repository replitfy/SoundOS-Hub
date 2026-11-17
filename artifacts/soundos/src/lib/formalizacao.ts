export interface FormalizacaoInfo {
  id: number;
  amount: string;
  reference: string;
  confirmedAt: string | null;
  expiresAt: string | null;
  completedAt: string | null;
  revokedAt: string | null;
}

export type FormalizacaoState = "none" | "pending" | "completed" | "revoked" | "expired";

export function formalizacaoState(f: FormalizacaoInfo | null | undefined, now: number = Date.now()): FormalizacaoState {
  if (!f) return "none";
  if (f.completedAt) return "completed";
  if (f.revokedAt) return "revoked";
  if (f.expiresAt && new Date(f.expiresAt).getTime() < now) return "expired";
  return "pending";
}

/** origin + BASE_URL prefix + formalizacao/<token>. Never persisted. */
export function buildFormalizacaoUrl(token: string, origin: string = window.location.origin, base: string = import.meta.env.BASE_URL): string {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${origin}${prefix}formalizacao/${encodeURIComponent(token)}`;
}

export function isSofiaOwned(o: { ownerUserId?: number | null; ownerSystem?: string | null } | null | undefined): boolean {
  return !!o && o.ownerUserId == null && o.ownerSystem === "SOFIA";
}

export interface FormSubmissionMeta {
  answers: Record<string, unknown>;
  eventName: string;
  submissionId: string | number;
  /** Só o formulário de interesse genérico informa o grupo e a página onde estava embarcado. */
  grupo: string | null;
  paginaOrigem: string | null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function extractFormSubmission(metadata: unknown): FormSubmissionMeta | null {
  if (!metadata || typeof metadata !== "object") return null;
  const fs = (metadata as Record<string, unknown>).formSubmission;
  if (!fs || typeof fs !== "object") return null;
  const { answers, eventName, submissionId, grupo, paginaOrigem } = fs as Record<string, unknown>;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  if (typeof eventName !== "string") return null;
  if (typeof submissionId !== "string" && typeof submissionId !== "number") return null;
  return {
    answers: answers as Record<string, unknown>,
    eventName,
    submissionId,
    grupo: optionalText(grupo),
    paginaOrigem: optionalText(paginaOrigem),
  };
}

export type SofiaFichaKey = "cidade" | "profissao" | "servicoInteresse" | "objetivos";

export interface SofiaConversationMeta {
  conversationId: number | null;
  mensagens: string[];
  /** Só campos preenchidos, na ordem de exibição. */
  ficha: Array<{ chave: SofiaFichaKey; valor: string }>;
}

const SOFIA_FICHA_KEYS: readonly SofiaFichaKey[] = ["cidade", "profissao", "servicoInteresse", "objetivos"];

/** Trecho da conversa com a Sofia que acompanha o histórico de um cartão de interesse. */
export function extractSofiaConversation(metadata: unknown): SofiaConversationMeta | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).sofiaConversation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { conversationId, mensagens, ficha } = raw as Record<string, unknown>;

  const mensagensLimpas = Array.isArray(mensagens)
    ? mensagens.filter((m): m is string => typeof m === "string" && m.trim().length > 0).map((m) => m.trim())
    : [];

  const fichaLimpa: SofiaConversationMeta["ficha"] = [];
  if (ficha && typeof ficha === "object" && !Array.isArray(ficha)) {
    const campos = ficha as Record<string, unknown>;
    for (const chave of SOFIA_FICHA_KEYS) {
      const valor = campos[chave];
      const texto = Array.isArray(valor)
        ? valor.filter((v): v is string => typeof v === "string" && v.trim().length > 0).join(", ")
        : typeof valor === "string" ? valor.trim() : "";
      if (texto) fichaLimpa.push({ chave, valor: texto });
    }
  }

  return {
    conversationId: typeof conversationId === "number" && Number.isInteger(conversationId) && conversationId > 0 ? conversationId : null,
    mensagens: mensagensLimpas,
    ficha: fichaLimpa,
  };
}

/** Endereço da tela de conversa da Sofia aberta na conversa e na pessoa certas. */
export function sofiaConversationHref(pessoaId: number | null | undefined, conversationId: number): string {
  return pessoaId ? `/sofia?pessoa=${pessoaId}&conv=${conversationId}` : `/sofia?conv=${conversationId}`;
}

export function formatAnswer(v: unknown): string {
  if (v == null || v === "") return "-";
  if (Array.isArray(v)) return v.map(formatAnswer).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
