import { useEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import { DynamicForm, type DynamicFormField } from "@/components/dynamic-form";
import { Button } from "@/components/ui/button";
import { useLang } from "@/contexts/language";
import { formatDateTimeBR } from "@/lib/date";
import { AlertTriangle, CheckCircle2, RotateCw, ShieldCheck, Link2Off } from "lucide-react";
import logoPath from "@/assets/logotipo-soundos.png";

interface FormalizacaoDef {
  status: "pending" | "completed";
  evento: { nome: string; local?: string | null; dataInicio?: string | null; dataFim?: string | null };
  campos: DynamicFormField[];
  expiresAt: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "error" }
  | { kind: "ready"; def: FormalizacaoDef };

const KNOWN_CODES = ["PERSON_MISMATCH", "INVALID_CPF", "INVALID_ANSWERS", "EVENT_FLOW_CONFLICT"] as const;
export type SubmissionErrorCode = typeof KNOWN_CODES[number];

export function submissionErrorCode(body: unknown): SubmissionErrorCode | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const nested = b.error && typeof b.error === "object" ? (b.error as Record<string, unknown>).code : undefined;
  for (const c of [b.code, nested, b.error]) {
    if (typeof c === "string" && (KNOWN_CODES as readonly string[]).includes(c)) return c as SubmissionErrorCode;
  }
  return null;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-background">
      <div className="border-b border-border/60 bg-background/95">
        <div className="max-w-xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-3">
          <img src={logoPath} alt="Soundfulness" className="h-8 w-auto" />
        </div>
      </div>
      <div className="max-w-xl mx-auto px-4 sm:px-6 py-8">{children}</div>
    </div>
  );
}

function StatusCard({ icon, tone, title, body, action, testId }: {
  icon: React.ReactNode; tone: string; title: string; body: React.ReactNode; action?: React.ReactNode; testId: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-8 shadow-sm text-center space-y-4" data-testid={testId}>
      <div className={`w-14 h-14 rounded-full flex items-center justify-center mx-auto ${tone}`}>{icon}</div>
      <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      <div className="text-sm text-muted-foreground">{body}</div>
      {action}
    </div>
  );
}

export default function FormalizacaoPage() {
  const { token } = useParams<{ token: string }>();
  const { t } = useLang();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [done, setDone] = useState<{ already: boolean } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  // Link de token não deve vazar via Referer.
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.appendChild(meta);
    return () => { meta.remove(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    setDone(null);
    setSubmitError(null);
    (async () => {
      try {
        const r = await fetch(`/api/public/formalizacao/${encodeURIComponent(token ?? "")}`);
        if (cancelled) return;
        if (r.status === 404 || r.status === 410 || r.status === 403 || r.status === 400) { setState({ kind: "invalid" }); return; }
        if (!r.ok) { setState({ kind: "error" }); return; }
        const def = await r.json();
        if (!cancelled) setState({ kind: "ready", def });
      } catch {
        if (!cancelled) setState({ kind: "error" });
      }
    })();
    return () => { cancelled = true; };
  }, [token, reloadKey]);

  const load = () => setReloadKey(k => k + 1);

  const handleSubmit = async (respostas: Record<string, string>) => {
    const submittedFor = token;
    const stale = () => tokenRef.current !== submittedFor;
    setSubmitError(null);
    let res: Response;
    try {
      res = await fetch(`/api/public/formalizacao/${encodeURIComponent(submittedFor ?? "")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ respostas }),
      });
    } catch {
      if (!stale()) setSubmitError(t("fz.public.submit_error"));
      throw new Error("network");
    }
    const body = await res.json().catch(() => ({}));
    if (stale()) throw new Error("stale");
    if (res.ok && body?.success) { setDone({ already: !!body.alreadyCompleted }); return; }
    const code = submissionErrorCode(body);
    if (code) { setSubmitError(t(`fz.err.${code}` as never)); throw new Error(code); }
    if (res.status === 404 || res.status === 410 || res.status === 403) { setState({ kind: "invalid" }); throw new Error("invalid"); }
    // Nunca exibimos a mensagem crua do servidor.
    setSubmitError(t("fz.public.submit_error"));
    throw new Error("failed");
  };

  if (state.kind === "loading") {
    return (
      <Shell>
        <div className="rounded-xl border border-border bg-card p-6 space-y-4 animate-pulse" aria-label={t("fz.public.loading")} data-testid="status-loading">
          <div className="h-3 w-32 bg-muted rounded" />
          <div className="h-6 w-2/3 bg-muted rounded" />
          <div className="h-10 w-full bg-muted rounded" />
          <div className="h-10 w-full bg-muted rounded" />
        </div>
      </Shell>
    );
  }

  if (state.kind === "invalid") {
    return (
      <Shell>
        <StatusCard testId="status-invalid" tone="bg-muted text-muted-foreground" icon={<Link2Off className="h-7 w-7" />}
          title={t("fz.public.invalid_title")} body={t("fz.public.invalid_body")} />
      </Shell>
    );
  }

  if (state.kind === "error") {
    return (
      <Shell>
        <StatusCard testId="status-error" tone="bg-amber-100 text-amber-700" icon={<AlertTriangle className="h-7 w-7" />}
          title={t("fz.public.error_title")} body={t("fz.public.error_body")}
          action={<Button variant="outline" onClick={load} data-testid="button-retry"><RotateCw className="h-4 w-4 mr-2" />{t("fz.public.retry")}</Button>} />
      </Shell>
    );
  }

  const { def } = state;
  if (done || def.status === "completed") {
    return (
      <Shell>
        <StatusCard testId="status-completed" tone="bg-emerald-100 text-emerald-700" icon={<CheckCircle2 className="h-7 w-7" />}
          title={t("fz.public.done_title")}
          body={<>
            <p>{t("fz.public.done_body")} <strong className="text-foreground">{def.evento.nome}</strong>.</p>
            {(done?.already || (!done && def.status === "completed")) && <p className="mt-2 text-xs">{t("fz.public.already")}</p>}
          </>} />
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="px-6 pt-6 pb-5 border-b border-border bg-primary/5">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-primary flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" /> {t("fz.public.label")}
          </p>
          <h1 className="text-xl font-semibold text-foreground mt-2" data-testid="text-event-name">{def.evento.nome}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("fz.public.subtitle")}</p>
          {def.expiresAt && (
            <p className="text-xs text-muted-foreground mt-3">{t("fz.public.expires")} {formatDateTimeBR(def.expiresAt)}</p>
          )}
        </div>
        <div className="p-6 space-y-4">
          {submitError && (
            <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-testid="text-submit-error">
              {submitError}
            </div>
          )}
          <DynamicForm fields={def.campos} onSubmit={handleSubmit} buttonText={t("fz.public.submit")} />
        </div>
      </div>
    </Shell>
  );
}
