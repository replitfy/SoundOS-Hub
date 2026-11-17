import type { ReactNode } from "react";
import { History } from "lucide-react";
import type { CommercialOpportunityEvent } from "@workspace/api-client-react";
import { useLang, type TranslationKey } from "@/contexts/language";
import { formatDateTimeBR } from "@/lib/date";
import { extractFormSubmission, extractSofiaConversation, formatAnswer } from "@/lib/formalizacao";
import { SofiaConversationBlock } from "./sofia-conversation-block";

interface Props {
  events: CommercialOpportunityEvent[];
  pessoaId: number;
  canOpenConversation: boolean;
}

type Metadata = Record<string, unknown>;

const texto = (valor: unknown): string | null => (typeof valor === "string" && valor.trim() !== "" ? valor : null);

/** Ação do atendimento gravada em `metadata.action` dos eventos genéricos UPDATED. */
export function acaoDoEvento(evento: Pick<CommercialOpportunityEvent, "eventType" | "metadata">): string | null {
  if (evento.eventType !== "UPDATED") return null;
  return texto((evento.metadata as Metadata | undefined)?.action);
}

/** Quem agiu: o nome da pessoa da equipe (também nos registros antigos), a Sofia ou o sistema. */
export function nomeDoAtor(evento: Pick<CommercialOpportunityEvent, "actorKind" | "actorId" | "actorName">, t: (k: TranslationKey) => string): string {
  if (evento.actorKind === "SOFIA") return t("crm.ator.sofia");
  if (evento.actorKind === "SYSTEM") return t("crm.ator.sistema");
  return evento.actorName ?? t("crm.ator.desconhecido");
}

function Linha({ rotulo, children }: { rotulo?: string; children: ReactNode }) {
  return (
    <div className="mt-2 border-l-2 border-muted pl-2 text-xs text-muted-foreground break-words whitespace-pre-wrap">
      {rotulo ? <span className="font-medium">{rotulo}: </span> : null}{children}
    </div>
  );
}

