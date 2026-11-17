import { useState } from "react";
import {
  ApiError,
  useListAccessProfiles,
  useListUsers,
  useCreateUser,
  useUpdateUser,
  useDeleteUser,
  useBulkDeleteUsers,
} from "@workspace/api-client-react";
import type { AccessProfile, User } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { UserPlus, Pencil, Trash2, Users, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { useLang } from "@/contexts/language";
import { useUserSession } from "@/contexts/user-session";
import { formatDateTimeBR } from "@/lib/date";
import { profileLabel } from "@/lib/access-labels";
import type { ServerErrorBody } from "@/lib/profile-errors";

function ProfileBadge({ name, isAdmin }: { name: string; isAdmin: boolean }) {
  const { t } = useLang();
  const color = isAdmin
    ? "bg-violet-100 text-violet-800 border-violet-200"
    : "bg-emerald-100 text-emerald-800 border-emerald-200";
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${color}`}>
      {profileLabel(name, t)}
    </span>
  );
}

/**
 * Mensagem de uma falha ao salvar/excluir: a regra "sempre sobra alguém que
 * gerencie perfis e usuários" é traduzida; as demais mostram o texto do servidor.
 */
function describeUserError(err: unknown, t: ReturnType<typeof useLang>["t"], fallback: string): string {
  const body = err instanceof ApiError ? (err.data as ServerErrorBody | null) : null;
  if (body?.code === "LAST_MANAGER") return t("perfis.err.LAST_MANAGER");
  return body?.error ?? fallback;
}

type FormState = {
  name: string;
  email: string;
  profileId: number | null;
  password: string;
  active: boolean;
};

const EMPTY_FORM: FormState = { name: "", email: "", profileId: null, password: "", active: true };

function UserForm({
  form,
  onChange,
  isCreate,
  error,
  showResetHint,
  profiles,
  profilesFailed,
}: {
  form: FormState;
  onChange: (f: FormState) => void;
  isCreate: boolean;
  error?: string;
  showResetHint?: boolean;
  profiles: AccessProfile[];
  profilesFailed: boolean;
}) {
  const { t } = useLang();
  return (
    <div className="space-y-4 py-2">
      {showResetHint && (
        <div className="flex gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          <KeyRound className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
          <span>{t("admin.usuarios.reset_hint")}</span>
        </div>
      )}
      {error && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("admin.usuarios.nome_form")}</Label>
          <Input
            value={form.name}
            onChange={e => onChange({ ...form, name: e.target.value })}
            placeholder={t("admin.usuarios.ph_nome")}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("admin.usuarios.email_form")}</Label>
          <Input
            type="email"
            value={form.email}
            onChange={e => onChange({ ...form, email: e.target.value })}
            placeholder={t("admin.usuarios.ph_email")}
            className="h-9"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("admin.usuarios.perfil_form")}</Label>
          <Select
            value={form.profileId === null ? "" : String(form.profileId)}
            onValueChange={v => onChange({ ...form, profileId: Number(v) })}
            disabled={profiles.length === 0}
          >
            <SelectTrigger className="h-9" data-testid="select-user-profile">
              <SelectValue placeholder={t("admin.usuarios.perfil_vazio")} />
            </SelectTrigger>
            <SelectContent>
              {profiles.map(profile => (
                <SelectItem key={profile.id} value={String(profile.id)}>
                  <ProfileBadge name={profile.name} isAdmin={profile.isAdmin} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {profilesFailed && <p className="text-xs text-destructive">{t("admin.usuarios.perfis_erro")}</p>}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{isCreate ? t("admin.usuarios.senha_form") : t("admin.usuarios.nova_senha")}</Label>
          <Input
            type="password"
            value={form.password}
            onChange={e => onChange({ ...form, password: e.target.value })}
            placeholder={isCreate ? t("admin.usuarios.ph_senha") : "••••••••"}
            className="h-9"
          />
        </div>
      </div>

    </div>
  );
}

export default function Usuarios() {
  const queryClient = useQueryClient();
  const { user: currentUser } = useUserSession();
  const { data: users, isLoading } = useListUsers();
  const { data: profileList, isError: profilesFailed } = useListAccessProfiles();
  const profiles = profileList ?? [];
  const defaultProfileId = profiles.find(profile => profile.systemKey === "usuario")?.id ?? null;

  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [deactivateUser, setDeactivateUser] = useState<User | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | undefined>();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });

  const createMutation = useCreateUser({
    mutation: {
      onSuccess: () => { invalidate(); setCreateOpen(false); setForm(EMPTY_FORM); toast.success(t("admin.usuarios.criado")); },
      onError: (err: unknown) => {
        setFormError(describeUserError(err, t, t("admin.usuarios.err_criar")));
      },
    },
  });

  const updateMutation = useUpdateUser({
    mutation: {
      onSuccess: () => { invalidate(); setEditUser(null); toast.success(t("admin.usuarios.atualizado")); },
      onError: (err: unknown) => {
        setFormError(describeUserError(err, t, t("admin.usuarios.err_atualizar")));
      },
    },
  });

  const deactivateMutation = useDeleteUser({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData<User[]>(["/api/admin/users"], current =>
          current?.filter(user => user.id !== data.id),
        );
        invalidate();
        setDeactivateUser(null);
        toast.success(t("admin.usuarios.excluido"));
      },
      onError: (err: unknown) => {
        toast.error(describeUserError(err, t, t("admin.usuarios.err_excluir")));
      },
    },
  });

  const bulkDeleteMutation = useBulkDeleteUsers({
    mutation: {
      onSuccess: (deletedUsers) => {
        const deletedIds = new Set(deletedUsers.map(user => user.id));
        queryClient.setQueryData<User[]>(["/api/admin/users"], current =>
          current?.filter(user => !deletedIds.has(user.id)),
        );
        invalidate();
        setSelectedIds(new Set());
        setBulkDeleteOpen(false);
        toast.success(t("admin.usuarios.lote_excluido").replace("{count}", String(deletedUsers.length)));
      },
      onError: (err: unknown) => {
        toast.error(describeUserError(err, t, t("admin.usuarios.lote_erro")));
      },
    },
  });

  const handleOpenCreate = () => {
    setForm({ ...EMPTY_FORM, profileId: defaultProfileId });
    setFormError(undefined);
    setCreateOpen(true);
  };

  const handleOpenEdit = (u: User) => {
    setForm({ name: u.name, email: u.email, profileId: u.profileId, password: "", active: u.active });
    setFormError(undefined);
    setEditUser(u);
  };

  const handleCreate = () => {
    setFormError(undefined);
    if (!form.name.trim() || !form.email.trim() || !form.password) {
      setFormError(t("admin.usuarios.preencha")); return;
    }
    if (form.profileId === null) { setFormError(t("admin.usuarios.perfil_vazio")); return; }
    if (form.password.length < 8) { setFormError(t("admin.usuarios.senha_min")); return; }
    createMutation.mutate({ data: { name: form.name, email: form.email, profileId: form.profileId, password: form.password } });
  };

  const handleUpdate = () => {
    if (!editUser) return;
    setFormError(undefined);
    if (!form.name.trim() || !form.email.trim()) { setFormError(t("admin.usuarios.nome_email_req")); return; }
    if (form.password && form.password.length < 8) { setFormError(t("admin.usuarios.nova_senha_min")); return; }
    if (form.profileId === null) { setFormError(t("admin.usuarios.perfil_vazio")); return; }
    const payload: Record<string, unknown> = { name: form.name, email: form.email, profileId: form.profileId };
    if (form.password) payload.password = form.password;
    updateMutation.mutate({ id: editUser.id, data: payload });
  };

  const handleDeactivate = () => {
    if (!deactivateUser) return;
    deactivateMutation.mutate({ id: deactivateUser.id });
  };

  const selectableUsers = users?.filter(user => user.id !== currentUser?.id) ?? [];
  const allSelected = selectableUsers.length > 0 && selectableUsers.every(user => selectedIds.has(user.id));
  const someSelected = selectedIds.size > 0 && !allSelected;

  const toggleUser = (id: number, checked: boolean) => {
    setSelectedIds(current => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(selectableUsers.map(user => user.id)) : new Set());
  };

  const handleBulkDelete = () => {
    if (selectedIds.size === 0) return;
    bulkDeleteMutation.mutate({ data: { ids: [...selectedIds] } });
  };

  const activeCount = users?.length ?? 0;
  const totalCount = users?.length ?? 0;
  const { t } = useLang();

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("admin.usuarios.title")}</h1>
          <p className="text-muted-foreground text-sm">
            {t("admin.usuarios.subtitle")}
            {!isLoading && (
              <span className="ml-2 text-muted-foreground/60">
                {activeCount} {t("admin.usuarios.ativos")} · {totalCount} {t("common.total")}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {selectedIds.size > 0 && (
            <Button
              variant="destructive"
              onClick={() => setBulkDeleteOpen(true)}
              className="gap-2"
              data-testid="button-bulk-delete-users"
            >
              <Trash2 className="h-4 w-4" />
              {t("admin.usuarios.excluir_selecionados").replace("{count}", String(selectedIds.size))}
            </Button>
          )}
          <Button onClick={handleOpenCreate} className="gap-2 bg-sofia hover:bg-sofia/90 text-white">
            <UserPlus className="h-4 w-4" />
            {t("admin.usuarios.novo")}
          </Button>
        </div>
      </div>

      {/* Table */}
      <Card className="shadow-sm border-border/40">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}
            </div>
          ) : !users || users.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground/50 gap-3">
              <Users className="h-10 w-10 opacity-30" />
              <p className="text-sm">{t("admin.usuarios.nenhum")}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border/30">
                  <TableHead className="w-12 pl-5">
                    <Checkbox
                      checked={allSelected ? true : someSelected ? "indeterminate" : false}
                      onCheckedChange={checked => toggleAll(checked === true)}
                      aria-label={t("admin.usuarios.selecionar_todos")}
                      data-testid="checkbox-select-all-users"
                    />
                  </TableHead>
                  <TableHead>{t("admin.usuarios.nome_col")}</TableHead>
                  <TableHead>{t("admin.usuarios.email_col")}</TableHead>
                  <TableHead>{t("common.perfil")}</TableHead>
                  <TableHead>{t("common.ultimo_login")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  <TableHead className="text-right pr-5">{t("admin.usuarios.acoes")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map(u => (
                  <TableRow
                    key={u.id}
                    className="border-border/20 transition-colors"
                  >
                    <TableCell className="pl-5">
                      <Checkbox
                        checked={selectedIds.has(u.id)}
                        onCheckedChange={checked => toggleUser(u.id, checked === true)}
                        disabled={u.id === currentUser?.id}
                        aria-label={`${t("admin.usuarios.selecionar")} ${u.name}`}
                        title={u.id === currentUser?.id ? t("admin.usuarios.propria_conta") : undefined}
                        data-testid={`checkbox-user-${u.id}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium text-sm">{u.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{u.email}</TableCell>
                    <TableCell><ProfileBadge name={u.profileName} isAdmin={u.isAdmin} /></TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {u.lastLogin
                        ? formatDateTimeBR(u.lastLogin)
                        : <span className="text-muted-foreground/40 italic">{t("common.nunca")}</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <Badge
                          variant="outline"
                          className={u.active
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-slate-200 bg-slate-50 text-slate-500"}
                        >
                          {u.active ? t("common.ativo_s") : t("common.inativo_s")}
                        </Badge>
                        {u.passwordMustReset && (
                          <Badge
                            variant="outline"
                            className="border-amber-200 bg-amber-50 text-amber-700 gap-1"
                            title={t("admin.usuarios.aguarda_reset")}
                          >
                            <KeyRound className="h-2.5 w-2.5" />
                            {t("admin.usuarios.aguarda_reset")}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right pr-5">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleOpenEdit(u)}
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                          title={t("common.editar")}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeactivateUser(u)}
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          title={t("admin.usuarios.excluir_btn")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Create Dialog ──────────────────────────────────── */}
      <Dialog open={createOpen} onOpenChange={open => { if (!open) { setCreateOpen(false); setFormError(undefined); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("admin.usuarios.novo_title")}</DialogTitle>
            <DialogDescription>{t("admin.usuarios.novo_desc")}</DialogDescription>
          </DialogHeader>
          <UserForm form={form} onChange={setForm} isCreate error={formError} profiles={profiles} profilesFailed={profilesFailed} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t("common.cancelar")}</Button>
            <Button
              onClick={handleCreate}
              disabled={createMutation.isPending}
              className="bg-sofia hover:bg-sofia/90 text-white"
            >
              {createMutation.isPending ? t("admin.usuarios.criando") : t("admin.usuarios.criar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit Dialog ────────────────────────────────────── */}
      <Dialog open={!!editUser} onOpenChange={open => { if (!open) { setEditUser(null); setFormError(undefined); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("admin.usuarios.editar_title")}</DialogTitle>
            <DialogDescription>{t("admin.usuarios.editar_desc")} <strong>{editUser?.name}</strong>.</DialogDescription>
          </DialogHeader>
          <UserForm form={form} onChange={setForm} isCreate={false} error={formError} showResetHint={!!editUser?.passwordMustReset} profiles={profiles} profilesFailed={profilesFailed} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditUser(null)}>{t("common.cancelar")}</Button>
            <Button
              onClick={handleUpdate}
              disabled={updateMutation.isPending}
              className="bg-sofia hover:bg-sofia/90 text-white"
            >
              {updateMutation.isPending ? t("admin.usuarios.salvando") : t("admin.usuarios.salvar_alt")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Safe deletion confirmation (soft delete) ───────── */}
      <AlertDialog open={!!deactivateUser} onOpenChange={open => { if (!open) setDeactivateUser(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("admin.usuarios.excluir_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deactivateUser?.name}</strong> {t("admin.usuarios.excluir_desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeactivate}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deactivateMutation.isPending ? t("admin.usuarios.excluindo") : t("admin.usuarios.excluir_btn")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={bulkDeleteOpen} onOpenChange={open => { if (!open && !bulkDeleteMutation.isPending) setBulkDeleteOpen(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("admin.usuarios.lote_title").replace("{count}", String(selectedIds.size))}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin.usuarios.lote_desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-40 overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm">
            {(users ?? []).filter(user => selectedIds.has(user.id)).map(user => (
              <div key={user.id} className="truncate py-0.5">
                <span className="font-medium">{user.name}</span>
                <span className="text-muted-foreground"> · {user.email}</span>
              </div>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleteMutation.isPending}>{t("common.cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={event => {
                event.preventDefault();
                handleBulkDelete();
              }}
              disabled={bulkDeleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-bulk-delete-users"
            >
              {bulkDeleteMutation.isPending ? t("admin.usuarios.excluindo") : t("admin.usuarios.confirmar_lote")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
