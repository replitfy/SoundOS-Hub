import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListVideos,
  useUpdateVideo,
  useCreateVideo,
  useDeleteVideo,
  useImportVideos,
  updateVideo,
  getListVideosQueryKey,
  downloadVideoImportTemplate,
  type Video,
  type VideoImportResult,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  CheckCheck, Download, FileUp, Film, Link2, Link2Off, Pencil, PlayCircle, Plus, Trash2, Video as VideoIcon, X,
} from "lucide-react";
import { toast } from "sonner";
import { useLang } from "@/contexts/language";
import { handleSessionExpired } from "@/lib/auth-error";

function fillTemplate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (acc, [key, value]) => acc.replace(`{${key}}`, String(value)),
    template,
  );
}

interface VideoFormState {
  codigo: string;
  titulo: string;
  descricao: string;
  curso: string;
  tipo: string;
  duracao: string;
  link: string;
}

const EMPTY_FORM: VideoFormState = { codigo: "", titulo: "", descricao: "", curso: "", tipo: "", duracao: "", link: "" };

function videoToForm(v: Video): VideoFormState {
  return {
    codigo: v.codigo ?? "",
    titulo: v.titulo,
    descricao: v.descricao ?? "",
    curso: v.curso ?? "",
    tipo: v.tipo ?? "",
    duracao: v.duracao ?? "",
    link: v.link ?? "",
  };
}

