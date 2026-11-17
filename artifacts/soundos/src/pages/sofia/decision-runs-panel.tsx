import { useState } from "react";
import type { DecisionRun } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ChevronDown, ChevronRight, X, ShieldCheck, Target, FileSearch, ListChecks,
  CircleCheck, CircleDashed, RefreshCw, AlertTriangle, CheckCircle2,
  MessageSquare, Bot, Database, Cpu, TerminalSquare, Link2Off, Search,
} from "lucide-react";
import { formatDateTimeBR } from "@/lib/date";

const NBA_LABELS: Record<string, string> = {
  aprender: "Aprender",
  consumir_conteudo: "Conteúdo",
  explorar: "Explorar",
  participar: "Participar",
  aprofundar: "Aprofundar",
  experimentar: "Experimentar",
  conversar: "Conversar",
  comunidade: "Comunidade",
  comprar: "Comprar",
  pausar: "Pausar",
};

const ELEGIBILIDADE_LABELS: Record<string, string> = {
  elegivel: "Elegível",
  bloqueado: "Bloqueado",
  nao_avaliada: "Não avaliada",
};

const CONFIANCA_LABELS: Record<string, string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
};

const TIPO_EVIDENCIA_LABELS: Record<string, string> = {
  declarada: "Declarada",
  comportamental: "Comport.",
  transacional: "Transac.",
  relacional: "Relac.",
  inferida: "Inferida",
  validada: "Validada",
  completude_estruturada: "Ficha",
};

const CAMPO_LABELS: Record<string, string> = {
  perfilPrincipal: "Perfil",
  intencaoPrincipal: "Intenção",
  temperatura: "Temp.",
  servicoInteresse: "Serviço",
  agua_presencial: "Água (Pres)",
  fogo_presencial: "Fogo (Pres)",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function Section({ icon: Icon, title, children, rightAction }: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
  rightAction?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5 pt-3 mt-3 border-t border-border/40 first:mt-0 first:pt-0 first:border-0">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
          <Icon className="h-3 w-3" /> {title}
        </div>
        {rightAction}
      </div>
      <div className="text-xs text-foreground/90">{children}</div>
    </div>
  );
}

function QuoteBlock({ role, content }: { role: "user" | "sofia"; content: string }) {
  if (!content) return null;
  return (
    <div className={`mt-1.5 p-2 rounded-md text-[11px] leading-relaxed border ${
      role === "user"
        ? "bg-primary/10 border-primary/20 text-foreground"
        : "bg-muted/30 border-border/50 text-foreground/80"
    }`}>
      <div className="flex items-center gap-1 mb-1 text-[9px] font-semibold uppercase tracking-wider opacity-60">
        {role === "user" ? <MessageSquare className="h-2.5 w-2.5" /> : <Bot className="h-2.5 w-2.5" />}
        {role === "user" ? "Gatilho" : "Resposta"}
      </div>
      <div className="whitespace-pre-wrap">{content}</div>
    </div>
  );
}

function compactValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (Array.isArray(value)) return value.map(compactValue).join(", ");
  if (isObject(value)) return JSON.stringify(value);
  return String(value);
}

function candidateLabels(candidates: unknown): string[] {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  return candidates.map((candidate, index) => {
    if (isObject(candidate)) {
      for (const key of ["name", "nome", "courseName", "course_name", "title", "sku", "id"]) {
        if (typeof candidate[key] === "string" && candidate[key]) return candidate[key];
      }
    }
    return `Candidato ${index + 1}`;
  });
}

function sourceLabels(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  return sources.map((source, index) => {
    if (typeof source === "string") return source;
    if (!isObject(source)) return `Fonte ${index + 1}`;
    const labels = [
      source.catalog,
      source.policy,
      source.type,
      source.inventory,
      source.tables,
    ].flatMap(value => Array.isArray(value) ? value : [value])
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    return labels.length > 0 ? labels.join(" · ") : `Fonte ${index + 1}`;
  });
}

function requestedFields(meta: Record<string, unknown>): string[] {
  if (Array.isArray(meta.requested_fields)) {
    return meta.requested_fields.filter((value): value is string => typeof value === "string");
  }
  if (!Array.isArray(meta.candidate_set)) return [];
  return [...new Set(meta.candidate_set.flatMap(candidate => {
    if (!isObject(candidate) || !Array.isArray(candidate.requestedFields)) return [];
    return candidate.requestedFields.filter((value): value is string => typeof value === "string");
  }))];
}