/** Detalhe de uma ação do atendimento. O texto de itens apagados continua legível aqui. */
function DetalheDaAcao({ acao, metadata }: { acao: string; metadata: Metadata }) {
  const { t } = useLang();
  const data = (valor: unknown) => (typeof valor === "string" ? formatDateTimeBR(valor) : null);
  const vazio = t("crm.historico.vazio_valor");

  switch (acao) {
    case "INFORMATION_UPDATED":
      return (
        <>
          <Linha rotulo={t("crm.historico.depois")}>{texto(metadata.current) ?? vazio}</Linha>
          <Linha rotulo={t("crm.historico.antes")}>{texto(metadata.previous) ?? vazio}</Linha>
        </>
      );
    case "NOTE_ADDED":
      return <Linha>{texto(metadata.text)}</Linha>;
    case "TASK_CREATED":
    case "TASK_DONE":
    case "TASK_REOPENED":
    case "TASK_DELETED":
      return (
        <Linha>
          {texto(metadata.text)}
          {data(metadata.dueAt) ? ` · ${t("crm.tarefas.prazo")}: ${data(metadata.dueAt)}` : ""}
        </Linha>
      );
    case "TASK_EDITED":
      return (
        <>
          <Linha rotulo={t("crm.historico.depois")}>
            {texto(metadata.text)}{data(metadata.dueAt) ? ` · ${t("crm.tarefas.prazo")}: ${data(metadata.dueAt)}` : ""}
          </Linha>
          <Linha rotulo={t("crm.historico.antes")}>
            {texto(metadata.previousText)}{data(metadata.previousDueAt) ? ` · ${t("crm.tarefas.prazo")}: ${data(metadata.previousDueAt)}` : ""}
          </Linha>
        </>
      );
    case "APPOINTMENT_CREATED":
    case "APPOINTMENT_DELETED":
      return (
        <Linha>
          {texto(metadata.title)} · {data(metadata.startsAt)}
          {texto(metadata.link) ? ` · ${texto(metadata.link)}` : ""}
        </Linha>
      );
    case "APPOINTMENT_EDITED":
      return (
        <>
          <Linha rotulo={t("crm.historico.depois")}>
            {texto(metadata.title)} · {data(metadata.startsAt)}{texto(metadata.link) ? ` · ${texto(metadata.link)}` : ""}
          </Linha>
          <Linha rotulo={t("crm.historico.antes")}>
            {texto(metadata.previousTitle)} · {data(metadata.previousStartsAt)}{texto(metadata.previousLink) ? ` · ${texto(metadata.previousLink)}` : ""}
          </Linha>
        </>
      );
    case "MESSAGE_SENT":
      return <Linha>{texto(metadata.excerpt)}</Linha>;
    case "ATTACHMENT_SENT": {
      // Só o tipo e o nome do arquivo (e a legenda, se houver): o conteúdo do arquivo não entra no histórico.
      const tipo = texto(metadata.tipo);
      const nome = texto(metadata.nome);
      const legenda = texto(metadata.excerpt);
      return (
        <Linha rotulo={t("crm.historico.arquivo")}>
          {[tipo ? t(`anexo.tipo.${tipo}` as TranslationKey) : null, nome].filter(Boolean).join(" · ")}
          {legenda ? ` — ${legenda}` : ""}
        </Linha>
      );
    }
    case "TEMPLATE_SENT": {
      // O estado de entrega muda depois do envio: o servidor o lê agora e o junta ao evento.
      const entrega = (metadata.delivery ?? null) as { status?: unknown; error?: unknown } | null;
      const estado = texto(entrega?.status);
      const erro = texto(entrega?.error);
      return (
        <>
          <Linha>{texto(metadata.text)}</Linha>
          {estado && (
            <Linha rotulo={t("crm.historico.entrega")}>
              {t(`crm.chat.entrega.${estado}` as TranslationKey)}{erro ? ` · ${erro}` : ""}
            </Linha>
          )}
        </>
      );
    }
    case "AUTO_OPENING_NOT_SENT": {
      const motivo = texto(metadata.reason);
      if (!motivo) return null;
      const chave = `crm.primeiro_contato.motivo.${motivo}` as TranslationKey;
      const chaveBloqueio = `crm.abertura.bloqueio.${motivo}` as TranslationKey;
      const rotulo = t(chave) !== chave ? t(chave) : t(chaveBloqueio) !== chaveBloqueio ? t(chaveBloqueio) : motivo;
      return (
        <Linha rotulo={t("crm.primeiro_contato.motivo")}>
          {rotulo}{texto(metadata.detail) ? ` · ${texto(metadata.detail)}` : ""}
        </Linha>
      );
    }
    case "SOFIA_ENTENDIMENTO": {
      // Só o que mudou neste registro; o retrato completo aparece no bloco "O que a Sofia entendeu".
      const mudancas = (metadata.mudancas ?? {}) as Metadata;
      const lista = (valor: unknown) => (Array.isArray(valor) ? valor.filter((v): v is string => typeof v === "string") : []);
      const necessidades = lista(mudancas.necessidades);
      const informacoes = lista(mudancas.informacoes);
      const removidos = lista(mudancas.removidos);
      return (
        <>
          {texto(mudancas.intencao) && <Linha rotulo={t("crm.entendimento.intencao")}>{texto(mudancas.intencao)}</Linha>}
          {necessidades.length > 0 && <Linha rotulo={t("crm.entendimento.necessidades")}>{necessidades.join(" · ")}</Linha>}
          {informacoes.length > 0 && <Linha rotulo={t("crm.entendimento.informacoes")}>{informacoes.join(" · ")}</Linha>}
          {removidos.length > 0 && <Linha rotulo={t("crm.entendimento.removidos")}>{removidos.join(" · ")}</Linha>}
        </>
      );
    }
    case "CONTACT_AUTHORIZED":
    case "CONTACT_OPT_OUT":
    case "CONTACT_OPT_OUT_UNDONE": {
      const origem = texto(metadata.origem);
      if (!origem) return null;
      const chave = `crm.contato.origem.${origem}` as TranslationKey;
      return <Linha rotulo={t("crm.contato.origem")}>{t(chave)}{texto(metadata.origemTexto) ? ` · ${texto(metadata.origemTexto)}` : ""}</Linha>;
    }
    default:
      return null;
  }
}

