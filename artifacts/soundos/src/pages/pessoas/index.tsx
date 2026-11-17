import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Users, Search, ChevronUp, ChevronDown, ChevronsUpDown, Eye, Pencil,
  Archive, ArchiveRestore, UserX, UserCheck,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLang } from "@/contexts/language";
import { useUserSession } from "@/contexts/user-session";
import { toast } from "sonner";
import { formatDateBR } from "@/lib/date";

interface Pessoa {
  id: number;
  codigo: string;
  ativo: boolean;
  arquivadoEm: string | null;
  mergedIntoPessoaId?: number | null;
  nome: string;
  sobrenome: string | null;
  cpf: string | null;
  dataNascimento: string | null;
  sexo: string | null;
  email: string | null;
  celular: string | null;
  instagram: string | null;
  site: string | null;
  profissao: string | null;
  profissaoCategoria: string | null;
  enderecoRua: string | null;
  cidade: string | null;
  estadoUf: string | null;
  cep: string | null;
  servicoInteresse: string | null;
  comoFicouSabendo: string | null;
  qualAmigoParceiro: string | null;
  preferenciaContato: string | null;
  contatoPara: string | null;
  adicionarContato: string | null;
  aguaPresencial: string | null;
  fogoPresencial: string | null;
  workshopAgua: string | null;
  cacau: string | null;
  ayahuasca: string | null;
  concerto: string | null;
  zapPierre: string | null;
  idAlunoCliente: string | null;
  turma: string | null;
  conectadoProposito: string | null;
  buscaEspiritual: string | null;
  lugarMusicaSom: string | null;
  participouTrabalhoSom: string | null;
  qualTrabalhoSom: string | null;
  midiaInput: string | null;
  midiaInputOutro: string | null;
  terapeuta: string | null;
  formacaoMusicaTerapia: string | null;
  objetivoCurso: string | null;
  cursoProposito: string | null;
  cursoExpectativas: string | null;
  outroCurso: string | null;
  sentidoParticipar: string | null;
  experienciaAyahuasca: string | null;
  psicodelicosDrogas: string | null;
  traumaVida: string | null;
  ansioliticoAntidepressivos: string | null;
  problemaSaude: string | null;
  psicoterapiaPsiquiatria: string | null;
  sensacao: string | null;
  sensacaoPerseguido: string | null;
  covid: string | null;
  comprovanteCovid: string | null;
  createdAt: string;
  conversationCount?: number;
}

type SortKey =
  | "nome"
  | "codigo"
  | "email"
  | "celular"
  | "cidade"
  | "profissao"
  | "servicoInteresse"
  | "comoFicouSabendo"
  | "conversationCount"
  | "completion"
  | "createdAt";

type SortDir = "asc" | "desc";
type StatusFilter = "todos" | "ativos" | "inativos" | "arquivados";
type LifecycleAction = "arquivar" | "restaurar" | "inativar" | "reativar";

export const DEFAULT_PESSOAS_STATUS_FILTER: StatusFilter = "ativos";

const COMPLETION_FIELDS: (keyof Pessoa)[] = [
  "sobrenome", "cpf", "dataNascimento", "sexo", "email", "celular",
  "instagram", "site", "profissao", "profissaoCategoria",
  "enderecoRua", "cidade", "estadoUf", "cep",
  "servicoInteresse", "comoFicouSabendo", "qualAmigoParceiro", "preferenciaContato",
  "contatoPara", "adicionarContato",
  "aguaPresencial", "fogoPresencial", "workshopAgua", "cacau", "ayahuasca",
  "concerto", "zapPierre", "idAlunoCliente", "turma",
  "conectadoProposito", "buscaEspiritual", "lugarMusicaSom", "participouTrabalhoSom",
  "qualTrabalhoSom", "midiaInput", "midiaInputOutro", "terapeuta", "formacaoMusicaTerapia",
  "objetivoCurso", "cursoProposito", "cursoExpectativas", "outroCurso", "sentidoParticipar",
  "experienciaAyahuasca", "psicodelicosDrogas", "traumaVida", "ansioliticoAntidepressivos",
  "problemaSaude", "psicoterapiaPsiquiatria", "sensacao", "sensacaoPerseguido",
  "covid", "comprovanteCovid",
];

function calcCompletion(p: Pessoa): number {
  const filled = COMPLETION_FIELDS.filter(f => {
    const v = p[f];
    return v !== null && v !== undefined && v !== "";
  }).length;
  return Math.round((filled / COMPLETION_FIELDS.length) * 100);
}

