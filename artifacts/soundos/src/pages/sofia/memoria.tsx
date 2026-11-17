import { useState, useRef, useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListKnowledgeItems,
  useDeleteKnowledgeItem,
  getListKnowledgeItemsQueryKey,
  type KnowledgeItem,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Upload, Trash2, FileText, FileType2, Database, AlertCircle, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { fr } from "date-fns/locale";
import { useLang } from "@/contexts/language";
import { useUserSession } from "@/contexts/user-session";

const BASE = import.meta.env.BASE_URL ?? "/";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileTypeIcon(type: string) {
  if (type === "pdf") return <FileType2 className="h-3.5 w-3.5 text-rose-400 shrink-0" />;
  if (type === "md") return <FileText className="h-3.5 w-3.5 text-sky-400 shrink-0" />;
  return <FileText className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />;
}

function StatusBadge({ item }: { item: KnowledgeItem }) {
  const { t } = useLang();
  if (item.indexStatus === "indexed") {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-700 border-emerald-200 hover:bg-emerald-500/15 gap-1 text-[10px]">
        {t("sofia.mem.indexado")}
      </Badge>
    );
  }
  if (item.indexStatus === "processing" || item.indexStatus === "pending") {
    return (
      <Badge variant="outline" className="border-amber-300 text-amber-700 bg-amber-50 gap-1 text-[10px]">
        <RefreshCw className="h-2.5 w-2.5 animate-spin" />
        {t("sofia.mem.processando")}
      </Badge>
    );
  }
  if (item.indexStatus === "error" || item.indexStatus === "failed") {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="border-rose-300 text-rose-700 bg-rose-50 gap-1 cursor-help text-[10px]">
              <AlertCircle className="h-2.5 w-2.5" />
              {t("sofia.mem.falhou")}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-xs">
            {item.errorMessage ?? t("sofia.mem.err_indexacao")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px]">
      {item.indexStatus}
    </Badge>
  );
}