export default function Videos() {
  const queryClient = useQueryClient();
  const { t } = useLang();
  const { data: videos, isLoading } = useListVideos();
  const [search, setSearch] = useState("");
  const [mostrarSemLink, setMostrarSemLink] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"todos" | "aprovados" | "pendentes">("todos");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isBulkApproving, setIsBulkApproving] = useState(false);
  const [importResult, setImportResult] = useState<VideoImportResult | null>(null);
  const [showImportErrors, setShowImportErrors] = useState(false);
  const [isDownloadingTemplate, setIsDownloadingTemplate] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [editingVideo, setEditingVideo] = useState<Video | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [form, setForm] = useState<VideoFormState>(EMPTY_FORM);
  const [deletingVideo, setDeletingVideo] = useState<Video | null>(null);

  const formOpen = isCreating || editingVideo !== null;

  const closeForm = () => {
    setIsCreating(false);
    setEditingVideo(null);
    setForm(EMPTY_FORM);
  };

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setEditingVideo(null);
    setIsCreating(true);
  };

  const openEdit = (v: Video) => {
    setForm(videoToForm(v));
    setIsCreating(false);
    setEditingVideo(v);
  };

  const onSaveError = (err: unknown) => {
    if (!handleSessionExpired(err)) {
      const msg = err instanceof Error ? err.message : "";
      toast.error(msg.includes(":") ? msg.split(":").slice(1).join(":").trim() : t("sofia.videos.erro_salvar"));
    }
  };

  const toggleMutation = useUpdateVideo({
    mutation: {
      onSuccess: (updated) => {
        queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
        toast.success(updated.aprovadoParaSofia ? t("sofia.videos.aprovado_msg") : t("sofia.videos.reprovado_msg"));
      },
      onError: (err) => {
        if (handleSessionExpired(err)) return;
        const msg = err instanceof Error ? err.message : "";
        toast.error(msg.includes("400") || msg.toLowerCase().includes("link") ? t("sofia.videos.err_sem_link") : t("sofia.videos.err_toggle"));
      },
    },
  });

  const createMutation = useCreateVideo({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
        toast.success(t("sofia.videos.salvo_msg"));
        closeForm();
      },
      onError: onSaveError,
    },
  });

  const updateMutation = useUpdateVideo({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
        toast.success(t("sofia.videos.salvo_msg"));
        closeForm();
      },
      onError: onSaveError,
    },
  });

  const deleteMutation = useDeleteVideo({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
        toast.success(t("sofia.videos.excluido_msg"));
        setDeletingVideo(null);
      },
      onError: (err) => {
        if (!handleSessionExpired(err)) toast.error(t("sofia.videos.erro_excluir"));
      },
    },
  });

  const handleSubmitForm = () => {
    if (!form.titulo.trim()) {
      toast.error(t("sofia.videos.titulo_obrigatorio"));
      return;
    }
    const payload = {
      codigo: form.codigo.trim() || undefined,
      titulo: form.titulo.trim(),
      descricao: form.descricao.trim() || null,
      curso: form.curso.trim() || null,
      tipo: form.tipo.trim() || null,
      duracao: form.duracao.trim() || null,
      link: form.link.trim() || null,
    };
    if (editingVideo) {
      updateMutation.mutate({ id: editingVideo.id, data: payload });
    } else {
      createMutation.mutate({ data: payload });
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  const importMutation = useImportVideos({
    mutation: {
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
        setImportResult(result);
        setShowImportErrors(false);
        toast.success(fillTemplate(t("sofia.videos.import_sucesso"), {
          importados: result.importados,
          atualizados: result.atualizados,
          ignorados: result.ignorados,
        }));
      },
      onError: (err) => {
        if (!handleSessionExpired(err)) {
          toast.error(t("sofia.videos.import_erro"));
        }
      },
    },
  });

  const handleFileSelected = (file: File) => {
    importMutation.mutate({ data: { file } });
  };

  const handleDownloadTemplate = async () => {
    setIsDownloadingTemplate(true);
    try {
      const blob = await downloadVideoImportTemplate();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "modelo-catalogo-videos.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      if (!handleSessionExpired(err)) {
        toast.error(t("sofia.videos.import_erro"));
      }
    } finally {
      setIsDownloadingTemplate(false);
    }
  };

  const filtered = useMemo(() => {
    if (!videos) return [];
    const q = search.trim().toLowerCase();
    return videos.filter((v) => {
      if (!mostrarSemLink && !v.temLinkReal) return false;
      if (statusFilter === "aprovados" && !v.aprovadoParaSofia) return false;
      if (statusFilter === "pendentes" && v.aprovadoParaSofia) return false;
      if (!q) return true;
      return (
        v.titulo.toLowerCase().includes(q) ||
        (v.codigo ?? "").toLowerCase().includes(q) ||
        (v.curso ?? "").toLowerCase().includes(q) ||
        (v.tipo ?? "").toLowerCase().includes(q)
      );
    });
  }, [videos, search, mostrarSemLink, statusFilter]);

  // Only videos with a real link can be approved for Sofia; keep selection scoped to those.
  const selectedCount = selectedIds.size;

  const toggleSelectOne = (id: number, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const handleBulkSetApproval = async (aprovar: boolean) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setIsBulkApproving(true);
    try {
      const results = await Promise.allSettled(
        ids.map((id) => updateVideo(id, { aprovadoParaSofia: aprovar })),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const ok = results.length - failed;
      queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
      if (ok > 0) {
        toast.success(fillTemplate(
          aprovar ? t("sofia.videos.lote_aprovados") : t("sofia.videos.lote_reprovados"),
          { total: ok },
        ));
      }
      if (failed > 0) {
        toast.error(fillTemplate(t("sofia.videos.lote_erro"), { total: failed }));
      }
      clearSelection();
    } catch (err) {
      if (!handleSessionExpired(err)) toast.error(t("sofia.videos.err_toggle"));
    } finally {
      setIsBulkApproving(false);
    }
  };

  const grouped = useMemo(() => {
    const map = new Map<string, Video[]>();
    for (const v of filtered) {
      const key = v.curso ?? "—";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(v);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const totalCount = videos?.length ?? 0;
  const aprovadosCount = videos?.filter((v) => v.aprovadoParaSofia).length ?? 0;
  const comLinkCount = videos?.filter((v) => v.temLinkReal).length ?? 0;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("sofia.videos.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("sofia.videos.subtitle")}</p>
        </div>
        <Button size="sm" onClick={openCreate} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          {t("sofia.videos.novo_video")}
        </Button>
      </div>

      <Card className="shadow-sm border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-foreground">{t("sofia.videos.import_titulo")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground max-w-2xl">{t("sofia.videos.import_ajuda")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileSelected(file);
                e.target.value = "";
              }}
            />
            <Button
              size="sm"
              variant="default"
              disabled={importMutation.isPending}
              onClick={() => fileInputRef.current?.click()}
              className="gap-1.5"
            >
              <FileUp className="h-3.5 w-3.5" />
              {importMutation.isPending ? t("sofia.videos.enviando") : t("sofia.videos.enviar_planilha")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isDownloadingTemplate}
              onClick={handleDownloadTemplate}
              className="gap-1.5"
            >
              <Download className="h-3.5 w-3.5" />
              {t("sofia.videos.baixar_modelo")}
            </Button>
          </div>

          {importResult && (
            <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-xs text-muted-foreground space-y-1.5">
              <p>
                {fillTemplate(t("sofia.videos.import_sucesso"), {
                  importados: importResult.importados,
                  atualizados: importResult.atualizados,
                  ignorados: importResult.ignorados,
                })}
              </p>
              {importResult.erros.length > 0 && (
                <div>
                  <button
                    type="button"
                    className="text-sofia hover:underline text-xs"
                    onClick={() => setShowImportErrors((v) => !v)}
                  >
                    {t("sofia.videos.import_ver_erros")} ({importResult.erros.length})
                  </button>
                  {showImportErrors && (
                    <ul className="mt-1.5 space-y-0.5 list-disc list-inside">
                      {importResult.erros.map((erro, i) => (
                        <li key={i}>
                          {fillTemplate(t("sofia.videos.import_linha"), { linha: erro.linha })}: {erro.motivo}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {videos && videos.length > 0 && (
        <div className="flex gap-4 flex-wrap items-center">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Film className="h-4 w-4 text-sofia/60" />
            <span><strong className="text-foreground">{totalCount}</strong> {t("sofia.videos.total")}</span>
          </div>
          <div className="text-muted-foreground/40 text-sm">·</div>
          <div className="text-sm text-muted-foreground">
            <strong className="text-foreground">{comLinkCount}</strong> {t("sofia.videos.com_link")}
          </div>
          <div className="text-muted-foreground/40 text-sm">·</div>
          <div className="text-sm text-muted-foreground">
            <strong className="text-foreground">{aprovadosCount}</strong> {t("sofia.videos.aprovados")}
          </div>
          <div className="flex-1" />
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <Switch checked={mostrarSemLink} onCheckedChange={setMostrarSemLink} />
            {t("sofia.videos.filtro_mostrar_sem_link")}
          </label>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
            <SelectTrigger className="h-8 text-xs w-40 bg-muted/30 border-border/40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">{t("sofia.videos.filtro_todos")}</SelectItem>
              <SelectItem value="aprovados">{t("sofia.videos.filtro_aprovados")}</SelectItem>
              <SelectItem value="pendentes">{t("sofia.videos.filtro_pendentes")}</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("sofia.videos.busca_placeholder")}
            className="h-8 text-sm w-64 bg-muted/30 border-border/40"
          />
        </div>
      )}

      {selectedCount > 0 && (
        <div className="flex items-center gap-3 rounded-md border border-sofia/30 bg-sofia/5 px-3 py-2">
          <span className="text-xs font-medium text-foreground">
            {fillTemplate(t("sofia.videos.lote_selecionados"), { total: selectedCount })}
          </span>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="default"
            disabled={isBulkApproving}
            onClick={() => handleBulkSetApproval(true)}
            className="h-7 gap-1.5 text-xs"
          >
            <CheckCheck className="h-3.5 w-3.5" />
            {t("sofia.videos.lote_aprovar")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isBulkApproving}
            onClick={() => handleBulkSetApproval(false)}
            className="h-7 gap-1.5 text-xs"
          >
            <Link2Off className="h-3.5 w-3.5" />
            {t("sofia.videos.lote_reprovar")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={isBulkApproving}
            onClick={clearSelection}
            className="h-7 gap-1.5 text-xs text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" />
            {t("sofia.videos.lote_limpar")}
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full rounded" />)}
        </div>
      ) : grouped.length === 0 ? (
        <Card className="shadow-sm border-border/50">
          <CardContent className="py-16 text-center">
            <VideoIcon className="h-10 w-10 mx-auto mb-3 text-muted-foreground/25" />
            <p className="text-muted-foreground text-sm">{t("sofia.videos.nenhum")}</p>
          </CardContent>
        </Card>
      ) : (
        grouped.map(([curso, items]) => {
          const groupSelectable = items.filter((v) => v.temLinkReal);
          const groupAllSelected = groupSelectable.length > 0 && groupSelectable.every((v) => selectedIds.has(v.id));
          const groupSomeSelected = groupSelectable.some((v) => selectedIds.has(v.id));
          return (
          <Card key={curso} className="shadow-sm border-border/50">
            <CardHeader className="pb-3 border-b border-border/30 flex-row items-center justify-between">
              <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground">
                {curso}
              </CardTitle>
              <span className="text-xs text-muted-foreground/60">{items.length}</span>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-xs w-8">
                      <Checkbox
                        checked={groupAllSelected ? true : (groupSomeSelected ? "indeterminate" : false)}
                        onCheckedChange={(checked) => {
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            for (const v of groupSelectable) {
                              if (checked === true) next.add(v.id);
                              else next.delete(v.id);
                            }
                            return next;
                          });
                        }}
                        disabled={groupSelectable.length === 0}
                        aria-label={t("sofia.videos.lote_selecionar_tudo")}
                      />
                    </TableHead>
                    <TableHead className="text-xs w-24">{t("sofia.videos.codigo")}</TableHead>
                    <TableHead className="text-xs">{t("common.titulo")}</TableHead>
                    <TableHead className="text-xs w-32">{t("common.tipo")}</TableHead>
                    <TableHead className="text-xs w-20">{t("sofia.mem.col_data")}</TableHead>
                    <TableHead className="text-xs w-24">Link</TableHead>
                    <TableHead className="text-xs w-40 text-right">{t("sofia.videos.aprovar")}</TableHead>
                    <TableHead className="text-xs w-20 text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((v) => (
                    <TableRow key={v.id} className="group">
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(v.id)}
                          onCheckedChange={(checked) => toggleSelectOne(v.id, checked === true)}
                          disabled={!v.temLinkReal}
                          aria-label={v.titulo}
                        />
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground font-mono">{v.codigo}</span>
                      </TableCell>
                      <TableCell className="font-medium text-sm">
                        <span
                          className="truncate max-w-[320px] inline-block align-middle"
                          title={v.descricao ? `${v.titulo} — ${v.descricao}` : v.titulo}
                        >
                          {v.titulo}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">{v.tipo ?? "—"}</span>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">{v.duracao ?? "—"}</span>
                      </TableCell>
                      <TableCell>
                        {v.temLinkReal && v.link ? (
                          <a
                            href={v.link}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-sofia hover:underline"
                          >
                            <PlayCircle className="h-3.5 w-3.5" />
                            {t("sofia.videos.assistir")}
                          </a>
                        ) : (
                          <Badge variant="outline" className="border-muted-foreground/30 text-muted-foreground gap-1 text-[10px]">
                            <Link2Off className="h-2.5 w-2.5" />
                            {t("sofia.videos.sem_link")}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {v.aprovadoParaSofia && (
                            <Badge className="bg-emerald-500/15 text-emerald-700 border-emerald-200 hover:bg-emerald-500/15 gap-1 text-[10px]">
                              <Link2 className="h-2.5 w-2.5" />
                              {t("sofia.videos.aprovado")}
                            </Badge>
                          )}
                          <Switch
                            checked={v.aprovadoParaSofia}
                            disabled={!v.temLinkReal || toggleMutation.isPending}
                            onCheckedChange={(checked) => toggleMutation.mutate({ id: v.id, data: { aprovadoParaSofia: checked } })}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            onClick={() => openEdit(v)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive/60 hover:text-destructive"
                            onClick={() => setDeletingVideo(v)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          );
        })
      )}

      <Dialog open={formOpen} onOpenChange={(open) => { if (!open) closeForm(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingVideo ? t("sofia.videos.editar_video") : t("sofia.videos.novo_video")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">{t("sofia.videos.codigo")}</Label>
                <Input
                  value={form.codigo}
                  onChange={(e) => setForm((f) => ({ ...f, codigo: e.target.value }))}
                  className="h-8 text-sm font-mono"
                  placeholder={t("sofia.videos.codigo_ajuda")}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("common.tipo")}</Label>
                <Input
                  value={form.tipo}
                  onChange={(e) => setForm((f) => ({ ...f, tipo: e.target.value }))}
                  className="h-8 text-sm"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("common.titulo")} *</Label>
              <Input
                value={form.titulo}
                onChange={(e) => setForm((f) => ({ ...f, titulo: e.target.value }))}
                className="h-8 text-sm"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("admin.cat.descricao")}</Label>
              <Textarea
                value={form.descricao}
                onChange={(e) => setForm((f) => ({ ...f, descricao: e.target.value }))}
                className="text-sm min-h-[64px] resize-none"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Link (YouTube)</Label>
              <Input
                value={form.link}
                onChange={(e) => setForm((f) => ({ ...f, link: e.target.value }))}
                className="h-8 text-sm"
                placeholder={t("sofia.videos.link_placeholder")}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Curso</Label>
                <Input
                  value={form.curso}
                  onChange={(e) => setForm((f) => ({ ...f, curso: e.target.value }))}
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("sofia.mem.col_data")}</Label>
                <Input
                  value={form.duracao}
                  onChange={(e) => setForm((f) => ({ ...f, duracao: e.target.value }))}
                  className="h-8 text-sm"
                  placeholder="2:42"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeForm} disabled={isSaving}>
              {t("common.cancelar")}
            </Button>
            <Button onClick={handleSubmitForm} disabled={isSaving || !form.titulo.trim()}>
              {editingVideo ? t("common.salvar") : t("sofia.videos.criar_video")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deletingVideo !== null} onOpenChange={(open) => { if (!open) setDeletingVideo(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("sofia.videos.excluir_video")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("sofia.videos.confirmar_excluir")} "{deletingVideo?.titulo}"?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>{t("common.cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={() => { if (deletingVideo) deleteMutation.mutate({ id: deletingVideo.id }); }}
            >
              {t("common.excluir") ?? "Excluir"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
