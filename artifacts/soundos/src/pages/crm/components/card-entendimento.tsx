import { Sparkles } from "lucide-react";
import type { CommercialOpportunityEvent } from "@workspace/api-client-react";
import { useLang } from "@/contexts/language";
import { formatDateTimeBR } from "@/lib/date";

export const ACAO_ENTENDIMENTO = "SOFIA_ENTENDIMENTO";

export interface Entendimento {
  intencao: string | null;
  necessidades: string[];
  informacoes: string[];
  atualizadoEm: string;
}

const textos = (valor: unknown): string[] =>
  Array.isArray(valor) ? valor.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];

/**
 * O que a Sofia entendeu da conversa: o retrato mais recente gravado no histórico do cartão. Cada registro
 * leva o retrato completo, então basta o último. Sem registro (ou retrato vazio), não há o que mostrar.
 */
export function entendimentoMaisRecente(events: Pick<CommercialOpportunityEvent, "id" | "eventType" | "metadata" | "createdAt">[]): Entendimento | null {
  let ultimo: (typeof events)[number] | null = null;
  for (const evento of events) {
    const metadata = (evento.metadata ?? {}) as Record<string, unknown>;
    if (evento.eventType !== "UPDATED" || metadata.action !== ACAO_ENTENDIMENTO) continue;
    if (!ultimo || evento.id > ultimo.id) ultimo = evento;
  }
  if (!ultimo) return null;
  const retrato = ((ultimo.metadata ?? {}) as { sofiaEntendimento?: Record<string, unknown> }).sofiaEntendimento;
  const intencao = typeof retrato?.intencao === "string" && retrato.intencao.trim() !== "" ? retrato.intencao : null;
  const necessidades = textos(retrato?.necessidades);
  const informacoes = textos(retrato?.informacoes);
  if (!intencao && necessidades.length === 0 && informacoes.length === 0) return null;
  return { intencao, necessidades, informacoes, atualizadoEm: String(ultimo.createdAt) };
}

function Lista({ rotulo, itens, testid }: { rotulo: string; itens: string[]; testid: string }) {
  if (itens.length === 0) return null;
  return (
    <div data-testid={testid}>
      <span className="block text-[10px] text-muted-foreground mb-0.5">{rotulo}</span>
      <ul className="list-disc space-y-0.5 pl-4 text-sm">
        {itens.map(item => <li key={item} className="break-words">{item}</li>)}
      </ul>
    </div>
  );
}

export function CardEntendimento({ events }: { events: CommercialOpportunityEvent[] }) {
  const { t } = useLang();
  const entendimento = entendimentoMaisRecente(events);
  if (!entendimento) return null;
  return (
    <section className="space-y-3 rounded-lg border border-blue-500/20 bg-blue-500/5 p-4" data-testid="crm-entendimento">
      <h4 className="flex items-center text-xs font-bold uppercase tracking-wider text-blue-600/80">
        <Sparkles className="mr-1.5 h-3.5 w-3.5" />{t("crm.entendimento.titulo")}
      </h4>
      {entendimento.intencao && (
        <div data-testid="crm-entendimento-intencao">
          <span className="block text-[10px] text-muted-foreground mb-0.5">{t("crm.entendimento.intencao")}</span>
          <p className="text-sm font-medium break-words">{entendimento.intencao}</p>
        </div>
      )}
      <Lista rotulo={t("crm.entendimento.necessidades")} itens={entendimento.necessidades} testid="crm-entendimento-necessidades" />
      <Lista rotulo={t("crm.entendimento.informacoes")} itens={entendimento.informacoes} testid="crm-entendimento-informacoes" />
      <p className="text-[10px] text-muted-foreground">
        {t("crm.entendimento.aviso")} {t("crm.entendimento.atualizado_em")} {formatDateTimeBR(entendimento.atualizadoEm)}.
      </p>
    </section>
  );
}