export function CardHistorico({ events, pessoaId, canOpenConversation }: Props) {
  const { t } = useLang();

  if (events.length === 0) {
    return <div className="text-sm text-muted-foreground italic">{t("crm.history.empty")}</div>;
  }

  return (
    <div className="space-y-4" data-testid="crm-historico">
      {events.map(evt => {
        const metadata = (evt.metadata ?? {}) as Metadata;
        const acao = acaoDoEvento(evt);
        const submissao = extractFormSubmission(evt.metadata);
        const conversa = extractSofiaConversation(evt.metadata);
        const titulo = acao
          ? t(`crm.acao.${acao}` as TranslationKey)
          : evt.eventType === "OWNER_CHANGED" && metadata.claimed
            ? t("crm.event.OWNER_CLAIMED")
            : t(`crm.event.${evt.eventType}` as TranslationKey);

        return (
          <div key={evt.id} className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-background border-2 border-primary shrink-0 flex items-center justify-center">
              <History className="h-3 w-3 text-primary" />
            </div>
            <div className="min-w-0 flex-1 bg-muted/50 rounded-lg p-3 text-sm">
              <div className="flex justify-between items-start gap-2 mb-1">
                <div className="font-medium text-foreground">{titulo}</div>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted-foreground/10 text-muted-foreground shrink-0" data-testid={`crm-evento-ator-${evt.id}`}>
                  {nomeDoAtor(evt, t)}
                </span>
              </div>

              {(evt.fromStage || evt.toStage) && (
                <div className="text-[10px] flex items-center gap-1.5 mt-1 text-muted-foreground">
                  {evt.fromStage ? <span className="px-1 bg-muted rounded">{t(`crm.stage.${evt.fromStage}` as TranslationKey)}</span> : null}
                  {evt.fromStage && evt.toStage ? <span>→</span> : null}
                  {evt.toStage ? <span className="px-1 bg-primary/10 text-primary rounded">{t(`crm.stage.${evt.toStage}` as TranslationKey)}</span> : null}
                </div>
              )}

              {evt.reason && <div className="text-muted-foreground mt-2 text-xs border-l-2 border-muted pl-2">{evt.reason}</div>}

              {acao && <DetalheDaAcao acao={acao} metadata={metadata} />}

              {submissao && (
                <div className="mt-2 rounded-md border border-primary/20 bg-background/70 p-2.5" data-testid={`form-submission-${evt.id}`}>
                  <div className="flex items-baseline justify-between gap-2 mb-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">{t("crm.form_submission.title")}</span>
                    <span className="text-[9px] font-mono text-muted-foreground">{t("crm.form_submission.submission")} #{String(submissao.submissionId)}</span>
                  </div>
                  <p className="text-xs font-medium mb-1.5">{submissao.eventName}</p>
                  {(submissao.grupo || submissao.paginaOrigem) && (
                    <dl className="mb-1.5 grid grid-cols-[minmax(0,40%)_1fr] gap-x-2 gap-y-1 text-[11px]" data-testid={`form-submission-origin-${evt.id}`}>
                      {submissao.grupo && (
                        <div className="contents">
                          <dt className="text-muted-foreground">{t("crm.form_submission.group")}</dt>
                          <dd className="break-words">{submissao.grupo}</dd>
                        </div>
                      )}
                      {submissao.paginaOrigem && (
                        <div className="contents">
                          <dt className="text-muted-foreground">{t("crm.form_submission.origin")}</dt>
                          <dd className="break-all">{submissao.paginaOrigem}</dd>
                        </div>
                      )}
                    </dl>
                  )}
                  <dl className="grid grid-cols-[minmax(0,40%)_1fr] gap-x-2 gap-y-1 text-[11px]">
                    {Object.entries(submissao.answers).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-muted-foreground truncate" title={k}>{k}</dt>
                        <dd className="break-words">{formatAnswer(v)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              {conversa && <SofiaConversationBlock conversation={conversa} eventId={evt.id} pessoaId={pessoaId} canOpenConversation={canOpenConversation} />}

              {!acao && !submissao && !conversa && Object.keys(metadata).length > 0 && (
                <div className="mt-2 p-1.5 bg-background/50 rounded text-[9px] font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(metadata, null, 2)}
                </div>
              )}

              <div className="flex justify-between items-center text-[10px] text-muted-foreground mt-3 pt-2 border-t border-border/50">
                <span>{formatDateTimeBR(evt.createdAt)}</span>
                {evt.source && <span className="uppercase">{evt.source}</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
