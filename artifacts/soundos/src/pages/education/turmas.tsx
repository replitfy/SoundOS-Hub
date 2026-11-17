import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useListClasses,
  useListCourses,
  getListClassesQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Check, X, Copy, ExternalLink } from "lucide-react";
import { format, parseISO } from "date-fns";
import { useLang } from "@/contexts/language";
import { useUserSession } from "@/contexts/user-session";
import { useAccess } from "@/contexts/access";
import { useLocation } from "wouter";

// ── Types ────────────────────────────────────────────────────────

interface ClassRow {
  id: number;
  courseId: number;
  courseName: string;
  code: string;
  location?: string | null;
  startDate: string | null;
  endDate: string | null;
  capacity: number;
  enrolled: number;
  teacher: string;
  status: string;
  // Slug do formulário público de inscrição próprio desta turma.
  inscricaoSlug?: string | null;
}

interface Course {
  id: number;
  name: string;
  active: boolean;
}

const STATUS_OPTIONS = ["Planejada", "Aberta", "Em Andamento", "Encerrada"];

// ── Link de inscrição da turma ──────────────────────────────────
// Cada turma tem o seu próprio formulário público. O slug é criado junto com a
// turma e nunca muda, para que um link já divulgado continue valendo.

function LinkInscricao({ slug }: { slug?: string | null }) {
  const [copiado, setCopiado] = useState(false);

  if (!slug) return <span className="text-xs text-muted-foreground">-</span>;

  const caminho = `${import.meta.env.BASE_URL}inscricao/${slug}`;
  const url = `${window.location.origin}${caminho}`;

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiado(true);
      toast.success("Link copiado");
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      toast.error("Não foi possível copiar o link");
    }
  };

  return (
    <div className="flex items-center gap-0.5">
      <code className="text-[11px] text-muted-foreground max-w-[130px] truncate" title={url}>
        /{slug}
      </code>
      <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={copiar} title="Copiar link">
        {copiado ? <Check className="h-3 w-3 text-agua" /> : <Copy className="h-3 w-3" />}
      </Button>
      <Button size="sm" variant="ghost" className="h-6 w-6 p-0" asChild title="Abrir formulário">
        <a href={caminho} target="_blank" rel="noreferrer">
          <ExternalLink className="h-3 w-3" />
        </a>
      </Button>
    </div>
  );
}

const emptyForm = {
  courseId: "",
  code: "",
  location: "",
  startDate: "",
  endDate: "",
  capacity: "",
  teacher: "",
  status: "Planejada",
};

// ── Form ────────────────────────────────────────────────────────

function TurmaForm({
  initial,
  courses,
  onSave,
  onCancel,
  isPending,
  allowUndated,
}: {
  initial: typeof emptyForm;
  courses: Course[];
  onSave: (data: typeof emptyForm) => void;
  onCancel: () => void;
  isPending: boolean;
  allowUndated: boolean;
}) {
  const [form, setForm] = useState(initial);
  const set =
    (k: keyof typeof emptyForm) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const valid =
    form.courseId &&
    form.code.trim() &&
    (
      (Boolean(form.startDate) && Boolean(form.endDate)) ||
      (allowUndated && !form.startDate && !form.endDate)
    ) &&
    parseInt(form.capacity) > 0 &&
    form.teacher.trim();

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Curso *</Label>
          <Select value={form.courseId} onValueChange={(v) => setForm((f) => ({ ...f, courseId: v }))}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="Selecione o curso" />
            </SelectTrigger>
            <SelectContent>
              {courses.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Código *</Label>
          <Input value={form.code} onChange={set("code")} placeholder="Ex: AGUA-SP-2026" className="h-8 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Local</Label>
          <Input value={form.location} onChange={set("location")} placeholder="Ex: São Paulo — SP" className="h-8 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Data Início *</Label>
          <Input type="date" value={form.startDate} onChange={set("startDate")} className="h-8 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Data Fim *</Label>
          <Input type="date" value={form.endDate} onChange={set("endDate")} className="h-8 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Capacidade *</Label>
          <Input type="number" value={form.capacity} onChange={set("capacity")} placeholder="Ex: 20" className="h-8 text-sm" min="1" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Professor *</Label>
          <Input value={form.teacher} onChange={set("teacher")} placeholder="Nome do professor" className="h-8 text-sm" />
        </div>
        <div className="col-span-2 space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Status</Label>
          <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex gap-2 justify-end pt-1">
        <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>
          <X className="h-3.5 w-3.5 mr-1" /> Cancelar
        </Button>
        <Button size="sm" className="h-8" onClick={() => onSave(form)} disabled={!valid || isPending}>
          <Check className="h-3.5 w-3.5 mr-1" /> Salvar
        </Button>
      </div>
    </div>
  );
}

// ── Dialog ───────────────────────────────────────────────────────

