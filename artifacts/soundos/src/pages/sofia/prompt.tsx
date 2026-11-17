import { useState, useEffect, useRef } from "react";
import { useListPrompts, useCreatePrompt, useActivatePrompt } from "@workspace/api-client-react";
import type { ApiError } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Save, Zap, RotateCcw, MessageSquareCode, Clock, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { useLang } from "@/contexts/language";
import { formatDateTimeBR } from "@/lib/date";
import {
  DEFAULT_SOFIA_MODEL_ID,
  SOFIA_MODELS,
  getSofiaModelLabel,
} from "@/lib/sofia-models";

const DEFAULT_SYSTEM_PROMPT = `Você é Sofia, a assistente virtual inteligente da Soundfulness — escola brasileira especializada em Sound Healing e terapia com sinos e tigelas tibetanas.

Seu papel é ajudar a equipe interna da escola com informações sobre cursos, alunos, matrículas, vendas, operações e qualquer dúvida do dia a dia.

Responda sempre em português brasileiro, de forma clara, objetiva e acolhedora. Seja precisa e útil.`;

function ModelBadge({ model }: { model: string }) {
  const found = SOFIA_MODELS.find(m => m.value === model);
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${found?.color ?? "bg-muted text-muted-foreground"}`}>
      {getSofiaModelLabel(model)}
    </span>
  );
}

export default function SofiaPromptPrincipal() {
  const queryClient = useQueryClient();
  const { data: prompts, isLoading } = useListPrompts();
  const { setDirty } = useUnsavedGuard();
  const { t } = useLang();

  const activePrompt = prompts?.find(p => p.isActive);
  const historyPrompts = [...(prompts ?? [])].reverse().slice(0, 10);

  const [editorBody, setEditorBody] = useState(DEFAULT_SYSTEM_PROMPT);
  const [editorName, setEditorName] = useState("");
  const [editorModel, setEditorModel] = useState<string>(DEFAULT_SOFIA_MODEL_ID);
  const [editedPromptId, setEditedPromptId] = useState<number | null>(null);

  // The baseline — what was last loaded or saved
  const savedBodyRef = useRef(DEFAULT_SYSTEM_PROMPT);
  const savedModelRef = useRef<string>(DEFAULT_SOFIA_MODEL_ID);

  // Sync editor to active prompt when data loads
  useEffect(() => {
    if (prompts && prompts.length > 0 && editedPromptId === null) {
      const active = prompts.find(p => p.isActive) ?? prompts[prompts.length - 1];
      setEditorBody(active.body);
      setEditorModel(active.model ?? DEFAULT_SOFIA_MODEL_ID);
      setEditorName("");
      setEditedPromptId(active.id);
      savedBodyRef.current = active.body;
      savedModelRef.current = active.model ?? DEFAULT_SOFIA_MODEL_ID;
      setDirty(false);
    }
  }, [prompts, editedPromptId, setDirty]);

  // Clear dirty on unmount
  useEffect(() => () => { setDirty(false); }, [setDirty]);

  const createMutation = useCreatePrompt({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: ["/api/sofia/prompts"] });
        setEditedPromptId(data.id);
        setEditorName("");
        savedBodyRef.current = editorBody;
        savedModelRef.current = editorModel;
        setDirty(false);
        toast.success(t("sofia.prompt.versao_salva").replace("{v}", data.version));
      },
      onError: () => toast.error(t("sofia.prompt.err_salvar")),
    },
  });

  const activateMutation = useActivatePrompt({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: ["/api/sofia/prompts"] });
        toast.success(t("sofia.prompt.prompt_ativado").replace("{v}", data.version));
      },
      onError: (error) => {
        const data = (error as ApiError<{ code?: string }>).data;
        if (data?.code === "SOFIA_MODEL_UNAVAILABLE") {
          toast.error(t("sofia.prompt.modelo_indisponivel"), {
            action: {
              label: t("sofia.prompt.tentar_novamente"),
              onClick: () => activateMutation.mutate({ id: editedPromptId! }),
            },
          });
          return;
        }
        toast.error(t("sofia.prompt.err_ativar"));
      },
    },
  });

  const handleSave = () => {
    if (!editorBody.trim()) { toast.error(t("sofia.prompt.corpo_vazio")); return; }
    const nextVersion = `v${(prompts?.length ?? 0) + 1}.0`;
    createMutation.mutate({
      data: {
        name: editorName.trim() || nextVersion,
        body: editorBody,
        model: editorModel,
      },
    });
  };

  const handleActivate = () => {
    if (editedPromptId === null) { toast.error(t("sofia.prompt.salve_antes")); return; }
    if (editedPromptId === activePrompt?.id) { toast.info(t("sofia.prompt.ja_ativo_toast")); return; }
    activateMutation.mutate({ id: editedPromptId });
  };

  const handleBodyChange = (value: string) => {
    setEditorBody(value);
    setDirty(value !== savedBodyRef.current || editorModel !== savedModelRef.current);
  };

  const handleModelChange = (value: string) => {
    setEditorModel(value);
    setDirty(editorBody !== savedBodyRef.current || value !== savedModelRef.current);
  };

  const handleRestore = (p: { id: number; body: string; model?: string | null }) => {
    const model = p.model ?? DEFAULT_SOFIA_MODEL_ID;
    setEditorBody(p.body);
    setEditorModel(model);
    setEditorName("");
    setEditedPromptId(p.id);
    savedBodyRef.current = p.body;
    savedModelRef.current = model;
    setDirty(false);
    toast.info(t("sofia.prompt.carregado"));
  };

  const isCurrentlyActive = editedPromptId !== null && editedPromptId === activePrompt?.id;
  const isSaving = createMutation.isPending;
  const isActivating = activateMutation.isPending;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("sofia.prompt.title")}</h1>
        <p className="text-muted-foreground text-sm">
          {t("sofia.prompt.subtitle")}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">
        {/* ── Editor Panel ─────────────────────────────────────── */}
        <Card className="shadow-sm border-border/40">
          <CardHeader className="pb-4 border-b border-border/30">
            <div className="flex items-center gap-2">
              <MessageSquareCode className="h-4 w-4 text-sofia/70 shrink-0" />
              <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground">
                {t("sofia.prompt.editor")}
              </CardTitle>
            </div>
          </CardHeader>

          <CardContent className="pt-5 space-y-5">
            {/* Name + Model row */}
            <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("sofia.prompt.nome_versao")}</Label>
                <Input
                  value={editorName}
                  onChange={e => setEditorName(e.target.value)}
                  placeholder={`v${(prompts?.length ?? 0) + 1}.0 ${t("sofia.prompt.ph_nome_sfx")}`}
                  className="h-9 text-sm bg-muted/30 border-border/40 placeholder:text-muted-foreground/50"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("sofia.prompt.modelo")}</Label>
                <Select value={editorModel} onValueChange={handleModelChange}>
                  <SelectTrigger className="h-9 w-[180px] text-sm bg-muted/30 border-border/40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SOFIA_MODELS.map(m => (
                      <SelectItem key={m.value} value={m.value}>
                        <div className="flex items-center gap-2">
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${m.dotColor}`} />
                          <span className="font-mono text-xs">{m.label}</span>
                          <span className="text-muted-foreground text-[10px]">{t(m.descKey)}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Textarea */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("sofia.prompt.corpo")}</Label>
              <Textarea
                value={editorBody}
                onChange={e => handleBodyChange(e.target.value)}
                className="font-mono text-sm leading-relaxed min-h-[320px] resize-y bg-muted/20 border-border/30 focus:border-sofia/30 focus:ring-sofia/10 placeholder:text-muted-foreground/40"
                placeholder={t("sofia.prompt.ph_corpo")}
              />
              <div className="text-[11px] text-muted-foreground/50 text-right">
                {editorBody.length} {t("sofia.prompt.caracteres")} · {editorBody.split(/\s+/).filter(Boolean).length} {t("sofia.prompt.palavras")}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-3 pt-1">
              <Button
                variant="outline"
                onClick={handleSave}
                disabled={isSaving || !editorBody.trim()}
                className="gap-2 border-border/50 hover:bg-muted/50"
              >
                <Save className="h-3.5 w-3.5" />
                {isSaving ? t("sofia.prompt.salvando") : t("sofia.prompt.salvar_ver")}
              </Button>

              <Button
                onClick={handleActivate}
                disabled={isActivating || editedPromptId === null || isCurrentlyActive}
                className="gap-2 bg-sofia hover:bg-sofia/90 text-white"
              >
                <Zap className="h-3.5 w-3.5" />
                {isActivating ? t("sofia.prompt.ativando") : isCurrentlyActive ? t("sofia.prompt.ja_ativo") : t("sofia.prompt.ativar")}
              </Button>

              {isCurrentlyActive && (
                <div className="flex items-center gap-1.5 text-[11px] text-emerald-600 font-medium ml-1">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {t("sofia.prompt.ativo_msg")}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ── History Panel ─────────────────────────────────────── */}
        <Card className="shadow-sm border-border/40">
          <CardHeader className="pb-3 border-b border-border/30">
            <div className="flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
              <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground">
                {t("sofia.prompt.historico")}
              </CardTitle>
              {prompts && prompts.length > 0 && (
                <span className="ml-auto text-[10px] text-muted-foreground/50">{Math.min(prompts.length, 10)} {t("common.versoes")}</span>
              )}
            </div>
          </CardHeader>

          <CardContent className="pt-0 px-0">
            {isLoading ? (
              <div className="p-4 space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
              </div>
            ) : historyPrompts.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground/50 text-sm">
                {t("sofia.prompt.nenhum")}
                <br />
                <span className="text-xs">{t("sofia.prompt.salve_ver")}</span>
              </div>
            ) : (
              <div className="divide-y divide-border/25">
                {historyPrompts.map((p, idx) => {
                  const isEditing = p.id === editedPromptId;
                  return (
                    <div
                      key={p.id}
                      className={`px-4 py-3 transition-colors ${isEditing ? "bg-sofia/5" : "hover:bg-muted/30"}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap mb-1">
                            <span className="font-mono text-xs font-semibold text-foreground/80">
                              {p.version}
                            </span>
                            {p.isActive && (
                              <Badge className="h-4 px-1.5 text-[9px] bg-emerald-500/15 text-emerald-700 border-emerald-200 hover:bg-emerald-500/15">
                                {t("common.ativo_s")}
                              </Badge>
                            )}
                            {isEditing && !p.isActive && (
                              <Badge variant="outline" className="h-4 px-1.5 text-[9px] border-sofia/30 text-sofia/70">
                                {t("pessoa.modo_edicao")}
                              </Badge>
                            )}
                          </div>
                          {p.name && p.name !== p.version && (
                            <p className="text-[11px] text-muted-foreground/70 truncate mb-1">{p.name}</p>
                          )}
                          <div className="flex items-center gap-2 flex-wrap">
                            <ModelBadge model={p.model ?? DEFAULT_SOFIA_MODEL_ID} />
                            <span className="text-[10px] text-muted-foreground/50">
                              {formatDateTimeBR(p.createdAt)}
                            </span>
                          </div>
                        </div>

                        {!isEditing && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRestore(p)}
                            className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 shrink-0 gap-1"
                          >
                            <RotateCcw className="h-3 w-3" />
                            {t("sofia.prompt.restaurar")}
                          </Button>
                        )}
                      </div>

                      {idx < historyPrompts.length - 1 && <div />}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
