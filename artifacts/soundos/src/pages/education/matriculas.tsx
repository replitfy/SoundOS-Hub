import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useListEnrollments,
  useCreateEnrollment,
  useListPessoaOptions,
  useListClasses,
  getListEnrollmentsQueryKey,
  getListStudentsQueryKey,
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
import { Plus, Pencil, Trash2, Check, X } from "lucide-react";
import { useLang } from "@/contexts/language";
import { useUserSession } from "@/contexts/user-session";
import { useAccess } from "@/contexts/access";

// ── Types ────────────────────────────────────────────────────────

interface EnrollmentRow {
  id: number;
  pessoaId: number;
  pessoaNome: string;
  classId: number;
  className: string;
  price: number;
  paymentStatus: string;
  contractStatus: string;
  hotmartAccessStatus?: string | null;
  invoiceStatus?: string | null;
  createdAt?: string;
}

// Matricula-se uma pessoa do CRM — não existe cadastro de aluno separado.
interface PessoaOptionRow { id: number; codigo: string; nome: string; email?: string | null; }
interface ClassRow { id: number; code: string; courseName: string; }

const PAYMENT_OPTIONS = ["pending", "Pago", "Em atraso", "Parcelado", "Isento"];
const CONTRACT_OPTIONS = ["pending", "Assinado", "Aguardando", "Dispensado"];
const HOTMART_OPTIONS = ["none", "Liberado", "Pendente", "Bloqueado"];
const INVOICE_OPTIONS = ["none", "Emitida", "Pendente", "Dispensada"];

const emptyCreateForm = {
  pessoaId: "",
  classId: "",
  price: "",
  paymentStatus: "pending",
  contractStatus: "pending",
};

const emptyEditForm = {
  paymentStatus: "",
  contractStatus: "",
  hotmartAccessStatus: "",
  invoiceStatus: "",
};

// ── Create form ────────────────────────────────────────────────