function TurmaDialog({
  turma,
  courses,
  open,
  onClose,
}: {
  turma: ClassRow | null;
  courses: Course[];
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { authHeader } = useUserSession();

  const createM = useMutation({
    mutationFn: async (data: typeof emptyForm) => {
      const r = await fetch("/api/education/classes", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          courseId: parseInt(data.courseId, 10),
          code: data.code.trim(),
          location: data.location.trim() || undefined,
          startDate: data.startDate,
          endDate: data.endDate,
          capacity: parseInt(data.capacity, 10),
          teacher: data.teacher.trim(),
          status: data.status,
        }),
      });
      if (!r.ok) throw new Error("Erro ao criar turma");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListClassesQueryKey() });
      toast.success("Turma criada");
      onClose();
    },
    onError: () => toast.error("Erro ao criar turma"),
  });

  const updateM = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: typeof emptyForm }) => {
      const r = await fetch(`/api/education/classes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          courseId: parseInt(data.courseId, 10),
          code: data.code.trim(),
          location: data.location.trim() || null,
          startDate: data.startDate || null,
          endDate: data.endDate || null,
          capacity: parseInt(data.capacity, 10),
          teacher: data.teacher.trim(),
          status: data.status,
        }),
      });
      if (!r.ok) throw new Error("Erro ao atualizar turma");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListClassesQueryKey() });
      toast.success("Turma salva");
      onClose();
    },
    onError: () => toast.error("Erro ao salvar turma"),
  });

  // Map any legacy English status values to the canonical Portuguese vocabulary
  const canonicalStatus = (s: string) =>
    STATUS_OPTIONS.includes(s as typeof STATUS_OPTIONS[number]) ? s : "Planejada";

  const initial: typeof emptyForm = turma
    ? {
        courseId: String(turma.courseId),
        code: turma.code,
        location: turma.location ?? "",
        startDate: turma.startDate ?? "",
        endDate: turma.endDate ?? "",
        capacity: String(turma.capacity),
        teacher: turma.teacher,
        status: canonicalStatus(turma.status),
      }
    : emptyForm;

  const handleSave = (data: typeof emptyForm) => {
    if (turma) {
      updateM.mutate({ id: turma.id, data });
    } else {
      createM.mutate(data);
    }
  };

  const isPending = createM.isPending || updateM.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{turma ? `Editar — ${turma.code}` : "Nova Turma"}</DialogTitle>
        </DialogHeader>
        <div className="mt-2">
          <TurmaForm
            initial={initial}
            courses={courses}
            onSave={handleSave}
            onCancel={onClose}
            isPending={isPending}
            allowUndated={Boolean(turma && !turma.startDate && !turma.endDate)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ────────────────────────────────────────────────────

export default function Turmas() {
  const [, navigate] = useLocation();
  const { data: classes, isLoading } = useListClasses();
  const { data: courses = [] } = useListCourses();
  const { t, lang } = useLang();
  const { authHeader } = useUserSession();
  const { isAdmin } = useAccess();
  const qc = useQueryClient();

  const [dialogTurma, setDialogTurma] = useState<ClassRow | null | undefined>(undefined);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ClassRow | null>(null);

  const deleteM = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/education/classes/${id}`, {
        method: "DELETE",
        headers: authHeader,
      });
      if (r.status === 409) {
        const body = await r.json();
        throw new Error(body.error ?? "Não foi possível excluir");
      }
      if (!r.ok) throw new Error("Erro ao excluir turma");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListClassesQueryKey() });
      toast.success("Turma excluída");
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const openCreate = () => { setDialogTurma(null); setDialogOpen(true); };
  const openEdit = (c: ClassRow) => { setDialogTurma(c); setDialogOpen(true); };
  const closeDialog = () => {
    setDialogOpen(false);
    setTimeout(() => setDialogTurma(undefined), 200);
  };

  if (isLoading) return <div className="p-8"><Skeleton className="h-64 w-full" /></div>;
  if (!classes) return null;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("edu.turmas.title")}</h1>
          <p className="text-muted-foreground">{t("edu.turmas.subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => navigate("/education/cursos")}>
            {lang === "fr" ? "Voir les événements" : "Ver eventos"}
          </Button>
          {isAdmin && (
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1.5" /> Nova Turma
            </Button>
          )}
        </div>
      </div>

      <Card className="shadow-sm border-border/50">
        <CardContent className="p-0 overflow-x-auto">
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>{t("common.codigo")}</TableHead>
                <TableHead>{t("edu.turmas.curso")}</TableHead>
                <TableHead>{t("edu.turmas.local")}</TableHead>
                <TableHead>{t("edu.turmas.inicio")}</TableHead>
                <TableHead>{t("edu.turmas.ocupacao")}</TableHead>
                <TableHead>{t("common.status")}</TableHead>
                <TableHead>Inscrição</TableHead>
                {isAdmin && <TableHead className="w-20" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(classes as ClassRow[]).map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-mono text-xs">{c.code}</TableCell>
                  <TableCell className="font-medium">{c.courseName}</TableCell>
                  <TableCell>{c.location || '-'}</TableCell>
                  <TableCell>
                    {c.startDate ? format(parseISO(c.startDate), 'dd/MM/yyyy') : "Data não informada"}
                  </TableCell>
                  <TableCell>
                    {c.enrolled} / {c.capacity} ({Math.round((c.enrolled / c.capacity) * 100)}%)
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={c.status === 'Planejada' ? 'outline' : 'default'}
                      className={c.status === 'Aberta' || c.status === 'Em Andamento' ? 'bg-agua' : ''}
                    >
                      {c.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <LinkInscricao slug={c.inscricaoSlug} />
                  </TableCell>
                  {isAdmin && (
                    <TableCell>
                      <div className="flex items-center gap-0.5">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openEdit(c)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm" variant="ghost"
                          className="h-7 w-7 p-0 text-destructive/70 hover:text-destructive"
                          onClick={() => setDeleteTarget(c)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {dialogOpen && dialogTurma !== undefined && (
        <TurmaDialog
          turma={dialogTurma}
          courses={courses as Course[]}
          open={dialogOpen}
          onClose={closeDialog}
        />
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir turma?</AlertDialogTitle>
            <AlertDialogDescription>
              A turma <strong>{deleteTarget?.code}</strong> será removida permanentemente.
              Turmas com matrículas não podem ser excluídas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteM.mutate(deleteTarget.id)}
              disabled={deleteM.isPending}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