const ATTENTION_RESULTS = new Set([
  "ambiguous",
  "not_found",
  "lookup_error",
  "error",
  "pending_send",
  "blocked",
]);

function getAttentionReasons(run: DecisionRun): string[] {
  const meta = isObject(run.metadata) ? run.metadata : {};
  const reasons: string[] = [];
  const result = typeof meta.result === "string" ? meta.result : null;
  const handoffTriggered =
    meta.outcome === "handoff" ||
    meta.nba_code === "HANDOFF" ||
    typeof meta.handoffReason === "string" ||
    result?.includes("handoff") === true ||
    result?.includes("commercial_leakage") === true ||
    run.nbaJustificativa.toLowerCase().includes("handoff");

  if (handoffTriggered) reasons.push("Handoff acionado");
  if (run.elegibilidadeStatus === "bloqueado") reasons.push("Elegibilidade bloqueada");
  if (run.nivelConfianca === "baixa") reasons.push("Confiança baixa");
  if (!run.triggerMessage) reasons.push("Gatilho indisponível");
  if (!run.responseMessage) reasons.push("Resposta não vinculada");
  if (result && ATTENTION_RESULTS.has(result)) reasons.push(`Resultado: ${result}`);

  return [...new Set(reasons)];
}

function DecisionRunEntry({ run, attentionReasons, ordem, isHighlighted, onHover, onFocus }: {
  run: DecisionRun;
  attentionReasons: string[];
  ordem: number;
  isHighlighted: boolean;
  onHover: (messageId: number | null) => void;
  onFocus: (messageId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const evidencias = run.evidenciasConsideradas ?? [];
  const completude = evidencias.filter(ev => ev.tipoEvidencia === "completude_estruturada");
  const historico = evidencias.filter(ev => ev.tipoEvidencia !== "completude_estruturada");

  const algumModuloConcluido = completude.some(ev => ev.valor != null && ev.valor !== "");
  const elegibilidadeAvaliada = run.elegibilidadeStatus !== "nao_avaliada";
  const mostrarCompletude = completude.length > 0 && (algumModuloConcluido || elegibilidadeAvaliada);

  const meta = isObject(run.metadata) ? run.metadata : {};

  // Status checks for badges
  const isBlocked = run.elegibilidadeStatus === "bloqueado";
  const isUnlinked = !run.responseMessage;
  const isError = typeof meta.result === "string" && (
    ATTENTION_RESULTS.has(meta.result) || meta.result.includes("commercial_leakage")
  );
  const linkedMessageId = run.responseMessage?.id ?? null;
  const needsAttention = attentionReasons.length > 0;
  const sources = sourceLabels(meta.sources);
  const candidates = candidateLabels(meta.candidate_set);
  const fieldsRequested = requestedFields(meta);
  const filters = isObject(meta.filters) ? Object.entries(meta.filters) : [];

  return (
    <div
      data-testid={`decision-run-${run.id}`}
      onMouseEnter={() => onHover(run.responseMessage?.id ?? null)}
      onMouseLeave={() => onHover(null)}
      className={`rounded-lg border transition-all overflow-hidden flex flex-col ${
        isHighlighted
          ? "border-sofia ring-1 ring-sofia bg-sofia/5"
          : needsAttention
            ? "border-amber-500/30 bg-amber-500/5 dark:bg-amber-500/10"
            : "border-border/60 bg-background"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        data-testid={`run-toggle-${run.id}`}
        className="w-full flex items-stretch text-left hover:bg-muted/40 transition-colors relative"
      >
        <div className={`w-1 shrink-0 ${needsAttention ? "bg-amber-500/60" : "bg-emerald-500/40"}`} />
        <div className="flex-1 p-2.5 flex items-start gap-2 min-w-0">
          {open ? <ChevronDown className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                : <ChevronRight className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />}

          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] font-mono font-medium text-muted-foreground">#{ordem}</span>
                <span className="text-[10px] text-muted-foreground/70">{formatDateTimeBR(run.createdAt)}</span>
              </div>
              <div className="flex items-center gap-1">
                {needsAttention ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 opacity-60" />
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {typeof meta.intent === "string" ? (
                <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4 bg-muted/60 font-mono">
                  {meta.intent}
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4 bg-muted/60">
                  {NBA_LABELS[run.nbaCategoria] ?? run.nbaCategoria}
                </Badge>
              )}

              {run.conduta && (
                <Badge variant="outline" className={`text-[9px] px-1 py-0 h-4 border-dashed ${
                  run.conduta === "comercial" ? "border-sofia/60 text-sofia" : "border-blue-500/50 text-blue-600 dark:text-blue-400"
                }`}>
                  {run.conduta === "comercial" ? "Comercial" : "Triagem"}
                </Badge>
              )}

              {run.elegibilidadeStatus !== "nao_avaliada" && (
                <Badge variant="outline" className={`text-[9px] px-1 py-0 h-4 border-dashed ${
                  run.elegibilidadeStatus === "elegivel" ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400" : "border-destructive/50 text-destructive"
                }`}>
                  {ELEGIBILIDADE_LABELS[run.elegibilidadeStatus]}
                </Badge>
              )}

              <Badge variant="outline" className={`text-[9px] px-1 py-0 h-4 border-dashed ${
                run.nivelConfianca === "alta" ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400" :
                run.nivelConfianca === "media" ? "border-amber-500/50 text-amber-600 dark:text-amber-400" :
                "border-destructive/50 text-destructive"
              }`}>
                {CONFIANCA_LABELS[run.nivelConfianca]}
              </Badge>

              {isUnlinked && (
                <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 border-destructive/50 text-destructive gap-0.5" title="Resposta não vinculada">
                  <Link2Off className="h-2.5 w-2.5" /> Órfã
                </Badge>
              )}
            </div>

            {needsAttention && (
              <div
                className="flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] text-amber-700 dark:text-amber-400"
                data-testid={`attention-reasons-${run.id}`}
              >
                {attentionReasons.map(reason => (
                  <span key={reason}>• {reason}</span>
                ))}
              </div>
            )}

            {!open && (run.triggerMessage?.content || run.responseMessage?.content) && (
              <div className="text-[10px] text-muted-foreground/80 truncate mt-1 italic">
                "{run.triggerMessage?.content || run.responseMessage?.content}"
              </div>
            )}
          </div>
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-4 bg-background/50 text-xs border-t border-border/40">

          <Section
            icon={MessageSquare}
            title="Conversa"
            rightAction={linkedMessageId != null ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 text-[9px] px-1.5 font-medium -mr-1 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  onFocus(linkedMessageId);
                }}
                data-testid={`focus-chat-${run.id}`}
              >
                <Search className="h-3 w-3 mr-1" /> Destacar no chat
              </Button>
            ) : undefined}
          >
            {run.triggerMessage ? (
              <QuoteBlock role="user" content={run.triggerMessage.content} />
            ) : (
              <div
                className="mt-1.5 p-2 rounded-md text-[10px] text-muted-foreground/70 border border-dashed border-amber-500/30 bg-amber-500/5"
                data-testid={`missing-trigger-${run.id}`}
              >
                A pergunta de origem não está disponível neste registro.
              </div>
            )}
            {run.responseMessage ? (
              <QuoteBlock role="sofia" content={run.responseMessage.content} />
            ) : (
              <div className="mt-1.5 p-2 rounded-md text-[10px] text-muted-foreground/60 italic border border-dashed border-border/50">
                Sem mensagem de resposta registrada.
              </div>
            )}
          </Section>

          <div className="grid grid-cols-2 gap-3">
            <Section icon={Target} title="Decisão">
              <div className="space-y-1 mt-1">
                <div className="flex justify-between items-center bg-muted/30 p-1.5 rounded border border-border/40">
                  <span className="text-[10px] text-muted-foreground">NBA</span>
                  <span className="font-mono text-[10px]">{NBA_LABELS[run.nbaCategoria] ?? run.nbaCategoria}</span>
                </div>
                {typeof meta.nba_code === "string" && meta.nba_code !== run.nbaCategoria && (
                  <div className="flex justify-between items-center bg-muted/30 p-1.5 rounded border border-border/40">
                    <span className="text-[10px] text-muted-foreground">Código NBA</span>
                    <span className="font-mono text-[10px]">{meta.nba_code}</span>
                  </div>
                )}
                <div className="flex justify-between items-center gap-2 bg-muted/30 p-1.5 rounded border border-border/40">
                  <span className="text-[10px] text-muted-foreground">Intenção</span>
                  <span className="font-mono text-[10px] text-right break-all">
                    {typeof meta.intent === "string" ? meta.intent : "não registrada"}
                  </span>
                </div>
                <div className="flex justify-between items-center gap-2 bg-muted/30 p-1.5 rounded border border-border/40">
                  <span className="text-[10px] text-muted-foreground">Resultado</span>
                  <span className={`font-mono text-[10px] text-right break-all ${isError ? "text-destructive font-bold" : ""}`}>
                    {typeof meta.result === "string" ? meta.result : "não registrado"}
                  </span>
                </div>
                <p className="text-[10px] leading-relaxed text-muted-foreground px-0.5 pt-0.5">
                  {run.nbaJustificativa}
                </p>
              </div>
            </Section>

            <Section icon={ShieldCheck} title="Elegibilidade">
              <div className="space-y-1 mt-1">
                <div className="bg-muted/30 p-1.5 rounded border border-border/40">
                  <div className="flex justify-between items-center mb-0.5">
                    <span className="text-[10px] text-muted-foreground">Status</span>
                    <span className={`font-mono text-[10px] ${isBlocked ? "text-destructive" : ""}`}>
                      {run.elegibilidadeStatus}
                    </span>
                  </div>
                  {run.elegibilidadeMotivo && (
                    <div className="text-[9px] text-muted-foreground/80 leading-tight">
                      {run.elegibilidadeMotivo}
                    </div>
                  )}
                </div>
                {(run.ofertaPrincipal || run.ofertaAlternativa) && (
                  <div className="bg-muted/30 p-1.5 rounded border border-border/40 space-y-0.5">
                    {run.ofertaPrincipal && (
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] text-muted-foreground">Principal</span>
                        <span className="font-mono text-[10px] truncate max-w-[80px]" title={run.ofertaPrincipal}>
                          {run.ofertaPrincipal}
                        </span>
                      </div>
                    )}
                    {run.ofertaAlternativa && (
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] text-muted-foreground">Alternativa</span>
                        <span className="font-mono text-[10px] truncate max-w-[80px]" title={run.ofertaAlternativa}>
                          {run.ofertaAlternativa}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </Section>
          </div>

          <Section icon={FileSearch} title={`Evidências (${historico.length})`}>
            {historico.length === 0 ? (
              <div className="text-[10px] text-muted-foreground italic mt-1">Nenhuma evidência injetada no prompt.</div>
            ) : (
              <div className="grid grid-cols-1 gap-1 mt-1">
                {historico.map((ev, i) => (
                  <div key={i} className="flex flex-col bg-muted/20 border border-border/40 rounded p-1.5">
                    <div className="flex justify-between items-center mb-0.5">
                      <span className="text-[10px] font-medium">{CAMPO_LABELS[ev.campo] ?? ev.campo}</span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[8px] uppercase tracking-wide text-muted-foreground">
                          {TIPO_EVIDENCIA_LABELS[ev.tipoEvidencia] ?? ev.tipoEvidencia}
                        </span>
                        <span className={`w-1.5 h-1.5 rounded-full ${
                          ev.nivelConfianca === 'alta' ? 'bg-emerald-500' :
                          ev.nivelConfianca === 'media' ? 'bg-amber-500' : 'bg-destructive'
                        }`} title={`Confiança ${ev.nivelConfianca}`} />
                      </div>
                    </div>
                    <div className="text-[11px] text-foreground/80 break-words">{ev.valor ?? "—"}</div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {mostrarCompletude && (
            <Section icon={ListChecks} title="Módulos Estruturados">
              <div className="grid grid-cols-1 gap-1 mt-1">
                {completude.map((ev, i) => {
                  const concluido = ev.valor != null && ev.valor !== "";
                  return (
                    <div key={i} className="flex items-center justify-between bg-muted/20 border border-border/40 rounded p-1.5">
                      <span className="text-[10px] flex items-center gap-1.5">
                        {concluido ? <CircleCheck className="h-3 w-3 text-emerald-500" /> : <CircleDashed className="h-3 w-3 text-muted-foreground/50" />}
                        {CAMPO_LABELS[ev.campo] ?? ev.campo}
                      </span>
                      {concluido ? (
                        <span className="text-[10px] font-mono">{ev.valor}</span>
                      ) : (
                        <span className="text-[9px] text-muted-foreground/60 italic">Não</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          <Section
            icon={Cpu}
            title="Telemetria e metadados"
          >
            <div className="space-y-1.5 mt-1">
              <div className="flex flex-wrap gap-2 text-[10px] font-mono text-muted-foreground bg-muted/20 border border-border/40 rounded p-1.5">
                <div>Modelo: {run.model ?? "não registrado"}</div>
                <div>Prompt: {run.promptId ?? "não registrado"}</div>
                <div>Resposta: {run.responseMessage ? `#${run.responseMessage.id}` : "não vinculada"}</div>
                {run.messageId != null && !run.responseMessage && (
                  <div className="text-amber-700 dark:text-amber-400">
                    Referência não resolvida: #{run.messageId}
                  </div>
                )}
              </div>

              {Object.keys(meta).length > 0 && (
                <div className="space-y-1">
                  <div className="bg-muted/20 p-1.5 rounded border border-border/40 text-[10px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Fontes</span>
                      {meta.sources === undefined && (
                        <span className="italic text-muted-foreground">não registradas</span>
                      )}
                      {meta.sources !== undefined && sources.length === 0 && (
                        <span className="italic text-muted-foreground">nenhuma</span>
                      )}
                    </div>
                    {sources.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {sources.map((label, index) => (
                          <Badge key={`${label}-${index}`} variant="outline" className="text-[9px] px-1 py-0 h-auto min-h-4 border-dashed font-normal whitespace-normal text-left">
                            {label}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="bg-muted/20 p-1.5 rounded border border-border/40 text-[10px]">
                    <div className="flex justify-between items-center gap-2">
                      <span className="text-muted-foreground">Candidatos</span>
                      {meta.candidate_set === undefined && (
                        <span className="italic text-muted-foreground">não registrados</span>
                      )}
                      {meta.candidate_set !== undefined && candidates.length === 0 && (
                        <span className="italic text-muted-foreground">nenhum</span>
                      )}
                    </div>
                    {candidates.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {candidates.map((name, i) => (
                          <Badge key={`${name}-${i}`} variant="outline" className="text-[9px] px-1 py-0 h-auto min-h-4 border-dashed font-normal whitespace-normal text-left">
                            {name}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="bg-muted/20 p-1.5 rounded border border-border/40 flex justify-between items-start gap-2 text-[10px]">
                    <span className="text-muted-foreground">Filtros</span>
                    {meta.filters === undefined ? (
                      <span className="italic text-muted-foreground">não registrados</span>
                    ) : filters.length === 0 ? (
                      <span className="italic text-muted-foreground">nenhum</span>
                    ) : (
                      <span className="font-mono text-right max-w-[200px] whitespace-pre-wrap break-all">
                        {filters.map(([key, value]) => `${key}=${compactValue(value)}`).join("; ")}
                      </span>
                    )}
                  </div>

                  {fieldsRequested.length > 0 && (
                    <div className="bg-muted/20 p-1.5 rounded border border-border/40 flex justify-between items-center text-[10px]">
                      <span className="text-muted-foreground">Campos solicitados</span>
                      <span className="font-mono text-right max-w-[200px] truncate" title={fieldsRequested.join(", ")}>
                        {fieldsRequested.join(", ")}
                      </span>
                    </div>
                  )}

                  {Array.isArray(meta.omitted_fields) && meta.omitted_fields.length > 0 && (
                    <div className="bg-muted/20 p-1.5 rounded border border-border/40 flex justify-between items-center text-[10px]">
                      <span className="text-muted-foreground">Campos omitidos</span>
                      <span className="font-mono text-right max-w-[200px] truncate" title={meta.omitted_fields.map(compactValue).join(", ")}>
                        {meta.omitted_fields.map(compactValue).join(", ")}
                      </span>
                    </div>
                  )}

                  <details className="group border border-border/40 rounded bg-black/5 dark:bg-black/20 [&_summary::-webkit-details-marker]:hidden">
                    <summary
                      className="flex items-center gap-1.5 p-1.5 text-[10px] font-mono cursor-pointer hover:bg-muted/50 transition-colors"
                      data-testid={`raw-metadata-${run.id}`}
                    >
                      <TerminalSquare className="h-3 w-3" /> Metadados brutos
                      <span className="ml-auto text-[9px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">Expandir</span>
                    </summary>
                    <div className="p-2 pt-0 overflow-x-auto">
                      <pre className="text-[9px] font-mono text-muted-foreground leading-tight">
                        {JSON.stringify(meta, null, 2)}
                      </pre>
                    </div>
                  </details>
                </div>
              )}
              {Object.keys(meta).length === 0 && (
                <p className="text-[10px] text-muted-foreground italic">
                  Este registro não possui metadados adicionais.
                </p>
              )}
            </div>
          </Section>

        </div>
      )}
    </div>
  );
}

export default function DecisionRunsPanel({
  runs, isLoading, isFetching, isError, onRefresh, hoveredMessageId, onHoverMessage, onFocusMessage, onClose,
}: {
  runs: DecisionRun[] | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  onRefresh: () => void;
  hoveredMessageId: number | null;
  onHoverMessage: (messageId: number | null) => void;
  onFocusMessage: (messageId: number) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<"all" | "attention">("all");

  const runStates = (runs || []).map((run, index) => {
    const attentionReasons = getAttentionReasons(run);
    return { run, attentionReasons, needsAttention: attentionReasons.length > 0, ordem: index + 1 };
  });

  const totalRuns = runStates.length;
  const attentionCount = runStates.filter(r => r.needsAttention).length;

  const filteredRuns = filter === "attention"
    ? runStates.filter(r => r.needsAttention)
    : runStates;

  return (
    <Card
      className="shadow-sm border-border/50 flex flex-col overflow-hidden shrink-0 w-full max-h-[45vh] lg:w-[400px] lg:max-h-none"
      data-testid="panel-motor-cognitivo"
    >
      <CardHeader className="border-b border-border/50 bg-muted/20 py-2.5 px-3 shrink-0 flex flex-col gap-2">
        <div className="flex flex-row items-center justify-between">
          <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground flex items-center gap-1.5">
            <Database className="h-4 w-4 text-sofia" /> Diagnóstico do Motor
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={onRefresh}
              disabled={isLoading || isFetching}
              className="h-6 w-6"
              title="Atualizar diagnóstico"
              data-testid="button-refresh-diags"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-6 w-6"
              aria-label="Fechar log"
              data-testid="button-fechar-motor-cognitivo"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {totalRuns > 0 && (
          <div className="flex items-center justify-between text-[10px]">
            <div className="flex bg-muted/50 rounded-md p-0.5 border border-border/40">
              <button
                type="button"
                onClick={() => setFilter("all")}
                data-testid="filter-all"
                className={`px-2 py-1 rounded-sm transition-colors ${filter === "all" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                Todas <span data-testid="summary-total" className="opacity-60 ml-0.5">({totalRuns})</span>
              </button>
              <button
                type="button"
                onClick={() => setFilter("attention")}
                data-testid="filter-attention"
                className={`px-2 py-1 rounded-sm transition-colors flex items-center gap-1 ${filter === "attention" ? "bg-background shadow-sm text-amber-600 dark:text-amber-500" : "text-muted-foreground hover:text-foreground"}`}
              >
                {attentionCount > 0 && <AlertTriangle className="h-2.5 w-2.5" />}
                Atenção <span data-testid="summary-attention" className="opacity-60">({attentionCount})</span>
              </button>
            </div>
          </div>
        )}
      </CardHeader>

      <CardContent className="p-2.5 flex-1 overflow-y-auto bg-background/50">
        {isLoading && !runs ? (
          <div className="flex flex-col items-center justify-center h-full text-xs text-muted-foreground gap-3">
            <span className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-sofia rounded-full animate-bounce" />
              <span className="w-1.5 h-1.5 bg-sofia rounded-full animate-bounce [animation-delay:0.2s]" />
              <span className="w-1.5 h-1.5 bg-sofia rounded-full animate-bounce [animation-delay:0.4s]" />
            </span>
            <span>Analisando...</span>
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-2 px-3 text-destructive">
            <AlertTriangle className="h-6 w-6 opacity-80" />
            <p className="text-xs">Não foi possível carregar as métricas.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              className="h-7 text-[10px] mt-1"
              data-testid="button-retry-diags"
            >
              Tentar Novamente
            </Button>
          </div>
        ) : totalRuns === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-2 px-4">
            <TerminalSquare className="h-8 w-8 text-muted-foreground/20" />
            <p className="text-xs text-muted-foreground">
              Aguardando eventos cognitivos...
            </p>
          </div>
        ) : filteredRuns.length === 0 && filter === "attention" ? (
          <div className="flex flex-col items-center justify-center h-full text-center gap-2 px-4 py-8">
            <CheckCircle2 className="h-8 w-8 text-emerald-500/60" />
            <p className="text-xs text-muted-foreground">
              Nenhuma decisão recente precisou de atenção especial.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {[...filteredRuns]
              .reverse()
              .map(({ run, attentionReasons, ordem }) => (
                <DecisionRunEntry
                  key={run.id}
                  run={run}
                  attentionReasons={attentionReasons}
                  ordem={ordem}
                  isHighlighted={hoveredMessageId != null && run.responseMessage?.id === hoveredMessageId}
                  onHover={onHoverMessage}
                  onFocus={onFocusMessage}
                />
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
