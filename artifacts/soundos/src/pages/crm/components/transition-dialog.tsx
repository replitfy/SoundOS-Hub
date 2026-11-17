import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState, useEffect } from "react";
import { useLang } from "@/contexts/language";
import { 
  OpportunityStage, 
  OpportunityTransitionInputConfirmation,
  useListCommercialOpportunityConfirmationOptions,
  getListCommercialOpportunityConfirmationOptionsQueryKey
} from "@workspace/api-client-react";

interface TransitionResult {
  reason: string;
  confirmation?: OpportunityTransitionInputConfirmation;
}

interface TransitionDialogProps {
  open: boolean;
  opportunityId?: number;
  toStage?: OpportunityStage;
  actionType?: "pause" | "close" | "transition";
  onCancel: () => void;
  onConfirm: (result: TransitionResult) => void;
  isPending: boolean;
  error?: string | null;
}

export function TransitionDialog({ open, opportunityId, toStage, actionType = "transition", onCancel, onConfirm, isPending, error }: TransitionDialogProps) {
  const { t } = useLang();
  const [reason, setReason] = useState("");
  
  const { data: confOptionsData, isLoading: isLoadingOptions, isError: isErrorOptions } = useListCommercialOpportunityConfirmationOptions(opportunityId!, {
    query: { 
      enabled: open && toStage === "CONFIRMED" && !!opportunityId,
      queryKey: getListCommercialOpportunityConfirmationOptionsQueryKey(opportunityId!)
    }
  });
  
  const options = confOptionsData?.options || [];
  const [selectedConfId, setSelectedConfId] = useState<string>("");

  useEffect(() => {
    if (open) {
      setReason("");
      setSelectedConfId("");
    }
  }, [open]);

  useEffect(() => {
    if (options.length === 1 && !selectedConfId) {
      setSelectedConfId(options[0].id?.toString() || options[0].kind);
    }
  }, [options, selectedConfId]);

  const isConfirmedStage = toStage === "CONFIRMED";
  const title = actionType === "pause" ? t("crm.action.pause") : actionType === "close" ? t("crm.action.close") : `${t("crm.move")} ${toStage ? t(`crm.stage.${toStage}` as any) : ""}`;
  const optionLabel = (option: (typeof options)[number]) => {
    if (option.kind === "HUMAN_ADMIN") return t("crm.conf.option_human" as any);
    const prefix = option.kind === "ENROLLMENT"
      ? t("crm.conf.option_enrollment" as any)
      : t("crm.conf.option_experience" as any);
    return option.id === undefined ? prefix : `${prefix} #${option.id}`;
  };

  const isValid = () => {
    if (isConfirmedStage) {
      if (isLoadingOptions || isErrorOptions) return false;
      if (options.length === 0) return false; // Cannot proceed without options
      if (!selectedConfId) return false;
      
      const opt = options.find(o => (o.id?.toString() === selectedConfId) || (o.kind === selectedConfId));
      if (opt?.kind === "HUMAN_ADMIN") return reason.trim().length > 0;
      return true;
    }
    return reason.trim().length > 0;
  };

  const handleConfirm = () => {
    if (isConfirmedStage) {
      let confirmation: OpportunityTransitionInputConfirmation | undefined;
      const opt = options.find(o => (o.id?.toString() === selectedConfId) || (o.kind === selectedConfId));
      
      if (opt) {
        if (opt.kind === "ENROLLMENT" && opt.id !== undefined) {
          confirmation = { kind: "ENROLLMENT", enrollmentId: opt.id };
        } else if (opt.kind === "EXPERIENCE_REGISTRATION" && opt.id !== undefined) {
          confirmation = { kind: "EXPERIENCE_REGISTRATION", registrationId: opt.id };
        } else if (opt.kind === "HUMAN_ADMIN") {
          confirmation = { kind: "HUMAN_ADMIN" };
        }
      }

      onConfirm({ reason, confirmation });
    } else {
      onConfirm({ reason });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(val) => !val && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4 py-2">
          {error && (
            <div className="p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md">
              {error}
            </div>
          )}

          {isConfirmedStage ? (
            <>
              <p className="text-sm text-muted-foreground">
                {t("crm.conf.title")}
              </p>
              
              <div className="space-y-3">
                {isLoadingOptions ? (
                  <div className="p-3 bg-muted/50 border rounded-md text-sm text-muted-foreground text-center">
                    {t("crm.conf.loading")}
                  </div>
                ) : isErrorOptions ? (
                  <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive text-center">
                    {t("crm.conf.error")}
                  </div>
                ) : options.length > 0 ? (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">{t("crm.conf.ref_title")}</label>
                    <Select value={selectedConfId} onValueChange={setSelectedConfId}>
                      <SelectTrigger>
                        <SelectValue placeholder={t("crm.conf.ref_placeholder_select")} />
                      </SelectTrigger>
                      <SelectContent>
                        {options.map(o => (
                          <SelectItem key={o.id?.toString() || o.kind} value={o.id?.toString() || o.kind}>
                            {optionLabel(o)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <div className="p-3 bg-muted/50 border rounded-md text-sm text-muted-foreground text-center">
                    {t("crm.conf.empty")}
                  </div>
                )}
                
                <div className="space-y-1.5 pt-2">
                  <label className="text-xs font-medium text-muted-foreground">
                    {selectedConfId === "HUMAN_ADMIN" ? t("crm.conf.reason_title_human") : t("crm.conf.reason_title")}
                  </label>
                  <Textarea 
                    placeholder={t("crm.transition.details_placeholder" as any)}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="min-h-[80px]"
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {t("crm.transition.reason_prompt" as any)}
              </p>
              <Textarea 
                placeholder={t("crm.transition.reason_placeholder" as any)}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="min-h-[100px]"
              />
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isPending}>
            {t("common.cancelar")}
          </Button>
          <Button onClick={handleConfirm} disabled={!isValid() || isPending}>
            {isPending ? t("common.salvando") : t("common.confirmar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
