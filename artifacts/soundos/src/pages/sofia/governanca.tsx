import { useState, useMemo, useEffect } from "react";
import {
  useListSofiaEntityRegistry,
  useUpdateSofiaEntityRegistry,
  getListSofiaEntityRegistryQueryKey,
  SofiaEntity,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLang } from "@/contexts/language";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "@/components/ui/sheet";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ShieldCheck, Search, AlertCircle, CheckCircle2, ShieldAlert, XCircle, Pencil, Info } from "lucide-react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";

export default function SofiaGovernanca() {
  const { t } = useLang();
  const queryClient = useQueryClient();
  const { data: entities, isLoading, isError } = useListSofiaEntityRegistry();
  
  const [search, setSearch] = useState("");
  const [editingEntity, setEditingEntity] = useState<SofiaEntity | null>(null);

  const filteredEntities = useMemo(() => {
    if (!entities) return [];
    if (!search) return entities;
    const lower = search.toLowerCase();
    return entities.filter(e => 
      e.displayName.toLowerCase().includes(lower) || 
      e.stableKey.toLowerCase().includes(lower)
    );
  }, [entities, search]);

  const getEntityTypeName = (type: string) => {
    if (type === "offer") return t("sofia.gov.tipo_offer");
    if (type === "instrument_family") return t("sofia.gov.tipo_instrument_family");
    if (type === "event") return t("sofia.gov.tipo_event");
    return type;
  };

  const getStatusName = (status: string) => {
    if (status === "approved") return t("sofia.gov.status_approved");
    if (status === "rejected") return t("sofia.gov.status_rejected");
    return t("sofia.gov.status_draft");
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1 flex items-center gap-2">
            <ShieldCheck className="h-8 w-8 text-sofia" />
            {t("sofia.gov.title")}
          </h1>
          <p className="text-muted-foreground text-sm max-w-2xl">{t("sofia.gov.subtitle")}</p>
        </div>
      </div>

      <Card className="shadow-sm border-border/40">
        <CardHeader className="pb-3 border-b border-border/30 flex flex-row items-center justify-between">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t("sofia.gov.buscar")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-muted/20"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-4">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-12 w-full rounded-md" />)}
            </div>
          ) : isError ? (
            <div className="p-8 text-center text-destructive">{t("sofia.gov.error")}</div>
          ) : filteredEntities.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">{t("sofia.gov.empty")}</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/30">
                  <TableRow>
                    <TableHead className="w-[300px]">{t("sofia.gov.tipo")} / Nome</TableHead>
                    <TableHead>{t("sofia.gov.status")}</TableHead>
                    <TableHead>{t("sofia.gov.sensitive")}</TableHead>
                    <TableHead>{t("sofia.gov.gaps")}</TableHead>
                    <TableHead className="w-[100px] text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredEntities.map((entity) => {
                    const hasStatusGap = entity.reviewStatus !== "approved";
                    const hasSourceGap = !entity.sourceRefs || entity.sourceRefs.length === 0 || !entity.sourceRefs.some(s => {
                      if (!s.ref && !s.url) return false;
                       if ("validUntil" in s && typeof s.validUntil === "string") {
                         const validUntilDate = new Date(s.validUntil);
                        if (!isNaN(validUntilDate.getTime()) && validUntilDate < new Date()) {
                          return false; // Expired
                        }
                      }
                      return true;
                    });
                    const hasFactsGap = !entity.approvedFacts || Object.keys(entity.approvedFacts).length === 0;
                    const hasCapGap = !entity.capabilities || 
                      (!(entity.capabilities as any).informPrice && 
                       !(entity.capabilities as any).sendCheckout && 
                       !(entity.capabilities as any).checkAvailability);
                    
                    const totalGaps = [hasStatusGap, hasSourceGap, hasFactsGap, hasCapGap].filter(Boolean).length;

                    return (
                      <TableRow key={entity.id} className="group hover:bg-muted/10 transition-colors">
                        <TableCell>
                          <div className="flex flex-col min-w-0">
                            <span className="text-[10px] font-bold tracking-wider text-muted-foreground uppercase mb-0.5">
                              {getEntityTypeName(entity.entityType)}
                            </span>
                            <span className="font-medium truncate text-foreground">{entity.displayName}</span>
                            <span className="text-xs text-muted-foreground truncate">{entity.stableKey}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge 
                            variant="outline" 
                            className={
                              entity.reviewStatus === "approved" ? "border-emerald-500/30 text-emerald-600 bg-emerald-500/10" :
                              entity.reviewStatus === "rejected" ? "border-destructive/30 text-destructive bg-destructive/10" :
                              "border-amber-500/30 text-amber-600 bg-amber-500/10"
                            }
                          >
                            {getStatusName(entity.reviewStatus)}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {entity.sensitive ? (
                            <Badge variant="outline" className="border-rose-500/30 text-rose-600 bg-rose-500/10 gap-1">
                              <ShieldAlert className="h-3 w-3" /> {t("common.sim")}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">{t("common.nao")}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {totalGaps === 0 ? (
                            <span className="flex items-center gap-1.5 text-xs text-emerald-600">
                              <CheckCircle2 className="h-3.5 w-3.5" /> Completo
                            </span>
                          ) : (
                            <div className="flex flex-col gap-1">
                              {hasStatusGap && <GapBadge text={t("sofia.gov.gap_status")} />}
                              {hasSourceGap && <GapBadge text={t("sofia.gov.gap_source")} />}
                              {hasFactsGap && <GapBadge text={t("sofia.gov.gap_facts")} />}
                              {hasCapGap && <GapBadge text={t("sofia.gov.gap_capabilities")} />}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={() => setEditingEntity(entity)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {editingEntity && (
        <EntityEditSheet 
          entity={editingEntity} 
          open={!!editingEntity} 
          onOpenChange={(open) => !open && setEditingEntity(null)} 
        />
      )}
    </div>
  );
}

function GapBadge({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 font-medium bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200/50 w-fit">
      <AlertCircle className="h-2.5 w-2.5" /> {text}
    </span>
  );
}

function EntityEditSheet({ 
  entity, 
  open, 
  onOpenChange 
}: { 
  entity: SofiaEntity; 
  open: boolean; 
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLang();
  const queryClient = useQueryClient();
  
  const [reviewStatus, setReviewStatus] = useState<string>(entity.reviewStatus);
  const [sensitive, setSensitive] = useState<boolean>(entity.sensitive);
  const [informPrice, setInformPrice] = useState<boolean>(!!(entity.capabilities as any)?.informPrice);
  const [sendCheckout, setSendCheckout] = useState<boolean>(!!(entity.capabilities as any)?.sendCheckout);
  const [checkAvailability, setCheckAvailability] = useState<boolean>(!!(entity.capabilities as any)?.checkAvailability);
  
  const initialSourceRefsStr = entity.sourceRefs && entity.sourceRefs.length > 0 
    ? JSON.stringify(entity.sourceRefs, null, 2) 
    : "[\n  {\n    \"type\": \"official\",\n    \"ref\": \"\",\n    \"url\": \"\",\n    \"checkedAt\": \"\",\n    \"validUntil\": \"\"\n  }\n]";
  const [sourceRefsText, setSourceRefsText] = useState<string>(initialSourceRefsStr);
  const [refsError, setRefsError] = useState<string>("");
  
  const initialFactsStr = entity.approvedFacts ? JSON.stringify(entity.approvedFacts, null, 2) : "{\n  \n}";
  const [approvedFactsText, setApprovedFactsText] = useState<string>(initialFactsStr);
  const [factsError, setFactsError] = useState<string>("");

  const updateMutation = useUpdateSofiaEntityRegistry({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSofiaEntityRegistryQueryKey() });
        toast.success(t("sofia.gov.success"));
        onOpenChange(false);
      },
      onError: () => {
        toast.error(t("sofia.gov.error"));
      }
    }
  });

  const handleSave = () => {
    let parsedFacts = {};
    try {
      if (approvedFactsText.trim()) {
        parsedFacts = JSON.parse(approvedFactsText);
      }
    } catch (e) {
      setFactsError("JSON inválido");
      return;
    }
    
    let parsedSourceRefs: any[] = [];
    try {
      if (sourceRefsText.trim()) {
        parsedSourceRefs = JSON.parse(sourceRefsText);
        if (!Array.isArray(parsedSourceRefs)) throw new Error("Must be an array");
      }
    } catch (e) {
      setRefsError("JSON inválido ou formato incorreto. Deve ser um array de objetos.");
      return;
    }
    
    // Preserve existing capabilities not explicitly managed here
    const baseCaps = (entity.capabilities || {}) as Record<string, unknown>;
    const updatedCaps = {
      ...baseCaps,
      informPrice,
      sendCheckout,
      checkAvailability
    };

    updateMutation.mutate({
      id: entity.id,
      data: {
        reviewStatus: reviewStatus as any,
        sensitive,
        sourceRefs: parsedSourceRefs,
        approvedFacts: parsedFacts,
        capabilities: updatedCaps
      }
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto" aria-describedby="edit-sheet-description">
        <SheetHeader className="mb-6">
          <SheetTitle>{t("sofia.gov.edit")}</SheetTitle>
          <SheetDescription id="edit-sheet-description">
            <span className="block font-medium text-foreground">{entity.displayName}</span>
            <span className="block text-xs font-mono mt-1">{entity.stableKey}</span>
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t("sofia.gov.status")}</Label>
              <Select value={reviewStatus} onValueChange={setReviewStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">{t("sofia.gov.status_draft")}</SelectItem>
                  <SelectItem value="approved">{t("sofia.gov.status_approved")}</SelectItem>
                  <SelectItem value="rejected">{t("sofia.gov.status_rejected")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col justify-center space-y-2 mt-4">
              <div className="flex items-center gap-2">
                <Switch id="sensitive-switch" checked={sensitive} onCheckedChange={setSensitive} />
                <Label htmlFor="sensitive-switch" className="flex items-center gap-1 cursor-pointer">
                  {t("sofia.gov.sensitive")}
                  <ShieldAlert className="h-3 w-3 text-muted-foreground" />
                </Label>
              </div>
              <p className="text-[10px] text-muted-foreground leading-tight ml-11">
                {t("sofia.gov.sensitive_desc")}
              </p>
            </div>
          </div>

          <div className="space-y-3 p-4 bg-muted/20 border border-border/40 rounded-lg">
            <Label className="text-sm font-semibold flex items-center gap-2">
              <Info className="h-4 w-4 text-sofia" /> 
              {t("sofia.gov.capabilities")}
            </Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
              <div className="flex items-center gap-2">
                <Switch id="cap-price" checked={informPrice} onCheckedChange={setInformPrice} />
                <Label htmlFor="cap-price" className="text-sm cursor-pointer">{t("sofia.gov.cap_informPrice")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="cap-checkout" checked={sendCheckout} onCheckedChange={setSendCheckout} />
                <Label htmlFor="cap-checkout" className="text-sm cursor-pointer">{t("sofia.gov.cap_sendCheckout")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="cap-avail" checked={checkAvailability} onCheckedChange={setCheckAvailability} />
                <Label htmlFor="cap-avail" className="text-sm cursor-pointer">{t("sofia.gov.cap_checkAvailability")}</Label>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="source-refs" className={refsError ? "text-destructive" : ""}>
                {t("sofia.gov.sourceRefs")}
              </Label>
              <span className="text-[10px] text-muted-foreground">Formato JSON (array)</span>
            </div>
            <Textarea 
              id="source-refs" 
              value={sourceRefsText}
              onChange={(e) => {
                setSourceRefsText(e.target.value);
                setRefsError("");
              }}
              placeholder='[{"type":"official", "ref":"Nome", "url":"https://..."}]'
              className={`font-mono text-xs min-h-[160px] resize-y ${refsError ? "border-destructive focus-visible:ring-destructive" : ""}`}
            />
            {refsError && <p className="text-xs text-destructive">{refsError}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="approved-facts" className={factsError ? "text-destructive" : ""}>
              {t("sofia.gov.approvedFacts")}
            </Label>
            <Textarea 
              id="approved-facts" 
              value={approvedFactsText}
              onChange={(e) => {
                setApprovedFactsText(e.target.value);
                setFactsError("");
              }}

              className={`font-mono text-xs min-h-[200px] resize-y ${factsError ? "border-destructive focus-visible:ring-destructive" : ""}`}
            />
            {factsError && <p className="text-xs text-destructive">{factsError}</p>}
          </div>

        </div>

        <SheetFooter className="mt-8">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("sofia.gov.cancel")}
          </Button>
          <Button 
            onClick={handleSave} 
            disabled={updateMutation.isPending}
            className="bg-sofia hover:bg-sofia/90 text-white"
          >
            {updateMutation.isPending ? t("sofia.gov.saving") : t("sofia.gov.save")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
