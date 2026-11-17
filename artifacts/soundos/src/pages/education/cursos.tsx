import { useCallback, useEffect, useState } from "react";
import { formatDateBR } from "@/lib/date";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { type CursoInscricao as ApiCursoInscricao } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  Plus,
  Pencil,
  Copy,
  Check,
  X,
  Link as LinkIcon,
  CalendarDays,
  MapPin,
  Archive,
  ArchiveRestore,
  BookOpen,
  Users,
  Eye,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ClipboardList,
  Search,
  Trash2,
} from "lucide-react";
import { useLang } from "@/contexts/language";
import { useUserSession } from "@/contexts/user-session";
import { useAccess } from "@/contexts/access";
import { Link } from "wouter";

// ── Types ────────────────────────────────────────────────────────

type CursoInscricao = ApiCursoInscricao & { inscritosCount: number; classId: number | null };
type EventSortKey = "nome" | "nucleo" | "tipoEvento" | "dataInicio" | "local" | "inscritosCount" | "ativo";
type SortDirection = "asc" | "desc";
type EventColumnWidths = Record<EventSortKey, number>;

const EVENT_COLUMN_KEYS: EventSortKey[] = [
  "nome", "nucleo", "tipoEvento", "dataInicio", "local", "inscritosCount", "ativo",
];
const EVENT_COLUMN_WIDTHS: EventColumnWidths = {
  nome: 340,
  nucleo: 140,
  tipoEvento: 125,
  dataInicio: 180,
  local: 160,
  inscritosCount: 115,
  ativo: 110,
};
const EVENT_COLUMN_MIN_WIDTHS: EventColumnWidths = {
  nome: 180,
  nucleo: 105,
  tipoEvento: 95,
  dataInicio: 145,
  local: 110,
  inscritosCount: 95,
  ativo: 85,
};
const EVENT_COLUMN_STORAGE_KEY = "soundos.education.event-column-widths.v1";
const EVENT_SELECTION_COLUMN_WIDTH = 40;
const EVENT_ACTIONS_COLUMN_WIDTH = 160;

function loadEventColumnWidths(): EventColumnWidths {
  try {
    const stored = JSON.parse(localStorage.getItem(EVENT_COLUMN_STORAGE_KEY) ?? "{}") as Partial<EventColumnWidths>;
    return Object.fromEntries(EVENT_COLUMN_KEYS.map(key => {
      const value = stored[key];
      return [key, typeof value === "number" && Number.isFinite(value)
        ? Math.max(EVENT_COLUMN_MIN_WIDTHS[key], Math.min(600, Math.round(value)))
        : EVENT_COLUMN_WIDTHS[key]];
    })) as EventColumnWidths;
  } catch {
    return { ...EVENT_COLUMN_WIDTHS };
  }
}

interface Inscrito {
  pessoaId: number;
  nome: string;
  sobrenome: string | null;
  email: string | null;
  celular: string | null;
  inscritoEm: string;
}

const emptyInscricaoForm = {
  nucleo: "EDUCATION" as CursoInscricao["nucleo"],
  tipoEvento: "CURSO" as CursoInscricao["tipoEvento"],
  nome: "",
  descricao: "",
  local: "",
  dataInicio: "",
  dataFim: "",
  observacoes: "",
};

const EVENT_TYPE_LABELS: Record<CursoInscricao["tipoEvento"], string> = {
  CURSO: "Curso",
  WORKSHOP: "Workshops",
  CONCERTO: "Concerto",
  VIVENCIA: "Vivência",
  RETIRO: "Retiro",
  CERIMONIA: "Cerimônia",
  OUTRO: "Outro",
};

const EVENT_TYPE_LABELS_FR: Record<CursoInscricao["tipoEvento"], string> = {
  CURSO: "Cours",
  WORKSHOP: "Atelier",
  CONCERTO: "Concert",
  VIVENCIA: "Expérience",
  RETIRO: "Retraite",
  CERIMONIA: "Cérémonie",
  OUTRO: "Autre",
};

const EXPERIENCES_TYPES = new Set<CursoInscricao["tipoEvento"]>([
  "WORKSHOP", "CONCERTO", "VIVENCIA", "RETIRO", "CERIMONIA",
]);

function getPublicUrl(slug: string) {
  return `${window.location.origin}/inscricao/${slug}`;
}

const TEST_EVENT_MARKER = /(^|[^a-z0-9])(e2e|test|teste|fixture|qa)(?=$|[^a-z0-9])/i;
const TEST_CASCADE_CONFIRMATION = "123mudar";

function isTestEvent(event: CursoInscricao): boolean {
  return TEST_EVENT_MARKER.test(event.nome) && TEST_EVENT_MARKER.test(event.slug);
}

