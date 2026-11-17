import { CommercialOpportunity, OpportunityStage } from "@workspace/api-client-react";
import { useLang } from "@/contexts/language";
import { CrmCard } from "./crm-card";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface CrmColumnProps {
  stage: OpportunityStage;
  items: CommercialOpportunity[];
  onDrop: (id: number, stage: OpportunityStage) => void;
  onClickCard: (id: number) => void;
  onClaim: (id: number) => void;
  claimingId: number | null;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
}

export function CrmColumn({ stage, items, onDrop, onClickCard, onClaim, claimingId, isCollapsed, onToggleCollapsed }: CrmColumnProps) {
  const { t } = useLang();
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault(); // Necessary to allow dropping
    e.dataTransfer.dropEffect = "move";
    if (!isDragOver) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDropEvent = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const payloadStr = e.dataTransfer.getData("application/json");
    if (payloadStr) {
      try {
        const payload = JSON.parse(payloadStr);
        onDrop(payload.id, stage);
      } catch (e) {
        // Handle direct ID payload from older components if any
        onDrop(parseInt(payloadStr, 10), stage);
      }
    }
  };

  return (
    <div 
      className={`flex min-w-0 flex-col h-full bg-secondary/30 rounded-md border transition-[background-color,border-color] duration-200 ${
        isDragOver ? "border-primary bg-primary/5" : "border-border/60"
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDropEvent}
    >
      <div className={`flex min-w-0 border-border/40 bg-secondary/50 rounded-t-md ${isCollapsed ? "h-full flex-col items-center gap-2 py-2" : "items-center justify-between gap-1 px-1.5 py-1.5 border-b"}`}>
        <h3
          className={`min-w-0 text-[10px] font-bold tracking-wide text-muted-foreground uppercase flex items-center gap-1 ${
            isCollapsed ? "[writing-mode:vertical-rl]" : "truncate"
          }`}
          data-testid={`text-crm-column-${stage}`}
        >
          {t(`crm.stage.${stage}` as any)}
          <span className="shrink-0 bg-background/80 text-foreground px-1 py-0.5 rounded-full text-[9px] tabular-nums">
            {items.length}
          </span>
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={onToggleCollapsed}
          aria-label={t(isCollapsed ? "crm.column.expand" as any : "crm.column.collapse" as any)}
          title={t(isCollapsed ? "crm.column.expand" as any : "crm.column.collapse" as any)}
          data-testid={`button-toggle-crm-column-${stage}`}
        >
          {isCollapsed ? <ChevronRight /> : <ChevronLeft />}
        </Button>
      </div>

      <div className={`${isCollapsed ? "hidden" : "flex-1 overflow-y-auto p-1 space-y-1 custom-scrollbar"}`}>
        {items.map(item => (
          <CrmCard 
            key={item.id} 
            item={item} 
            onClick={() => onClickCard(item.id)} 
            onMoveToStage={(id, s) => onDrop(id, s)}
            onClaim={onClaim}
            isClaiming={claimingId === item.id}
          />
        ))}
      </div>
    </div>
  );
}