function CompletionBar({ percent }: { percent: number }) {
  const color =
    percent >= 70 ? "bg-emerald-500" :
    percent >= 30 ? "bg-amber-400" :
    "bg-rose-400";
  const text =
    percent >= 70 ? "text-emerald-600" :
    percent >= 30 ? "text-amber-600" :
    "text-rose-500";

  return (
    <span className="flex items-center gap-1.5">
      <span className="w-14 h-1.5 rounded-full bg-muted overflow-hidden">
        <span className={`block h-full rounded-full ${color}`} style={{ width: `${percent}%` }} />
      </span>
      <span className={`text-[10px] font-semibold tabular-nums ${text}`}>{percent}%</span>
    </span>
  );
}

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (col !== sortKey) return <ChevronsUpDown className="h-3 w-3 opacity-30" />;
  return sortDir === "asc"
    ? <ChevronUp className="h-3 w-3 text-primary" />
    : <ChevronDown className="h-3 w-3 text-primary" />;
}

export default function PessoasList() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(DEFAULT_PESSOAS_STATUS_FILTER);
  const [confirmation, setConfirmation] = useState<{ pessoa: Pessoa; action: LifecycleAction } | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("nome");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [page, setPage] = useState(1);
  const { t, lang } = useLang();
  const PAGE_SIZE = 100;

  const COLUMNS: { key: SortKey; label: string; width?: string }[] = [
    { key: "nome",              label: t("common.nome"),      width: "w-[27%]" },
    { key: "codigo",            label: t("common.codigo"),    width: "w-[10%]" },
    { key: "email",             label: t("common.email"),     width: "w-[23%]" },
    { key: "celular",           label: t("common.celular"),   width: "w-[15%] hidden md:table-cell" },
    { key: "conversationCount", label: t("common.chats"),     width: "w-[8%] hidden sm:table-cell" },
    { key: "completion",        label: t("common.ficha"),     width: "w-[11%] hidden sm:table-cell" },
    { key: "createdAt",         label: t("common.cadastro"),  width: "w-[10%] hidden xl:table-cell" },
  ];

  const { authHeader } = useUserSession();

  const { data: pageData, isLoading } = useQuery<{
    items: Pessoa[];
    total: number;
    grandTotal: number;
    limit: number;
    offset: number;
  }>({
    queryKey: ["/api/pessoas", search, statusFilter, page, sortKey, sortDir],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
        sort: sortKey,
        direction: sortDir,
        includeTotal: "true",
      });
      if (search) params.set("search", search);
      if (statusFilter === "ativos") params.set("ativo", "true");
      if (statusFilter === "inativos") params.set("ativo", "false");
      if (statusFilter === "arquivados") params.set("arquivado", "true");
      const res = await fetch(`/api/pessoas?${params}`, { headers: { ...authHeader } });
      if (!res.ok) throw new Error("Erro ao carregar pessoas");
      return res.json();
    },
  });
  const pessoas = pageData?.items ?? [];
  const total = pageData?.total ?? 0;
  const grandTotal = pageData?.grandTotal ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstItem = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastItem = Math.min(page * PAGE_SIZE, total);

  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
  }, [search, statusFilter, sortKey, sortDir]);

  useEffect(() => {
    if (!isLoading && page > totalPages) setPage(totalPages);
    setSelectedIds(new Set());
  }, [isLoading, page, totalPages]);

  const lifecycleMutation = useMutation({
    mutationFn: async ({ pessoa, action }: { pessoa: Pessoa; action: LifecycleAction }) => {
      const res = await fetch(`/api/pessoas/${pessoa.id}/${action}`, {
        method: "PATCH",
        headers: { ...authHeader },
      });
      if (!res.ok) throw new Error("Erro ao alterar pessoa");
      return res.json() as Promise<Pessoa>;
    },
    onSuccess: (_pessoa, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/pessoas"] });
      setConfirmation(null);
      toast.success(t(`pessoas.action_${variables.action}_ok`));
    },
    onError: () => toast.error(t("pessoas.action_error")),
  });

  const bulkArchiveMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const res = await fetch(`/api/pessoas/batch/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error("Erro ao arquivar pessoas em lote");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/pessoas"] });
      setBulkConfirm(false);
      setSelectedIds(new Set());
      toast.success(t("pessoas.bulk_archive_success").replace("{count}", data.archivedCount?.toString() ?? "0"));
    },
    onError: () => toast.error(t("pessoas.action_error")),
  });

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const toggleSelectAll = () => {
    if (pessoas.length === 0) return;
    const selectable = pessoas.filter(p => !p.arquivadoEm).map(p => p.id);
    if (selectable.length === 0) return;
    
    const allSelected = selectable.every(id => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectable));
    }
  };

  const toggleSelectOne = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  return (
    <div className="space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground mb-0.5 flex items-center gap-2">
            <Users className="h-7 w-7 text-primary" />
            {t("pessoas.title")}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t("pessoas.subtitle")}
          </p>
        </div>
        <Badge variant="secondary" className="text-xs px-2.5 py-1">
          {grandTotal.toLocaleString(lang === "fr" ? "fr-FR" : "pt-BR")} {t("pessoas.pessoas")}
        </Badge>
      </div>

      {selectedIds.size > 0 && (
        <Card className="shadow-sm border-primary/20 bg-primary/5">
          <CardContent className="p-3 flex items-center justify-between">
            <span className="text-sm font-medium text-primary">
              {selectedIds.size} {selectedIds.size === 1 ? t("pessoas.pessoa") : t("pessoas.pessoas")} selecionadas
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelectedIds(new Set())}
                disabled={bulkArchiveMutation.isPending}
              >
                {t("common.cancelar")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setBulkConfirm(true)}
                disabled={bulkArchiveMutation.isPending}
              >
                <Archive className="h-4 w-4 mr-2" />
                {t("pessoas.bulk_archive")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="shadow-sm border-border/50">
        <CardHeader className="pb-2 pt-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t("pessoas.buscar")}
                className="pl-9"
              />
            </div>
            <Select value={statusFilter} onValueChange={value => setStatusFilter(value as StatusFilter)}>
              <SelectTrigger className="w-full sm:w-[180px]" aria-label={t("pessoas.filtro_status")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">{t("pessoas.status_todos")}</SelectItem>
                <SelectItem value="ativos">{t("pessoas.status_ativos")}</SelectItem>
                <SelectItem value="inativos">{t("pessoas.status_inativos")}</SelectItem>
                <SelectItem value="arquivados">{t("pessoas.status_arquivados")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 bg-primary rounded-full animate-bounce" />
                <span className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:0.2s]" />
                <span className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:0.4s]" />
              </div>
            </div>
          ) : pessoas.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
              <Users className="h-12 w-12 opacity-20" />
              <p className="text-sm">
                {search ? t("pessoas.nenhuma_busca") : t("pessoas.nenhuma")}
              </p>
            </div>
          ) : (
            <div className="w-full overflow-hidden">
              <table className="w-full table-fixed text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border/60 bg-muted/30">
                    <th className="w-10 px-3 py-2 text-left">
                      <Checkbox
                        checked={pessoas.length > 0 && selectedIds.size === pessoas.length}
                        onCheckedChange={toggleSelectAll}
                        aria-label="Select all"
                        data-testid="checkbox-select-all"
                      />
                    </th>
                    {COLUMNS.map(col => (
                      <th
                        key={col.key}
                        onClick={() => handleSort(col.key)}
                        className={`px-2 py-2 text-left font-medium text-muted-foreground text-[11px] uppercase tracking-wide cursor-pointer select-none whitespace-nowrap hover:text-foreground hover:bg-muted/50 transition-colors ${col.width ?? ""}`}
                      >
                        <span className="flex items-center gap-1">
                          {col.label}
                          <SortIcon col={col.key} sortKey={sortKey} sortDir={sortDir} />
                        </span>
                      </th>
                    ))}
                    <th className="w-[126px] px-2 py-2 text-right font-medium text-muted-foreground text-[11px] uppercase tracking-wide whitespace-nowrap">
                      {t("common.acoes")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                   {pessoas.map(p => {
                    const pct = calcCompletion(p);
                    const chats = p.conversationCount ?? 0;

                    return (
                      <tr
                        key={p.id}
                        onClick={() => navigate(`/pessoas/${p.id}`)}
                        className="cursor-pointer hover:bg-muted/40 transition-colors group"
                      >
                        <td className="px-3 py-1.5" onClick={e => e.stopPropagation()}>
                          <Checkbox
                            checked={selectedIds.has(p.id)}
                            onCheckedChange={() => toggleSelectOne(p.id)}
                            disabled={!!p.arquivadoEm}
                            aria-label={`Select ${p.nome}`}
                            data-testid={`checkbox-select-pessoa-${p.id}`}
                          />
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap overflow-hidden text-ellipsis">
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                              <span className="text-primary font-semibold text-xs">
                                {(p.nome[0] ?? "?").toUpperCase()}
                              </span>
                            </div>
                            <div className="min-w-0">
                              <span className="font-medium text-foreground">
                                {p.nome}{p.sobrenome ? ` ${p.sobrenome}` : ""}
                              </span>
                              {!p.ativo && (
                                <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">
                                  {t("common.inativo")}
                                </Badge>
                              )}
                              {p.arquivadoEm && (
                                <Badge variant="outline" className="ml-1.5 text-[10px] px-1.5 py-0">
                                  {t("common.arquivado")}
                                </Badge>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap overflow-hidden text-ellipsis">
                          <span className="text-xs font-mono text-muted-foreground">{p.codigo}</span>
                        </td>
                        <td className="px-2 py-1.5 overflow-hidden">
                          <span className="text-xs text-muted-foreground truncate block">{p.email ?? "—"}</span>
                        </td>
                        <td className="hidden md:table-cell px-2 py-1.5 whitespace-nowrap overflow-hidden text-ellipsis">
                          <span className="text-xs text-muted-foreground truncate block">{p.celular ?? "—"}</span>
                        </td>
                        <td className="hidden sm:table-cell px-2 py-1.5 whitespace-nowrap text-center">
                          <span className="text-xs font-medium text-foreground">{chats}</span>
                        </td>
                        <td className="hidden sm:table-cell px-2 py-1.5 whitespace-nowrap">
                          <CompletionBar percent={pct} />
                        </td>
                        <td className="hidden xl:table-cell px-2 py-1.5 whitespace-nowrap">
                          <span className="text-xs text-muted-foreground">{formatDateBR(p.createdAt)}</span>
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          <div className="flex items-center justify-end gap-0">
                            <ActionIcon label={t("common.ver")} onClick={() => navigate(`/pessoas/${p.id}`)}>
                              <Eye className="h-4 w-4" />
                            </ActionIcon>
                            <ActionIcon label={t("common.editar")} onClick={() => navigate(`/pessoas/${p.id}?edit=1`)}>
                              <Pencil className="h-4 w-4" />
                            </ActionIcon>
                            <ActionIcon
                              label={p.arquivadoEm ? t("common.restaurar") : t("common.arquivar")}
                              onClick={() => setConfirmation({ pessoa: p, action: p.arquivadoEm ? "restaurar" : "arquivar" })}
                            >
                              {p.arquivadoEm ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                            </ActionIcon>
                            <ActionIcon
                              label={p.ativo ? t("common.inativar") : t("common.reativar")}
                              onClick={() => setConfirmation({ pessoa: p, action: p.ativo ? "inativar" : "reativar" })}
                            >
                              {p.ativo ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                            </ActionIcon>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      {total > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>
            {t("pessoas.mostrando")} {firstItem.toLocaleString(lang === "fr" ? "fr-FR" : "pt-BR")}–{lastItem.toLocaleString(lang === "fr" ? "fr-FR" : "pt-BR")} {t("pessoas.de")} {total.toLocaleString(lang === "fr" ? "fr-FR" : "pt-BR")}
            {search || statusFilter !== "todos" ? ` · ${grandTotal.toLocaleString(lang === "fr" ? "fr-FR" : "pt-BR")} ${t("pessoas.total_cadastradas")}` : ""}
          </span>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" className="h-8 px-2.5" disabled={page <= 1 || isLoading} onClick={() => setPage(p => p - 1)}>
              {t("common.anterior")}
            </Button>
            <span className="tabular-nums whitespace-nowrap">
              {t("pessoas.pagina")} {page} {t("pessoas.de")} {totalPages}
            </span>
            <Button variant="outline" size="sm" className="h-8 px-2.5" disabled={page >= totalPages || isLoading} onClick={() => setPage(p => p + 1)}>
              {t("common.proximo")}
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={confirmation !== null} onOpenChange={open => { if (!open && !lifecycleMutation.isPending) setConfirmation(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation ? t(`pessoas.confirm_${confirmation.action}_title`) : ""}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation
                ? t(`pessoas.confirm_${confirmation.action}_description`).replace(
                    "{name}",
                    `${confirmation.pessoa.nome}${confirmation.pessoa.sobrenome ? ` ${confirmation.pessoa.sobrenome}` : ""}`,
                  )
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={lifecycleMutation.isPending}>{t("common.cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={lifecycleMutation.isPending || !confirmation}
              onClick={event => {
                event.preventDefault();
                if (confirmation) lifecycleMutation.mutate(confirmation);
              }}
            >
              {lifecycleMutation.isPending ? t("common.salvando") : t("common.confirmar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={bulkConfirm} onOpenChange={open => { if (!open && !bulkArchiveMutation.isPending) setBulkConfirm(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pessoas.bulk_archive")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("pessoas.bulk_archive_confirm").replace("{count}", selectedIds.size.toString())}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkArchiveMutation.isPending}>{t("common.cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
              disabled={bulkArchiveMutation.isPending}
              onClick={event => {
                event.preventDefault();
                bulkArchiveMutation.mutate(Array.from(selectedIds));
              }}
              data-testid="button-confirm-bulk-archive"
            >
              {bulkArchiveMutation.isPending ? t("common.salvando") : t("common.confirmar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ActionIcon({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          aria-label={label}
          onClick={event => {
            event.stopPropagation();
            onClick();
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
