import { useListCommercialOpportunities, OpportunityStage, CommercialOpportunity, type ListCommercialOpportunitiesParams } from "@workspace/api-client-react";
import { CrmColumn } from "./crm-column";
import { useState, useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useClaimOpportunity } from "../use-claim-opportunity";

const COLLAPSED_STAGES_STORAGE_KEY = "soundos.crm.collapsed-stages";

export const STAGES: OpportunityStage[] = [
  "NEW_INTEREST",
  "CONTACT_STARTED",
  "QUALIFYING",
  "PATH_IDENTIFIED",
  "DECIDING",
  "ENROLLMENT_RESERVATION_IN_PROGRESS",
  "CONFIRMED",
  "NURTURE",
  "CLOSED",
];

interface CrmBoardProps {
  filters: ListCommercialOpportunitiesParams;
  onOpenCard: (id: number) => void;
  /** Soltar um cartão em outra etapa (quem trata o pedido é a tela, que também cuida do encerramento no cartão aberto). */
  onMoveToStage: (id: number, stage: OpportunityStage) => void;
}

export function CrmBoard({ filters, onOpenCard, onMoveToStage }: CrmBoardProps) {
  const { data: opportunities, isLoading, isError } = useListCommercialOpportunities(filters);
  const { claim, claimingId } = useClaimOpportunity();

  const [collapsedStages, setCollapsedStages] = useState<Set<OpportunityStage>>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(COLLAPSED_STAGES_STORAGE_KEY) ?? "[]");
      return new Set(Array.isArray(stored) ? stored.filter((stage) => STAGES.includes(stage)) : []);
    } catch {
      return new Set();
    }
  });

  const columns = useMemo(() => {
    const cols: Record<OpportunityStage, CommercialOpportunity[]> = {} as any;
    STAGES.forEach(s => cols[s] = []);

    if (opportunities) {
      opportunities.forEach(opp => {
        if (cols[opp.stage]) {
          cols[opp.stage].push(opp);
        } else {
          cols[opp.stage] = [opp];
        }
      });
    }
    return cols;
  }, [opportunities]);

  const toggleStage = (stage: OpportunityStage) => {
    setCollapsedStages((current) => {
      const next = new Set(current);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      localStorage.setItem(COLLAPSED_STAGES_STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const activeStages = filters.includeClosed ? STAGES : STAGES.filter(s => s !== "CLOSED");

  if (isLoading) {
    return (
      <div
        className="grid h-full gap-1.5 overflow-hidden"
        style={{ gridTemplateColumns: `repeat(${activeStages.length}, minmax(0, 1fr))` }}
      >
        {activeStages.map(s => (
          <div key={s} className="min-w-0 space-y-1.5">
            <Skeleton className="h-8 w-full rounded-md" />
            <Skeleton className="h-24 w-full rounded-md" />
            <Skeleton className="h-24 w-full rounded-md" />
          </div>
        ))}
      </div>
    );
  }

  if (isError) {
    return <div className="p-8 text-destructive text-center">Erro ao carregar oportunidades.</div>;
  }

  return (
    <>
      <div
        className="grid h-full min-w-0 gap-1.5 pb-2 overflow-hidden items-start"
        style={{
          gridTemplateColumns: activeStages
            .map(stage => collapsedStages.has(stage) ? "40px" : "minmax(0, 1fr)")
            .join(" "),
        }}
      >
        {activeStages.map(stage => (
          <CrmColumn 
            key={stage} 
            stage={stage} 
            items={columns[stage] || []} 
            onDrop={onMoveToStage}
            onClickCard={onOpenCard}
            onClaim={claim}
            claimingId={claimingId}
            isCollapsed={collapsedStages.has(stage)}
            onToggleCollapsed={() => toggleStage(stage)}
          />
        ))}
      </div>
    </>
  );
}