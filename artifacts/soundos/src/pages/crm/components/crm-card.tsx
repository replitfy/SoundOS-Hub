import { isSofiaOwned } from "@/lib/formalizacao";
import { CommercialOpportunity, OpportunityStage } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { differenceInDays } from "date-fns";
import { useLang } from "@/contexts/language";
import { formatDateTimeBR } from "@/lib/date";
import { AlertCircle, Clock, Phone, MessageSquare, Mail, Users, Building, Activity, User, Briefcase, BrainCircuit } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { STAGES } from "./crm-board";
import { prazoDoCartao } from "../prazo-primeiro-contato";

interface CrmCardProps {
  item: CommercialOpportunity;
  onClick: (id: number) => void;
  onMoveToStage: (id: number, stage: OpportunityStage) => void;
  onClaim: (id: number) => void;
  isClaiming: boolean;
}

const TASK_ICONS: Record<string, any> = {
  CALL: Phone,
  WHATSAPP: MessageSquare,
  EMAIL: Mail,
  MEETING: Users,
  INTERNAL: Building,
  NONE: Activity
};

export function CrmCard({ item, onClick, onMoveToStage, onClaim, isClaiming }: CrmCardProps) {
  const { t } = useLang();
  
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("application/json", JSON.stringify({
      id: item.id,
      version: item.version
    }));
    e.dataTransfer.effectAllowed = "move";
  };

  const daysInStage = differenceInDays(new Date(), new Date(item.stageEnteredAt));
  const prazo = prazoDoCartao(item);
  const isOverdue = prazo?.atrasado ?? false;
  
  return (
    <div 
      draggable
      onDragStart={handleDragStart}
      className="relative group block w-full outline-none"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => onClick(item.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick(item.id);
          }
        }}
        aria-label={`${item.person?.name || `${t("crm.form.person" as any)} #${item.pessoaId}`} - ${t(`crm.stage.${item.stage}` as any)}`}
        className="p-1.5 w-full min-w-0 text-left cursor-pointer hover:border-primary/50 transition-colors shadow-sm bg-card rounded-md border text-card-foreground select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex flex-col gap-0.5 mb-1 pr-5">
          <span className="font-semibold text-[11px] truncate leading-tight">
            {item.person?.name || `${t("crm.form.person" as any)} #${item.pessoaId}`}
          </span>
          {item.offerLabel && (
            <span className="text-[9px] text-muted-foreground truncate leading-none">
              {item.offerLabel}
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-0.5 mb-1">
          <span className={`text-[8px] px-1 py-0.5 rounded uppercase tracking-wide ${
            item.nucleus === 'EDUCATION' ? 'bg-blue-500/10 text-blue-600' : 'bg-orange-500/10 text-orange-600'
          }`}>
            {t(`crm.nucleus.${item.nucleus}` as any)}
          </span>
          
          {item.owner ? (
            <div className="flex min-w-0 items-center text-[8px] px-1 py-0.5 rounded bg-muted/50 text-muted-foreground" title={item.owner.name}>
              <User className="h-2.5 w-2.5 mr-1" />
              <span className="truncate">{item.owner.name.split(' ')[0]}</span>
            </div>
          ) : (
            <>
              {isSofiaOwned(item) ? (
                <div className="flex min-w-0 items-center text-[8px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-700" title={t("crm.owner.sofia" as any)} data-testid={`crm-card-sofia-${item.id}`}>
                  <BrainCircuit className="h-2.5 w-2.5 mr-1" />
                  <span className="truncate">{t("crm.owner.sofia" as any)}</span>
                </div>
              ) : (
              <div
                className="flex min-w-0 items-center text-[8px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-700"
                title={t("crm.form.owner_none" as any)}
                data-testid={`crm-card-unassigned-${item.id}`}
              >
                <User className="h-2.5 w-2.5 mr-1" />
                <span className="truncate">{t("crm.form.owner_none" as any)}</span>
              </div>
              )}
              {item.stage !== "CLOSED" && (
                <button
                  type="button"
                  disabled={isClaiming}
                  // O cartão inteiro abre o painel (clique e Enter/Espaço); assumir não deve abri-lo.
                  onClick={(e) => { e.stopPropagation(); onClaim(item.id); }}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="flex shrink-0 items-center text-[8px] font-semibold px-1.5 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid={`crm-card-claim-${item.id}`}
                >
                  {t("crm.action.claim" as any)}
                </button>
              )}
            </>
          )}

          {(item.offerInterestStatus !== "UNKNOWN" || item.eligibilityStatus !== "UNKNOWN") && (
            <div className="flex min-w-0 gap-0.5 w-full mt-0.5 overflow-hidden">
              {item.offerInterestStatus !== "UNKNOWN" && (
                <span className={`truncate text-[8px] px-1 rounded ${item.offerInterestStatus === "INTERESTED" ? "bg-green-500/10 text-green-600" : "bg-muted text-muted-foreground"}`}>
                  {t(`crm.interest.${item.offerInterestStatus}` as any)}
                </span>
              )}
              {item.eligibilityStatus !== "UNKNOWN" && item.eligibilityStatus !== "HUMAN_REVIEW" && (
                <span className={`truncate text-[8px] px-1 rounded ${item.eligibilityStatus === "ELIGIBLE" ? "bg-green-500/10 text-green-600" : "bg-muted text-muted-foreground"}`}>
                  {t(`crm.eligibility.${item.eligibilityStatus}` as any)}
                </span>
              )}
              {item.eligibilityStatus === "HUMAN_REVIEW" && (
                <span className="truncate text-[8px] px-1 rounded bg-amber-500/10 text-amber-600">
                  {t("crm.eligibility.HUMAN_REVIEW")}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1 mt-1 pt-1 border-t border-border/40">
          {item.nextTaskType && item.nextTaskType !== "NONE" ? (
            <div className={`flex flex-col gap-0.5 ${isOverdue ? "text-destructive" : "text-foreground"}`}>
              <div className="flex min-w-0 items-center text-[9px] font-medium">
                {(() => {
                  const Icon = TASK_ICONS[item.nextTaskType];
                  return <Icon className={`h-3 w-3 mr-1 ${isOverdue ? "text-destructive" : "text-muted-foreground"}`} />;
                })()}
                <span className="truncate">{t(`crm.task.${item.nextTaskType}` as any)}</span>
              </div>
              {item.nextTaskText && (
                <span className="text-[9px] line-clamp-1 leading-tight opacity-90">
                  {item.nextTaskText}
                </span>
              )}
              {prazo && (
                <div
                  className={`flex items-center truncate text-[8px] ${isOverdue ? "font-semibold text-destructive" : "text-muted-foreground"}`}
                  data-testid={`crm-card-prazo-${item.id}`}
                >
                  <Clock className="h-2.5 w-2.5 mr-1" />
                  {isOverdue ? t("crm.overdue") + " " : prazo.emPrazoDePrimeiroContato ? t("crm.prazo") + " " : ""}
                  {formatDateTimeBR(prazo.limite)}
                </div>
              )}
            </div>
          ) : (
            <span className="truncate text-[9px] text-muted-foreground italic">{t("crm.task.no_action" as any)}</span>
          )}
          
          <div className="flex min-w-0 items-end justify-between gap-1">
            {item.lastInteractionAt ? (
              <div className="truncate text-[8px] text-muted-foreground/70">
                {t("crm.task.last_interaction" as any)} {formatDateTimeBR(item.lastInteractionAt)}
              </div>
            ) : <div />}
            <div className="shrink-0 text-[8px] text-muted-foreground tabular-nums text-right font-medium bg-muted/30 px-1 rounded">
              {daysInStage}{t("crm.dias")}
            </div>
          </div>
        </div>
      </div>

      <div className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity z-10">
        <DropdownMenu>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <button 
              className="h-6 w-6 rounded flex items-center justify-center hover:bg-muted text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("crm.move")}
            >
              <Activity className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            {STAGES.filter(s => s !== item.stage && s !== "CLOSED").map(stage => (
              <DropdownMenuItem key={stage} onClick={() => onMoveToStage(item.id, stage)}>
                {t("crm.move")} {t(`crm.stage.${stage}` as any)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