function UploadDialog({ onSuccess }: { onSuccess: () => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useLang();
  const { authHeader } = useUserSession();

  const reset = () => {
    setFile(null);
    setTitle("");
    setUploading(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    if (f && !title) {
      const nameNoExt = f.name.replace(/\.[^.]+$/, "");
      setTitle(nameNoExt);
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (title.trim()) fd.append("title", title.trim());

      const res = await fetch(`${BASE}api/sofia/knowledge/upload`, {
        method: "POST",
        headers: { ...authHeader },
        body: fd,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }

      toast.success(t("sofia.mem.doc_enviado"));
      setOpen(false);
      reset();
      onSuccess();
    } catch (err) {
      toast.error(`${t("sofia.mem.err_enviar")}: ${err instanceof Error ? err.message : t("sofia.mem.desconhecido")}`);
    } finally {
      setUploading(false);
    }
  };

  const allowedLabel = ".md, .txt, .pdf";

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button className="gap-2 bg-sofia hover:bg-sofia/90 text-white">
          <Upload className="h-4 w-4" />
          {t("sofia.mem.enviar_doc")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Database className="h-4 w-4 text-sofia/80" />
            {t("sofia.mem.add_base")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div
            className="border-2 border-dashed border-border/50 rounded-xl p-8 text-center cursor-pointer hover:border-sofia/40 hover:bg-sofia/5 transition-colors"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files[0];
              if (f) {
                setFile(f);
                if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
              }
            }}
          >
            <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground/50" />
            {file ? (
              <div>
                <p className="font-medium text-sm text-foreground">{file.name}</p>
                <p className="text-xs text-muted-foreground mt-1">{formatBytes(file.size)}</p>
              </div>
            ) : (
              <div>
                <p className="text-sm text-muted-foreground">{t("sofia.mem.arrastar")}</p>
                <p className="text-xs text-muted-foreground/60 mt-1">{t("sofia.mem.formatos").replace("{f}", allowedLabel)}</p>
              </div>
            )}
            <input
              ref={inputRef}
              type="file"
              accept=".md,.txt,.pdf"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("sofia.mem.titulo_opcional")}</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("sofia.mem.nome_exibicao")}
              className="h-9 text-sm bg-muted/30 border-border/40"
            />
          </div>

          <div className="flex gap-3 justify-end pt-1">
            <Button variant="outline" onClick={() => setOpen(false)} className="border-border/50">
              {t("sofia.mem.cancelar")}
            </Button>
            <Button
              onClick={handleUpload}
              disabled={!file || uploading}
              className="gap-2 bg-sofia hover:bg-sofia/90 text-white"
            >
              {uploading ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  {t("sofia.mem.enviando")}
                </>
              ) : (
                <>
                  <Upload className="h-3.5 w-3.5" />
                  {t("sofia.mem.enviar")}
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Memoria() {
  const queryClient = useQueryClient();
  const { t, lang } = useLang();
  const numLocale = lang === "fr" ? "fr-FR" : "pt-BR";
  const dateLocale = lang === "fr" ? fr : ptBR;
  const { data: items, isLoading } = useListKnowledgeItems();

  const deleteMutation = useDeleteKnowledgeItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListKnowledgeItemsQueryKey() });
        toast.success(t("sofia.mem.doc_removido"));
      },
      onError: () => toast.error(t("sofia.mem.err_remover")),
    },
  });

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getListKnowledgeItemsQueryKey() });
  }, [queryClient]);

  const hasProcessing = items?.some(
    (i) => i.indexStatus === "processing" || i.indexStatus === "pending"
  );

  useEffect(() => {
    if (!hasProcessing) return;
    const id = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: getListKnowledgeItemsQueryKey() });
    }, 3000);
    return () => clearInterval(id);
  }, [hasProcessing, queryClient]);

  const indexedCount = items?.filter((i) => i.indexStatus === "indexed").length ?? 0;
  const totalChunks = items?.reduce((acc, i) => acc + (i.chunkCount ?? 0), 0) ?? 0;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("sofia.mem.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("sofia.mem.subtitle")}</p>
        </div>
        <UploadDialog onSuccess={refresh} />
      </div>

      {/* Stats strip */}
      {items && items.length > 0 && (
        <div className="flex gap-4 flex-wrap">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Database className="h-4 w-4 text-sofia/60" />
            <span><strong className="text-foreground">{items.length}</strong> {t("sofia.mem.documentos")}</span>
          </div>
          <div className="text-muted-foreground/40 text-sm">·</div>
          <div className="text-sm text-muted-foreground">
            <strong className="text-foreground">{indexedCount}</strong> {t("sofia.mem.indexados")}
          </div>
          <div className="text-muted-foreground/40 text-sm">·</div>
          <div className="text-sm text-muted-foreground">
            <strong className="text-foreground">{totalChunks.toLocaleString(numLocale)}</strong> {t("sofia.mem.chunks")}
          </div>
          <div className="text-muted-foreground/40 text-sm">·</div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge className="bg-emerald-500/15 text-emerald-700 border-emerald-200 hover:bg-emerald-500/15 gap-1.5 text-[10px] cursor-help">
                  <Sparkles className="h-2.5 w-2.5" />
                  {t("sofia.mem.modo_busca")}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs text-xs">
                {t("sofia.mem.modo_busca_tip")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {hasProcessing && (
            <>
              <div className="text-muted-foreground/40 text-sm">·</div>
              <div className="flex items-center gap-1.5 text-sm text-amber-600">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                {t("sofia.mem.indexando")}
              </div>
            </>
          )}
        </div>
      )}

      <Card className="shadow-sm border-border/50">
        <CardHeader className="pb-3 border-b border-border/30">
          <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground">
            {t("common.documentos")}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full rounded" />)}
            </div>
          ) : !items || items.length === 0 ? (
            <div className="py-16 text-center">
              <Database className="h-10 w-10 mx-auto mb-3 text-muted-foreground/25" />
              <p className="text-muted-foreground text-sm">{t("sofia.mem.nenhum_doc")}</p>
              <p className="text-muted-foreground/60 text-xs mt-1">{t("sofia.mem.envie_arquivos")}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs">{t("common.titulo")}</TableHead>
                  <TableHead className="text-xs w-16">{t("common.tipo_arquivo")}</TableHead>
                  <TableHead className="text-xs w-20 text-right">{t("common.tamanho")}</TableHead>
                  <TableHead className="text-xs w-20 text-right">{t("common.chunks")}</TableHead>
                  <TableHead className="text-xs w-32">{t("common.status")}</TableHead>
                  <TableHead className="text-xs w-28">{t("sofia.mem.col_data")}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id} className="group">
                    <TableCell className="font-medium text-sm">
                      <div className="flex items-center gap-2">
                        {fileTypeIcon(item.type)}
                        <span className="truncate max-w-[260px]" title={item.title}>
                          {item.title}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-[11px] text-muted-foreground uppercase">{item.type}</span>
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {item.fileSize ? formatBytes(item.fileSize) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {item.chunkCount != null ? (
                        <span className="font-mono text-xs text-foreground/80">{item.chunkCount}</span>
                      ) : (
                        <span className="text-muted-foreground/40 text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge item={item} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {item.createdAt
                        ? format(parseISO(item.createdAt), "dd/MM/yyyy", { locale: dateLocale })
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-rose-50 hover:text-rose-600"
                        disabled={deleteMutation.isPending}
                        onClick={() => {
                          if (confirm(`${t("sofia.mem.confirmar_remover")} "${item.title}"?`)) {
                            deleteMutation.mutate({ id: item.id });
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