function MatriculaCreateForm({
  pessoas,
  classes,
  search,
  onSearchChange,
  onSave,
  onCancel,
  isPending,
}: {
  pessoas: PessoaOptionRow[];
  classes: ClassRow[];
  search: string;
  onSearchChange: (v: string) => void;
  onSave: (data: typeof emptyCreateForm) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [form, setForm] = useState(emptyCreateForm);

  const valid = form.pessoaId && form.classId && form.price !== "" && parseFloat(form.price) >= 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Buscar Pessoa *</Label>
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Filtrar por nome ou e-mail…"
            className="h-8 text-sm"
          />
          <Select value={form.pessoaId} onValueChange={(v) => setForm((f) => ({ ...f, pessoaId: v }))}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="Selecione a pessoa" />
            </SelectTrigger>
            <SelectContent className="max-h-48">
              {pessoas.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.nome}
                  {p.email ? <span className="text-muted-foreground"> · {p.email}</span> : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            A pessoa vira aluna ao ser matriculada. Se ela ainda não existe, cadastre-a em Pessoas.
          </p>
        </div>
        <div className="col-span-2 space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Turma *</Label>
          <Select value={form.classId} onValueChange={(v) => setForm((f) => ({ ...f, classId: v }))}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="Selecione a turma" />
            </SelectTrigger>
            <SelectContent className="max-h-48">
              {classes.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.code} — {c.courseName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Valor (R$) *</Label>
          <Input
            type="number"
            value={form.price}
            onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
            placeholder="Ex: 3500"
            className="h-8 text-sm"
            min="0"
            step="0.01"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Status Pagamento</Label>
          <Select value={form.paymentStatus} onValueChange={(v) => setForm((f) => ({ ...f, paymentStatus: v }))}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PAYMENT_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="col-span-2 space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Status Contrato</Label>
          <Select value={form.contractStatus} onValueChange={(v) => setForm((f) => ({ ...f, contractStatus: v }))}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CONTRACT_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex gap-2 justify-end pt-1">
        <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>
          <X className="h-3.5 w-3.5 mr-1" /> Cancelar
        </Button>
        <Button size="sm" className="h-8" onClick={() => onSave(form)} disabled={!valid || isPending}>
          <Check className="h-3.5 w-3.5 mr-1" /> Matricular
        </Button>
      </div>
    </div>
  );
}

// ── Edit form ──────────────────────────────────────────────────

function MatriculaEditForm({
  enrollment,
  onSave,
  onCancel,
  isPending,
}: {
  enrollment: EnrollmentRow;
  onSave: (data: typeof emptyEditForm) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [form, setForm] = useState<typeof emptyEditForm>({
    paymentStatus: enrollment.paymentStatus,
    contractStatus: enrollment.contractStatus,
    hotmartAccessStatus: enrollment.hotmartAccessStatus ?? "none",
    invoiceStatus: enrollment.invoiceStatus ?? "none",
  });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Status Pagamento</Label>
          <Select value={form.paymentStatus} onValueChange={(v) => setForm((f) => ({ ...f, paymentStatus: v }))}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PAYMENT_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Status Contrato</Label>
          <Select value={form.contractStatus} onValueChange={(v) => setForm((f) => ({ ...f, contractStatus: v }))}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CONTRACT_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Acesso Hotmart</Label>
          <Select value={form.hotmartAccessStatus} onValueChange={(v) => setForm((f) => ({ ...f, hotmartAccessStatus: v }))}>
            <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="—" /></SelectTrigger>
            <SelectContent>
              {HOTMART_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o === "none" ? "—" : o}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Nota Fiscal</Label>
          <Select value={form.invoiceStatus} onValueChange={(v) => setForm((f) => ({ ...f, invoiceStatus: v }))}>
            <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="—" /></SelectTrigger>
            <SelectContent>
              {INVOICE_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o === "none" ? "—" : o}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex gap-2 justify-end pt-1">
        <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>
          <X className="h-3.5 w-3.5 mr-1" /> Cancelar
        </Button>
        <Button size="sm" className="h-8" onClick={() => onSave(form)} disabled={isPending}>
          <Check className="h-3.5 w-3.5 mr-1" /> Salvar
        </Button>
      </div>
    </div>
  );
}

// ── Create Dialog ───────────────────────────────────────────────

function MatriculaCreateDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const { data: pessoas = [] } = useListPessoaOptions(
    search.trim() ? { search: search.trim() } : undefined,
  );
  const { data: classes = [] } = useListClasses();

  const createM = useCreateEnrollment({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListEnrollmentsQueryKey() });
        // A lista de Alunos é derivada das matrículas, então também muda.
        qc.invalidateQueries({ queryKey: getListStudentsQueryKey() });
        toast.success("Matrícula criada");
        onClose();
      },
      onError: () => toast.error("Erro ao criar matrícula"),
    },
  });

  const handleSave = (data: typeof emptyCreateForm) => {
    createM.mutate({
      data: {
        pessoaId: parseInt(data.pessoaId, 10),
        classId: parseInt(data.classId, 10),
        price: parseFloat(data.price),
        paymentStatus: data.paymentStatus || undefined,
        contractStatus: data.contractStatus || undefined,
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nova Matrícula</DialogTitle>
        </DialogHeader>
        <div className="mt-2">
          <MatriculaCreateForm
            pessoas={pessoas as PessoaOptionRow[]}
            classes={classes as ClassRow[]}
            search={search}
            onSearchChange={setSearch}
            onSave={handleSave}
            onCancel={onClose}
            isPending={createM.isPending}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit Dialog ─────────────────────────────────────────────────

function MatriculaEditDialog({
  enrollment,
  open,
  onClose,
}: {
  enrollment: EnrollmentRow;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { authHeader } = useUserSession();

  // Use direct fetch so we can send null to explicitly clear nullable fields,
  // which the generated EnrollmentUpdate type does not support.
  const updateM = useMutation({
    mutationFn: async (body: Record<string, string | null | undefined>) => {
      const r = await fetch(`/api/education/enrollments/${enrollment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error("Erro ao atualizar matrícula");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListEnrollmentsQueryKey() });
      toast.success("Matrícula atualizada");
      onClose();
    },
    onError: () => toast.error("Erro ao atualizar matrícula"),
  });

  // Required status fields: omit if blank; nullable fields: send null to clear
  const toRequired = (v: string) => v || undefined;
  const toNullable = (v: string): string | null => v === "none" || v === "" ? null : v;

  const handleSave = (data: typeof emptyEditForm) => {
    updateM.mutate({
      paymentStatus: toRequired(data.paymentStatus),
      contractStatus: toRequired(data.contractStatus),
      hotmartAccessStatus: toNullable(data.hotmartAccessStatus),
      invoiceStatus: toNullable(data.invoiceStatus),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Editar Matrícula — {enrollment.pessoaNome}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground -mt-1 mb-2">
          Turma: {enrollment.className} · R$ {enrollment.price.toLocaleString("pt-BR")}
        </p>
        <MatriculaEditForm
          enrollment={enrollment}
          onSave={handleSave}
          onCancel={onClose}
          isPending={updateM.isPending}
        />
      </DialogContent>
    </Dialog>
  );
}

// ── Badge helpers ───────────────────────────────────────────────

function PaymentBadge({ status }: { status: string }) {
  const cls =
    status === "Pago" ? "bg-terra" : status === "Em atraso" ? "bg-destructive" : "";
  return (
    <Badge variant={status === "Pago" ? "default" : "secondary"} className={cls}>
      {status}
    </Badge>
  );
}

function ContractBadge({ status }: { status: string }) {
  return (
    <Badge
      variant={status === "Assinado" ? "default" : "outline"}
      className={status === "Assinado" ? "bg-agua" : ""}
    >
      {status}
    </Badge>
  );
}

// ── Main page ────────────────────────────────────────────────────

export default function Matriculas() {
  const { data: enrollments, isLoading } = useListEnrollments();
  const { t, lang } = useLang();
  const numLocale = lang === "fr" ? "fr-FR" : "pt-BR";
  const { authHeader } = useUserSession();
  const { isAdmin } = useAccess();
  const qc = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EnrollmentRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EnrollmentRow | null>(null);

  const deleteM = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/education/enrollments/${id}`, {
        method: "DELETE",
        headers: authHeader,
      });
      if (!r.ok) throw new Error("Erro ao excluir matrícula");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getListEnrollmentsQueryKey() });
      qc.invalidateQueries({ queryKey: getListStudentsQueryKey() });
      toast.success("Matrícula excluída");
      setDeleteTarget(null);
    },
    onError: () => toast.error("Erro ao excluir matrícula"),
  });

  if (isLoading) return <div className="p-8"><Skeleton className="h-64 w-full" /></div>;
  if (!enrollments) return null;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("edu.mat.title")}</h1>
          <p className="text-muted-foreground">{t("edu.mat.subtitle")}</p>
        </div>
        {isAdmin && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> Nova Matrícula
          </Button>
        )}
      </div>

      <Card className="shadow-sm border-border/50">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("edu.mat.aluno")}</TableHead>
                <TableHead>{t("edu.mat.turma")}</TableHead>
                <TableHead>{t("common.valor")}</TableHead>
                <TableHead>{t("edu.mat.pagamento")}</TableHead>
                <TableHead>{t("edu.mat.contrato")}</TableHead>
                <TableHead>{t("edu.mat.acesso_hotmart")}</TableHead>
                {isAdmin && <TableHead className="w-20" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(enrollments as EnrollmentRow[]).map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium">{e.pessoaNome}</TableCell>
                  <TableCell>{e.className}</TableCell>
                  <TableCell>R$ {e.price.toLocaleString(numLocale)}</TableCell>
                  <TableCell><PaymentBadge status={e.paymentStatus} /></TableCell>
                  <TableCell><ContractBadge status={e.contractStatus} /></TableCell>
                  <TableCell>{e.hotmartAccessStatus || '-'}</TableCell>
                  {isAdmin && (
                    <TableCell>
                      <div className="flex items-center gap-0.5">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setEditTarget(e)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm" variant="ghost"
                          className="h-7 w-7 p-0 text-destructive/70 hover:text-destructive"
                          onClick={() => setDeleteTarget(e)}
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

      {isAdmin && createOpen && (
        <MatriculaCreateDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      )}
      {isAdmin && editTarget && (
        <MatriculaEditDialog
          enrollment={editTarget}
          open={!!editTarget}
          onClose={() => setEditTarget(null)}
        />
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir matrícula?</AlertDialogTitle>
            <AlertDialogDescription>
              A matrícula de <strong>{deleteTarget?.pessoaNome}</strong> na turma{" "}
              <strong>{deleteTarget?.className}</strong> será removida permanentemente.
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