function compareEventValues(
  a: CursoInscricao,
  b: CursoInscricao,
  key: EventSortKey,
  direction: SortDirection,
): number {
  const multiplier = direction === "asc" ? 1 : -1;
  const aValue = key === "ativo" ? (a.ativo ? 1 : 0) : a[key];
  const bValue = key === "ativo" ? (b.ativo ? 1 : 0) : b[key];
  if (aValue === null || aValue === "") return bValue === null || bValue === "" ? a.id - b.id : 1;
  if (bValue === null || bValue === "") return -1;
  const comparison = typeof aValue === "number" && typeof bValue === "number"
    ? aValue - bValue
    : String(aValue).localeCompare(String(bValue), "pt-BR", { numeric: true, sensitivity: "base" });
  return comparison === 0 ? (a.id - b.id) * multiplier : comparison * multiplier;
}

// ── Inscricao form ───────────────────────────────────────────────

function InscricaoForm({
  initial,
  onSave,
  onCancel,
  isPending,
}: {
  initial: typeof emptyInscricaoForm;
  onSave: (data: typeof emptyInscricaoForm) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const { lang } = useLang();
  const typeLabels = lang === "fr" ? EVENT_TYPE_LABELS_FR : EVENT_TYPE_LABELS;
  const [form, setForm] = useState(initial);
  const set =
    (k: keyof typeof emptyInscricaoForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="space-y-3 bg-muted/30 rounded-lg p-4 border border-border/40">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">{lang === "fr" ? "Noyau *" : "Núcleo *"}</Label>
          <Select
            value={form.nucleo}
            onValueChange={(value) => setForm((f) => ({ ...f, nucleo: value as CursoInscricao["nucleo"] }))}
          >
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="EDUCATION">Education</SelectItem>
              <SelectItem value="EXPERIENCES">Experiences</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">{lang === "fr" ? "Type *" : "Tipo *"}</Label>
          <Select
            value={form.tipoEvento}
            onValueChange={(value) => {
              const tipoEvento = value as CursoInscricao["tipoEvento"];
              setForm((f) => ({
                ...f,
                tipoEvento,
                nucleo: tipoEvento === "CURSO"
                  ? "EDUCATION"
                  : EXPERIENCES_TYPES.has(tipoEvento) ? "EXPERIENCES" : f.nucleo,
              }));
            }}
          >
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(typeLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="col-span-2 text-[11px] text-muted-foreground">
          {lang === "fr"
            ? "Les cours relèvent principalement d'Education. Les ateliers, concerts, expériences, retraites et cérémonies relèvent principalement d'Experiences."
            : "Cursos pertencem primariamente a Education. Workshops, concertos, vivências, retiros e cerimônias pertencem primariamente a Experiences."}
        </p>
        <div className="col-span-2 space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">{lang === "fr" ? "Nom de l'événement *" : "Nome do evento *"}</Label>
          <Input value={form.nome} onChange={set("nome")} placeholder={lang === "fr" ? "Ex. Atelier de Sound Healing — Paris" : "Ex: Workshop de Sound Healing — SP"} className="h-8 text-sm" />
        </div>
        <div className="col-span-2 space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">{lang === "fr" ? "Description publique" : "Descrição pública"}</Label>
          <Textarea value={form.descricao} onChange={set("descricao")} placeholder={lang === "fr" ? "Texte affiché sur le formulaire d'inscription" : "Texto exibido no formulário de inscrição"} className="text-sm min-h-[50px] resize-none" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">{lang === "fr" ? "Lieu" : "Local"}</Label>
          <Input value={form.local} onChange={set("local")} placeholder={lang === "fr" ? "Ex. Paris" : "Ex: São Paulo — SP"} className="h-8 text-sm" />
        </div>
        <div />
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">{lang === "fr" ? "Date de début" : "Data início"}</Label>
          <Input type="date" value={form.dataInicio} onChange={set("dataInicio")} className="h-8 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">{lang === "fr" ? "Date de fin" : "Data fim"}</Label>
          <Input type="date" value={form.dataFim} onChange={set("dataFim")} className="h-8 text-sm" />
        </div>
        <div className="col-span-2 space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">{lang === "fr" ? "Notes internes" : "Observações internas"}</Label>
          <Textarea value={form.observacoes} onChange={set("observacoes")} placeholder={lang === "fr" ? "Notes visibles uniquement par l'équipe" : "Notas visíveis só para o staff"} className="text-sm min-h-[40px] resize-none" />
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>
          <X className="h-3.5 w-3.5 mr-1" /> {lang === "fr" ? "Annuler" : "Cancelar"}
        </Button>
        <Button size="sm" className="h-8" onClick={() => onSave(form)} disabled={!form.nome.trim() || isPending}>
          <Check className="h-3.5 w-3.5 mr-1" /> {lang === "fr" ? "Enregistrer" : "Salvar"}
        </Button>
      </div>
    </div>
  );
}

// ── Inscritos dialog ─────────────────────────────────────────────

function InscritosDialog({
  inscricao,
  open,
  onClose,
}: {
  inscricao: CursoInscricao;
  open: boolean;
  onClose: () => void;
}) {
  const { authHeader } = useUserSession();
  const { lang } = useLang();

  const { data, isLoading } = useQuery<{ count: number; inscritos: Inscrito[] }>({
    queryKey: ["/api/cursos-inscricao", inscricao.id, "inscritos"],
    queryFn: async () => {
      const r = await fetch(`/api/cursos-inscricao/${inscricao.id}/inscritos`, { headers: authHeader });
      if (!r.ok) throw new Error("Erro ao carregar inscritos");
      return r.json();
    },
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{lang === "fr" ? "Inscrits" : "Inscritos"} — {inscricao.nome}</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="space-y-2 py-2">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        ) : !data || data.inscritos.length === 0 ? (
          <div className="py-8 text-center">
            <Users className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              {lang === "fr" ? "Aucune inscription enregistrée." : "Nenhuma inscrição registrada ainda."}
            </p>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground mb-2">
              {data.count} {lang === "fr"
                ? (data.count === 1 ? "personne inscrite" : "personnes inscrites")
                : (data.count === 1 ? "pessoa inscrita" : "pessoas inscritas")}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{lang === "fr" ? "Nom" : "Nome"}</TableHead>
                  <TableHead className="text-xs">{lang === "fr" ? "Contact" : "Contato"}</TableHead>
                  <TableHead className="text-xs text-right">{lang === "fr" ? "Date" : "Data"}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.inscritos.map((p) => (
                  <TableRow key={p.pessoaId}>
                    <TableCell className="text-sm py-2">
                      <a
                        href={`/pessoas/${p.pessoaId}`}
                        className="hover:underline text-foreground"
                        title={lang === "fr" ? "Ouvrir la fiche" : "Abrir ficha"}
                      >
                        {p.nome}{p.sobrenome ? ` ${p.sobrenome}` : ""}
                      </a>
                    </TableCell>
                    <TableCell className="py-2">
                      <div className="flex flex-col gap-0.5">
                        {p.email && (
                          <a
                            href={`/pessoas/${p.pessoaId}`}
                            className="text-xs text-primary hover:underline truncate max-w-[160px]"
                            title={p.email}
                          >
                            {p.email}
                          </a>
                        )}
                        {p.celular && (
                          <span className="text-xs text-muted-foreground">{p.celular}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground text-right py-2">
                      {formatDateBR(p.inscritoEm)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Inscricoes tab ───────────────────────────────────────────────

export function EventosTable() {
  const qc = useQueryClient();
  const { authHeader } = useUserSession();
  const { lang } = useLang();
  const typeLabels = lang === "fr" ? EVENT_TYPE_LABELS_FR : EVENT_TYPE_LABELS;
  const { isAdmin: canManage } = useAccess();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(emptyInscricaoForm);
  const [archiveTarget, setArchiveTarget] = useState<CursoInscricao | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [cascadeDialogOpen, setCascadeDialogOpen] = useState(false);
  const [cascadeConfirmation, setCascadeConfirmation] = useState("");
  const [selectedEventIds, setSelectedEventIds] = useState<Set<number>>(() => new Set());
  const [searchName, setSearchName] = useState("");
  const [nucleoFilter, setNucleoFilter] = useState("TODOS");
  const [tipoFilter, setTipoFilter] = useState("TODOS");
  const [showArchived, setShowArchived] = useState(false);
  const [columnWidths, setColumnWidths] = useState<EventColumnWidths>(loadEventColumnWidths);
  const [sort, setSort] = useState<{ key: EventSortKey; direction: SortDirection }>({
    key: "dataInicio",
    direction: "desc",
  });

  useEffect(() => {
    localStorage.setItem(EVENT_COLUMN_STORAGE_KEY, JSON.stringify(columnWidths));
  }, [columnWidths]);

  const qKey = ["/api/cursos-inscricao"];

  const { data: inscricoes = [], isLoading } = useQuery<CursoInscricao[]>({
    queryKey: qKey,
    queryFn: async () => {
      const r = await fetch("/api/cursos-inscricao", { headers: authHeader });
      if (!r.ok) throw new Error("Erro ao carregar links");
      return r.json();
    },
  });
  const inscricoesVisiveis = inscricoes
    .filter((item) =>
      (showArchived || item.ativo)
      && (nucleoFilter === "TODOS" || item.nucleo === nucleoFilter)
      && (tipoFilter === "TODOS" || item.tipoEvento === tipoFilter)
      && item.nome.toLocaleLowerCase().includes(searchName.trim().toLocaleLowerCase())
    )
    .sort((a, b) => compareEventValues(a, b, sort.key, sort.direction));
  const selectedEvents = inscricoes.filter(item => selectedEventIds.has(item.id));
  const selectedAreTestEvents = selectedEvents.length > 0 && selectedEvents.every(isTestEvent);
  const selectedContainTestEvents = selectedEvents.some(isTestEvent);
  const tableWidth = EVENT_COLUMN_KEYS.reduce((total, key) => total + columnWidths[key], 0)
    + (canManage ? EVENT_SELECTION_COLUMN_WIDTH : 0)
    + EVENT_ACTIONS_COLUMN_WIDTH;
  const allVisibleSelected = inscricoesVisiveis.length > 0
    && inscricoesVisiveis.every(item => selectedEventIds.has(item.id));

  const resizeColumn = useCallback((key: EventSortKey, width: number) => {
    setColumnWidths(current => ({
      ...current,
      [key]: Math.max(EVENT_COLUMN_MIN_WIDTHS[key], Math.min(600, Math.round(width))),
    }));
  }, []);

  const toggleSort = (key: EventSortKey) => {
    setSort(current => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" });
  };

  const sortableHead = (
    key: EventSortKey,
    label: string,
    className?: string,
  ) => {
    const active = sort.key === key;
    const Icon = !active ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
    const width = columnWidths[key];
    const startResize = (clientX: number) => {
      const initialWidth = width;
      const move = (event: PointerEvent) => resizeColumn(key, initialWidth + event.clientX - clientX);
      const stop = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", stop);
        document.removeEventListener("pointercancel", stop);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", stop);
      document.addEventListener("pointercancel", stop);
    };
    return (
      <TableHead
        className={`relative px-2 ${className ?? ""}`}
        aria-sort={!active ? "none" : sort.direction === "asc" ? "ascending" : "descending"}
        style={{ width }}
      >
        <button
          type="button"
          onClick={() => toggleSort(key)}
          className={`flex w-full items-center gap-1.5 py-2 font-medium hover:text-foreground ${className?.includes("text-center") ? "justify-center" : ""}`}
          aria-label={`${lang === "fr" ? "Trier par" : "Ordenar por"} ${label}`}
        >
          <span className="truncate" title={label}>{label}</span>
          <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? "text-primary" : "text-muted-foreground/60"}`} />
        </button>
        <button
          type="button"
          className="absolute inset-y-0 right-0 z-20 w-2 translate-x-1/2 cursor-col-resize touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary after:absolute after:inset-y-2 after:left-1/2 after:w-px after:bg-border hover:after:bg-primary"
          aria-label={`${lang === "fr" ? "Redimensionner la colonne" : "Redimensionar coluna"} ${label}`}
          title={lang === "fr" ? "Faire glisser pour redimensionner, double-cliquer pour réinitialiser" : "Arraste para redimensionar; duplo clique restaura o padrão"}
          data-testid={`events-resize-${key}`}
          onPointerDown={event => {
            event.preventDefault();
            event.stopPropagation();
            startResize(event.clientX);
          }}
          onDoubleClick={() => resizeColumn(key, EVENT_COLUMN_WIDTHS[key])}
          onKeyDown={event => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              resizeColumn(key, width + (event.key === "ArrowRight" ? 10 : -10));
            }
          }}
        />
      </TableHead>
    );
  };

  const createM = useMutation({
    mutationFn: async (data: typeof emptyInscricaoForm) => {
      const r = await fetch("/api/cursos-inscricao", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ ...data, courseId: null }),
      });
      if (!r.ok) throw new Error("create event failed");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qKey });
      setCreating(false);
      toast.success(lang === "fr" ? "Événement créé" : "Evento criado");
    },
    onError: () => toast.error(lang === "fr" ? "Impossible de créer l'événement" : "Erro ao criar evento"),
  });

  const updateM = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: typeof emptyInscricaoForm }) => {
      const r = await fetch(`/api/cursos-inscricao/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qKey });
      setEditingId(null);
      toast.success(lang === "fr" ? "Événement mis à jour" : "Evento atualizado");
    },
    onError: () => toast.error(lang === "fr" ? "Impossible de mettre à jour l'événement" : "Erro ao atualizar evento"),
  });

  const toggleM = useMutation({
    mutationFn: async ({ id, ativo }: { id: number; ativo: boolean }) => {
      const r = await fetch(`/api/cursos-inscricao/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ ativo }),
      });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: qKey });
      setArchiveTarget(null);
      toast.success(
        variables.ativo
          ? (lang === "fr" ? "Événement restauré" : "Evento restaurado")
          : (lang === "fr" ? "Événement archivé" : "Evento arquivado"),
      );
    },
    onError: () => toast.error(lang === "fr" ? "Impossible de modifier le statut" : "Erro ao alterar status"),
  });

  const deleteM = useMutation({
    mutationFn: async (ids: number[]) => {
      const r = await fetch("/api/cursos-inscricao/bulk-delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ ids }),
      });
      const payload = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(payload.error ?? (lang === "fr" ? "Impossible de supprimer les événements" : "Não foi possível excluir os eventos"));
      }
      return payload as { deletedCount: number };
    },
    onSuccess: ({ deletedCount }) => {
      qc.invalidateQueries({ queryKey: qKey });
      setSelectedEventIds(new Set());
      setDeleteDialogOpen(false);
      toast.success(lang === "fr" ? `${deletedCount} événement(s) supprimé(s)` : `${deletedCount} evento(s) excluído(s)`);
    },
    onError: (error) => toast.error(error.message),
  });

  const cascadeDeleteM = useMutation({
    mutationFn: async ({ ids, confirmation }: { ids: number[]; confirmation: string }) => {
      const r = await fetch("/api/cursos-inscricao/bulk-cascade-test-delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ ids, confirmation }),
      });
      const payload = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(payload.error ?? (lang === "fr" ? "Impossible de supprimer les tests" : "Não foi possível excluir os testes"));
      }
      return payload as {
        deletedEventCount: number;
        deletedClassCount: number;
        deletedCourseCount: number;
        deletedEnrollmentCount: number;
      };
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: qKey });
      setSelectedEventIds(new Set());
      setCascadeConfirmation("");
      setCascadeDialogOpen(false);
      toast.success(
        lang === "fr"
          ? `${result.deletedEventCount} événement(s) et ${result.deletedEnrollmentCount} inscription(s) de test supprimés`
          : `${result.deletedEventCount} evento(s) e ${result.deletedEnrollmentCount} matrícula(s) de teste excluídos`,
      );
    },
    onError: (error) => toast.error(error.message),
  });

  const toggleEventSelection = (id: number, checked: boolean) => {
    setSelectedEventIds(current => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleVisibleSelection = (checked: boolean) => {
    setSelectedEventIds(current => {
      const next = new Set(current);
      for (const item of inscricoesVisiveis) {
        if (checked) next.add(item.id);
        else next.delete(item.id);
      }
      return next;
    });
  };

  const startEdit = (ci: CursoInscricao) => {
    setEditingId(ci.id);
    setEditForm({
      nome: ci.nome,
      descricao: ci.descricao ?? "",
      local: ci.local ?? "",
      dataInicio: ci.dataInicio ?? "",
      dataFim: ci.dataFim ?? "",
      observacoes: ci.observacoes ?? "",
      nucleo: ci.nucleo,
      tipoEvento: ci.tipoEvento,
    });
  };

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        {lang === "fr" ? "Chargement..." : "Carregando..."}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {lang === "fr"
            ? "Événements et expériences proposés par l'écosystème."
            : "Eventos e experiências oferecidos pelo ecossistema."}
        </p>
        {canManage && (
          <Button size="sm" className="h-7 text-xs" onClick={() => { setCreating(true); setEditingId(null); }} disabled={creating}>
            <Plus className="h-3.5 w-3.5 mr-1" /> {lang === "fr" ? "Nouvel événement" : "Novo evento"}
          </Button>
        )}
      </div>

      {inscricoes.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchName}
              onChange={(event) => {
                setSearchName(event.target.value);
                setSelectedEventIds(new Set());
              }}
              placeholder={lang === "fr" ? "Rechercher un événement" : "Buscar por nome"}
              aria-label={lang === "fr" ? "Rechercher un événement par nom" : "Buscar evento por nome"}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Select value={nucleoFilter} onValueChange={(value) => { setNucleoFilter(value); setSelectedEventIds(new Set()); }}>
            <SelectTrigger className="h-8 w-[180px] text-xs">
              <SelectValue placeholder={lang === "fr" ? "Tous les noyaux" : "Todos os núcleos"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="TODOS">{lang === "fr" ? "Tous les noyaux" : "Todos os núcleos"}</SelectItem>
              <SelectItem value="EDUCATION">Education</SelectItem>
              <SelectItem value="EXPERIENCES">Experiences</SelectItem>
            </SelectContent>
          </Select>
          <Select value={tipoFilter} onValueChange={(value) => { setTipoFilter(value); setSelectedEventIds(new Set()); }}>
            <SelectTrigger className="h-8 w-[180px] text-xs">
              <SelectValue placeholder={lang === "fr" ? "Tous les types" : "Todos os tipos"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="TODOS">{lang === "fr" ? "Tous les types" : "Todos os tipos"}</SelectItem>
              {Object.entries(typeLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex h-8 items-center gap-2 rounded-md border px-3">
            <Switch
              id="show-archived-events"
              checked={showArchived}
              onCheckedChange={(checked) => { setShowArchived(checked); setSelectedEventIds(new Set()); }}
              className="scale-90"
            />
            <Label htmlFor="show-archived-events" className="cursor-pointer whitespace-nowrap text-xs font-normal">
              {lang === "fr" ? "Afficher les archivés" : "Mostrar arquivados"}
            </Label>
          </div>
          {canManage && selectedEventIds.size > 0 && (
            selectedAreTestEvents ? (
              <Button
                size="sm"
                variant="destructive"
                className="h-8 text-xs"
                onClick={() => { setCascadeConfirmation(""); setCascadeDialogOpen(true); }}
                disabled={cascadeDeleteM.isPending}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                {lang === "fr" ? `Supprimer les tests (${selectedEventIds.size})` : `Excluir testes em cascata (${selectedEventIds.size})`}
              </Button>
            ) : selectedContainTestEvents ? (
              <span className="px-2 text-xs text-muted-foreground">
                {lang === "fr" ? "Séparez les tests des événements réels." : "Separe testes dos eventos reais para excluir."}
              </span>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                className="h-8 text-xs"
                onClick={() => setDeleteDialogOpen(true)}
                disabled={deleteM.isPending}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                {lang === "fr" ? `Supprimer (${selectedEventIds.size})` : `Excluir selecionados (${selectedEventIds.size})`}
              </Button>
            )
          )}
        </div>
      )}

      {creating && (
        <InscricaoForm
          initial={emptyInscricaoForm}
          onSave={(data) => createM.mutate(data)}
          onCancel={() => setCreating(false)}
          isPending={createM.isPending}
        />
      )}

      {inscricoesVisiveis.length === 0 && !creating ? (
        <div className="rounded-lg border border-dashed py-8 text-center">
          <BookOpen className="h-7 w-7 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">
            {lang === "fr"
              ? (inscricoes.length > 0 ? "Aucun événement ne correspond aux filtres." : "Aucun événement enregistré.")
              : (inscricoes.length > 0 ? "Nenhum evento corresponde aos filtros." : "Nenhum evento cadastrado ainda.")}
          </p>
          {inscricoes.length === 0 && (
            <p className="text-xs text-muted-foreground/60 mt-0.5">
              {lang === "fr" ? "Créez-en un pour le partager avec les personnes intéressées." : "Crie um para compartilhar com interessados."}
            </p>
          )}
        </div>
      ) : (
        <Card className="shadow-sm border-border/50">
          <CardContent className="p-0 overflow-x-auto">
            <Table className="table-fixed" style={{ width: tableWidth, minWidth: tableWidth }}>
              <colgroup>
                {canManage && <col style={{ width: EVENT_SELECTION_COLUMN_WIDTH }} />}
                {EVENT_COLUMN_KEYS.map(key => (
                  <col key={key} data-testid={`events-column-${key}`} style={{ width: columnWidths[key] }} />
                ))}
                <col style={{ width: EVENT_ACTIONS_COLUMN_WIDTH }} />
              </colgroup>
              <TableHeader>
                <TableRow>
                  {canManage && (
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allVisibleSelected}
                        onCheckedChange={(checked) => toggleVisibleSelection(checked === true)}
                        aria-label={lang === "fr" ? "Sélectionner les événements visibles" : "Selecionar eventos visíveis"}
                      />
                    </TableHead>
                  )}
                  {sortableHead("nome", lang === "fr" ? "Événement" : "Evento")}
                  {sortableHead("nucleo", lang === "fr" ? "Noyau" : "Núcleo")}
                  {sortableHead("tipoEvento", lang === "fr" ? "Type" : "Tipo")}
                  {sortableHead("dataInicio", lang === "fr" ? "Dates" : "Datas")}
                  {sortableHead("local", lang === "fr" ? "Lieu" : "Local")}
                  {sortableHead("inscritosCount", lang === "fr" ? "Inscrits" : "Inscritos", "text-center")}
                  {sortableHead("ativo", lang === "fr" ? "Statut" : "Status")}
                  <TableHead className="sticky right-0 z-20 w-40 border-l bg-card text-right shadow-[-6px_0_10px_-10px_rgba(0,0,0,0.35)]">
                    {lang === "fr" ? "Actions" : "Ações"}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inscricoesVisiveis.map((ci) => (
                  editingId === ci.id ? (
                    <TableRow key={ci.id}>
                      <TableCell colSpan={canManage ? 9 : 8} className="p-3">
                        <InscricaoForm
                          initial={editForm}
                          onSave={(data) => updateM.mutate({ id: ci.id, data })}
                          onCancel={() => setEditingId(null)}
                          isPending={updateM.isPending}
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    <TableRow key={ci.id} className={!ci.ativo ? "opacity-55" : undefined}>
                      {canManage && (
                        <TableCell className="w-10">
                          <Checkbox
                            checked={selectedEventIds.has(ci.id)}
                            onCheckedChange={(checked) => toggleEventSelection(ci.id, checked === true)}
                            aria-label={lang === "fr" ? `Sélectionner ${ci.nome}` : `Selecionar ${ci.nome}`}
                          />
                        </TableCell>
                      )}
                      <TableCell>
                        <Link href={`/education/cursos/${ci.id}`} className="font-medium truncate hover:underline text-primary block">
                          {ci.nome}
                        </Link>
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                          <LinkIcon className="h-3 w-3 shrink-0" />
                          <Link href={`/education/cursos/${ci.id}`} className="hover:underline">
                            Gerenciar formulários
                          </Link>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{ci.nucleo === "EDUCATION" ? "Education" : "Experiences"}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{typeLabels[ci.tipoEvento]}</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        <div className="flex items-center gap-1.5">
                          <CalendarDays className="h-3.5 w-3.5" />
                          {ci.dataInicio || ci.dataFim
                            ? <span>{formatDateBR(ci.dataInicio, "?")}{ci.dataFim ? ` → ${formatDateBR(ci.dataFim, "?")}` : ""}</span>
                            : <span>—</span>}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[180px] text-sm text-muted-foreground">
                        <div className="flex items-center gap-1.5">
                          <MapPin className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{ci.local || "—"}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          asChild
                          title={lang === "fr" ? "Voir les inscrits" : "Ver inscritos"}
                        >
                          <Link href={`/education/cursos/${ci.id}`}>
                            <Users className="h-3.5 w-3.5 mr-1" />
                            {ci.inscritosCount ?? 0}
                          </Link>
                        </Button>
                      </TableCell>
                      <TableCell>
                        <Badge variant={ci.ativo ? "default" : "secondary"}>
                          {ci.ativo ? (lang === "fr" ? "Actif" : "Ativo") : (lang === "fr" ? "Archivé" : "Arquivado")}
                        </Badge>
                      </TableCell>
                      <TableCell className="sticky right-0 z-10 border-l bg-card shadow-[-6px_0_10px_-10px_rgba(0,0,0,0.35)]">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 border border-border/70 bg-background p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
                            asChild
                            title={lang === "fr" ? "Voir la fiche de l'événement" : "Ver ficha do evento"}
                          >
                            <Link
                              href={`/education/cursos/${ci.id}?view=readonly`}
                              aria-label={lang === "fr" ? `Voir ${ci.nome}` : `Ver ficha de ${ci.nome}`}
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </Link>
                          </Button>
                          {canManage && (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 w-8 border border-border/70 bg-background p-0 text-primary hover:bg-primary/10"
                                onClick={() => startEdit(ci)}
                                title={lang === "fr" ? "Modifier l'événement" : "Editar evento"}
                                aria-label={lang === "fr" ? `Modifier ${ci.nome}` : `Editar ${ci.nome}`}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className={`h-8 w-8 border bg-background p-0 ${ci.ativo ? "border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive" : "border-green-600/30 text-green-600 hover:bg-green-600/10 hover:text-green-700"}`}
                                onClick={() => ci.ativo
                                  ? setArchiveTarget(ci)
                                  : toggleM.mutate({ id: ci.id, ativo: true })}
                                disabled={toggleM.isPending}
                                title={ci.ativo
                                  ? (lang === "fr" ? "Archiver l'événement" : "Arquivar evento")
                                  : (lang === "fr" ? "Restaurer l'événement" : "Restaurar evento")}
                                aria-label={ci.ativo
                                  ? (lang === "fr" ? `Archiver ${ci.nome}` : `Arquivar ${ci.nome}`)
                                  : (lang === "fr" ? `Restaurer ${ci.nome}` : `Restaurar ${ci.nome}`)}
                              >
                                {ci.ativo
                                  ? <Archive className="h-3.5 w-3.5" />
                                  : <ArchiveRestore className="h-3.5 w-3.5" />}
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={archiveTarget !== null} onOpenChange={(open) => { if (!open) setArchiveTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {lang === "fr" ? "Archiver l'événement ?" : "Arquivar evento?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {lang === "fr"
                ? `Archiver « ${archiveTarget?.nome ?? ""} » ? L'événement sera marqué comme archivé, mais ses inscriptions, son historique et son lien public seront conservés.`
                : `Arquivar “${archiveTarget?.nome ?? ""}”? O evento será marcado como arquivado, mas seus inscritos, histórico e link público serão preservados.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {lang === "fr" ? "Annuler" : "Cancelar"}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => archiveTarget && toggleM.mutate({ id: archiveTarget.id, ativo: false })}
              disabled={toggleM.isPending}
            >
              <Archive className="mr-2 h-4 w-4" />
              {lang === "fr" ? "Archiver" : "Arquivar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={(open) => { if (!open && !deleteM.isPending) setDeleteDialogOpen(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {lang === "fr" ? "Supprimer définitivement les événements ?" : "Excluir eventos definitivamente?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {lang === "fr"
                ? `${selectedEvents.length} événement(s) seront supprimé(s), y compris ceux archivés. Les formulaires de ces événements seront supprimés. Les classes, cours et inscriptions liées seront conservés. Les événements avec réponses ou historique ne peuvent pas être supprimés.`
                : `${selectedEvents.length} evento(s) serão removidos, inclusive arquivados. Os formulários desses eventos também serão apagados. Turmas, cursos e matrículas vinculados serão preservados. Eventos com respostas ou histórico não podem ser excluídos.`}
            </AlertDialogDescription>
            {selectedEvents.length > 0 && (
              <ul className="max-h-28 list-disc space-y-1 overflow-y-auto pl-5 text-xs text-muted-foreground">
                {selectedEvents.slice(0, 8).map(item => <li key={item.id}>{item.nome}</li>)}
                {selectedEvents.length > 8 && <li>+{selectedEvents.length - 8}</li>}
              </ul>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteM.isPending}>
              {lang === "fr" ? "Annuler" : "Cancelar"}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                deleteM.mutate(selectedEvents.map(item => item.id));
              }}
              disabled={deleteM.isPending || selectedEvents.length === 0}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {lang === "fr" ? "Supprimer définitivement" : "Excluir definitivamente"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={cascadeDialogOpen}
        onOpenChange={(open) => {
          if (!open && !cascadeDeleteM.isPending) {
            setCascadeDialogOpen(false);
            setCascadeConfirmation("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {lang === "fr" ? "Supprimer les données de test en cascade ?" : "Apagar dados de teste em cascata?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {lang === "fr"
                ? `${selectedEvents.length} événement(s) marqué(s) comme test seront supprimés avec leurs formulaires, réponses, préinscriptions, inscriptions, classes et cours exclusifs. Les fiches de personnes et les conversations seront conservées.`
                : `${selectedEvents.length} evento(s) marcado(s) como teste serão apagados com formulários, respostas, pré-inscrições, matrículas, turmas e cursos exclusivos. Fichas de pessoas e conversas serão preservadas.`}
            </AlertDialogDescription>
            {selectedEvents.length > 0 && (
              <ul className="max-h-28 list-disc space-y-1 overflow-y-auto pl-5 text-xs text-muted-foreground">
                {selectedEvents.slice(0, 8).map(item => <li key={item.id}>{item.nome}</li>)}
                {selectedEvents.length > 8 && <li>+{selectedEvents.length - 8}</li>}
              </ul>
            )}
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="cascade-test-confirmation">
              {lang === "fr" ? "Tapez 123mudar pour confirmer" : "Digite 123mudar para confirmar"}
            </Label>
            <Input
              id="cascade-test-confirmation"
              autoComplete="off"
              value={cascadeConfirmation}
              onChange={event => setCascadeConfirmation(event.target.value)}
              aria-label={lang === "fr" ? "Phrase de confirmation" : "Senha de confirmação"}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cascadeDeleteM.isPending}>
              {lang === "fr" ? "Annuler" : "Cancelar"}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                cascadeDeleteM.mutate({
                  ids: selectedEvents.map(item => item.id),
                  confirmation: cascadeConfirmation,
                });
              }}
              disabled={
                cascadeDeleteM.isPending
                || !selectedAreTestEvents
                || cascadeConfirmation !== TEST_CASCADE_CONFIRMATION
              }
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {lang === "fr" ? "Supprimer les tests" : "Apagar testes"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function Cursos() {
  const { t } = useLang();

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("edu.cursos.title")}</h1>
          <p className="text-muted-foreground">{t("edu.cursos.subtitle")}</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" asChild>
          <Link href="/education/interesse" data-testid="link-formulario-interesse">
            <ClipboardList className="mr-2 h-4 w-4" />
            {t("edu.interesse.title")}
          </Link>
        </Button>
      </div>
      <EventosTable />
    </div>
  );
}
