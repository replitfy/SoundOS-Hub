import { useMemo, useState } from "react";
import {
  ApiError,
  useCreateAccessProfile,
  useDeleteAccessProfile,
  useListAccessProfiles,
  useUpdateAccessProfile,
} from "@workspace/api-client-react";
import type { AccessProfile } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ACCESS_AREAS,
  ACCESS_SECTIONS,
  areasBySection,
  isAdminOnlyArea,
  type AccessAreaId,
} from "@workspace/access-areas";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { AlertTriangle, Eye, Lock, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useLang, type TranslationKey } from "@/contexts/language";
import { describeProfileError, type ServerErrorBody } from "@/lib/profile-errors";
import { AREA_LABEL_KEYS, SECTION_LABEL_KEYS, profileLabel, systemProfileKeyForName } from "@/lib/access-labels";
import { formatDateTimeBR } from "@/lib/date";

interface FormState {
  name: string;
  description: string;
  isAdmin: boolean;
  areas: Set<AccessAreaId>;
}

const EMPTY_FORM: FormState = { name: "", description: "", isAdmin: false, areas: new Set() };

function formFromProfile(profile: AccessProfile): FormState {
  return {
    name: profile.name,
    description: profile.description,
    isAdmin: profile.isAdmin,
    areas: new Set(profile.areas.filter((area): area is AccessAreaId => ACCESS_AREAS.some(known => known.id === area))),
  };
}

function profileDescription(profile: AccessProfile, t: (key: TranslationKey) => string): string {
  const key = systemProfileKeyForName(profile.name);
  return key && profile.isSystem ? t(`perfis.system.${key}.desc`) : profile.description;
}

function ProfileForm({
  form,
  onChange,
  profiles,
  editingId,
  readOnly,
  nameLocked,
  error,
}: {
  form: FormState;
  onChange: (next: FormState) => void;
  profiles: AccessProfile[];
  editingId: number | null;
  readOnly: boolean;
  nameLocked: boolean;
  error?: string;
}) {
  const { t } = useLang();

  const setAdmin = (isAdmin: boolean) => {
    const areas = new Set(form.areas);
    if (!isAdmin) for (const area of [...areas]) if (isAdminOnlyArea(area)) areas.delete(area);
    onChange({ ...form, isAdmin, areas });
  };

  const toggleArea = (id: AccessAreaId, checked: boolean) => {
    const areas = new Set(form.areas);
    if (checked) areas.add(id);
    else areas.delete(id);
    onChange({ ...form, areas });
  };

  const isSelectable = (id: AccessAreaId) => !readOnly && (form.isAdmin || !isAdminOnlyArea(id));

  const setSection = (ids: AccessAreaId[], checked: boolean) => {
    const areas = new Set(form.areas);
    for (const id of ids) {
      if (!isSelectable(id)) continue;
      if (checked) areas.add(id);
      else areas.delete(id);
    }
    onChange({ ...form, areas });
  };

  const copyFrom = (profileId: string) => {
    const source = profiles.find(profile => String(profile.id) === profileId);
    if (!source) return;
    const areas = new Set<AccessAreaId>();
    for (const area of source.areas) {
      const known = ACCESS_AREAS.find(candidate => candidate.id === area);
      if (known && (form.isAdmin || !known.adminOnly)) areas.add(known.id);
    }
    onChange({ ...form, areas });
  };

  const copySources = profiles.filter(profile => profile.id !== editingId);

  return (
    <div className="space-y-5 py-2">
      {error && (
        <div
          role="alert"
          data-testid="profile-form-error"
          className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="profile-name">{t("perfis.form.nome")}</Label>
          <Input
            id="profile-name"
            value={form.name}
            onChange={event => onChange({ ...form, name: event.target.value })}
            placeholder={t("perfis.form.nome_ph")}
            maxLength={60}
            disabled={readOnly || nameLocked}
            className="h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="profile-description">{t("perfis.form.descricao")}</Label>
          <Input
            id="profile-description"
            value={form.description}
            onChange={event => onChange({ ...form, description: event.target.value })}
            placeholder={t("perfis.form.descricao_ph")}
            maxLength={300}
            disabled={readOnly}
            className="h-9"
          />
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-2.5">
        <Switch
          id="profile-admin"
          checked={form.isAdmin}
          onCheckedChange={setAdmin}
          disabled={readOnly}
          aria-label={t("perfis.form.admin")}
          data-testid="switch-profile-admin"
        />
        <div className="space-y-0.5">
          <Label htmlFor="profile-admin" className="text-sm font-medium">{t("perfis.form.admin")}</Label>
          <p className="text-xs text-muted-foreground">{t("perfis.form.admin_hint")}</p>
        </div>
      </div>

      {!readOnly && copySources.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-xs">{t("perfis.form.copiar")}</Label>
          <Select value="" onValueChange={copyFrom}>
            <SelectTrigger className="h-9 sm:max-w-xs" data-testid="select-copy-profile">
              <SelectValue placeholder={t("perfis.form.copiar_ph")} />
            </SelectTrigger>
            <SelectContent>
              {copySources.map(profile => (
                <SelectItem key={profile.id} value={String(profile.id)}>{profileLabel(profile.name, t)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("perfis.form.copiar_hint")}</p>
        </div>
      )}

      <div className="space-y-3">
        <Label className="text-xs">{t("perfis.form.areas")}</Label>
        {ACCESS_SECTIONS.map(section => {
          const areas = areasBySection(section);
          const selectable = areas.filter(area => isSelectable(area.id));
          const allChecked = selectable.length > 0 && selectable.every(area => form.areas.has(area.id));
          return (
            <div key={section} className="rounded-md border border-border/60" data-testid={`section-${section}`}>
              <div className="flex items-center justify-between gap-2 border-b border-border/50 bg-muted/30 px-3 py-1.5">
                <span className="text-[11px] font-bold tracking-widest text-muted-foreground">
                  {t(SECTION_LABEL_KEYS[section])}
                </span>
                {!readOnly && selectable.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setSection(areas.map(area => area.id), !allChecked)}
                    data-testid={`button-section-${section}`}
                  >
                    {allChecked ? t("perfis.form.desmarcar_todas") : t("perfis.form.marcar_todas")}
                  </Button>
                )}
              </div>
              <div className="grid gap-x-4 gap-y-2 px-3 py-3 sm:grid-cols-2">
                {areas.map(area => {
                  const disabled = !isSelectable(area.id);
                  const checked = form.areas.has(area.id);
                  return (
                    <div key={area.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`area-${area.id}`}
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={value => toggleArea(area.id, value === true)}
                        data-testid={`checkbox-area-${area.id}`}
                      />
                      <Label
                        htmlFor={`area-${area.id}`}
                        className={`text-sm font-normal ${disabled && !readOnly ? "text-muted-foreground" : ""}`}
                      >
                        {t(AREA_LABEL_KEYS[area.id])}
                        {area.adminOnly && (
                          <span className="ml-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {t("perfis.form.so_admin")}
                          </span>
                        )}
                      </Label>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {!readOnly && form.areas.size === 0 && (
          <div
            className="flex gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800"
            data-testid="profile-empty-warning"
          >
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
            <span>{t("perfis.form.sem_areas")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function PerfisDeAcesso() {
  const { t } = useLang();
  const queryClient = useQueryClient();
  const { data: profiles, isLoading, isError, refetch } = useListAccessProfiles();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AccessProfile | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<AccessProfile | null>(null);

  const refreshProfiles = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/access-profiles"] });
  // O perfil de quem está logado pode ter mudado: o menu é revalidado.
  const refreshMyAccess = () => queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
  const refreshUsers = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });

  const closeDialog = () => {
    setDialogOpen(false);
    setEditing(null);
    setFormError(undefined);
  };

  const createMutation = useCreateAccessProfile({
    mutation: {
      onSuccess: () => {
        void refreshProfiles();
        closeDialog();
        toast.success(t("perfis.criado"));
      },
      onError: err => setFormError(describeProfileError(err, t)),
    },
  });

  const updateMutation = useUpdateAccessProfile({
    mutation: {
      onSuccess: () => {
        void refreshProfiles();
        void refreshMyAccess();
        void refreshUsers();
        closeDialog();
        toast.success(t("perfis.atualizado"));
      },
      onError: err => {
        setFormError(describeProfileError(err, t));
        if (err instanceof ApiError && (err.data as ServerErrorBody | null)?.code === "NOT_FOUND") void refreshProfiles();
      },
    },
  });

  const deleteMutation = useDeleteAccessProfile({
    mutation: {
      onSuccess: () => {
        void refreshProfiles();
        setDeleteTarget(null);
        toast.success(t("perfis.excluido"));
      },
      onError: err => {
        setDeleteTarget(null);
        void refreshProfiles();
        toast.error(describeProfileError(err, t));
      },
    },
  });

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, areas: new Set() });
    setFormError(undefined);
    setDialogOpen(true);
  };

  const openEdit = (profile: AccessProfile) => {
    setEditing(profile);
    setForm(formFromProfile(profile));
    setFormError(undefined);
    setDialogOpen(true);
  };

  const handleSave = () => {
    setFormError(undefined);
    const name = form.name.trim();
    if (name.length < 2) {
      setFormError(t("perfis.form.nome_curto"));
      return;
    }
    const areas = ACCESS_AREAS.map(area => area.id).filter(id => form.areas.has(id));
    const data = { name, description: form.description.trim(), isAdmin: form.isAdmin, areas };
    if (editing) updateMutation.mutate({ id: editing.id, data });
    else createMutation.mutate({ data });
  };

  const saving = createMutation.isPending || updateMutation.isPending;
  const readOnly = editing?.locked === true;
  const sortedProfiles = useMemo(() => profiles ?? [], [profiles]);

  const changeSummary = (profile: AccessProfile): string => {
    const when = formatDateTimeBR(profile.updatedAt);
    const who = profile.updatedByName === "Sistema" ? t("perfis.por_sistema") : profile.updatedByName;
    return who ? `${when} ${t("perfis.por")} ${who}` : when;
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1 flex items-center gap-2">
            <ShieldCheck className="h-7 w-7 text-primary" />
            {t("perfis.title")}
          </h1>
          <p className="text-muted-foreground text-sm max-w-2xl">{t("perfis.subtitle")}</p>
        </div>
        <Button onClick={openCreate} className="gap-2 bg-sofia hover:bg-sofia/90 text-white" data-testid="button-new-profile">
          <Plus className="h-4 w-4" />
          {t("perfis.novo")}
        </Button>
      </div>

      <Card className="shadow-sm border-border/40">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center" data-testid="profiles-error">
              <AlertTriangle className="h-8 w-8 text-amber-500" />
              <p className="text-sm text-muted-foreground">{t("perfis.erro_carregar")}</p>
              <Button variant="outline" size="sm" onClick={() => { void refetch(); }}>{t("perfis.tentar_novamente")}</Button>
            </div>
          ) : sortedProfiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground/60 gap-3">
              <ShieldCheck className="h-10 w-10 opacity-30" />
              <p className="text-sm">{t("perfis.vazio")}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border/30">
                  <TableHead className="pl-5">{t("perfis.col.nome")}</TableHead>
                  <TableHead>{t("perfis.col.areas")}</TableHead>
                  <TableHead className="text-right">{t("perfis.col.usuarios")}</TableHead>
                  <TableHead>{t("perfis.col.alteracao")}</TableHead>
                  <TableHead className="text-right pr-5">{t("perfis.col.acoes")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedProfiles.map(profile => (
                  <TableRow key={profile.id} className="border-border/20" data-testid={`row-profile-${profile.id}`}>
                    <TableCell className="pl-5 align-top">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium">{profileLabel(profile.name, t)}</span>
                        {profile.locked && (
                          <Badge variant="outline" className="gap-1 text-[10px]"><Lock className="h-2.5 w-2.5" />{t("perfis.badge.fixo")}</Badge>
                        )}
                        {profile.isSystem && !profile.locked && (
                          <Badge variant="outline" className="text-[10px]">{t("perfis.badge.sistema")}</Badge>
                        )}
                        {profile.isAdmin && (
                          <Badge className="bg-violet-100 text-violet-800 border border-violet-200 hover:bg-violet-100 text-[10px]">
                            {t("perfis.badge.admin")}
                          </Badge>
                        )}
                      </div>
                      {profileDescription(profile, t) && (
                        <p className="mt-0.5 max-w-md text-xs text-muted-foreground">{profileDescription(profile, t)}</p>
                      )}
                    </TableCell>
                    <TableCell className="align-top text-sm">
                      {t("perfis.areas_count")
                        .replace("{count}", String(profile.areas.length))
                        .replace("{total}", String(ACCESS_AREAS.length))}
                      {profile.areas.length === 0 && (
                        <AlertTriangle className="ml-1.5 inline h-3.5 w-3.5 text-amber-500" aria-label={t("perfis.form.sem_areas")} />
                      )}
                    </TableCell>
                    <TableCell className="align-top text-right text-sm tabular-nums">{profile.userCount}</TableCell>
                    <TableCell className="align-top text-xs text-muted-foreground">{changeSummary(profile)}</TableCell>
                    <TableCell className="align-top pr-5">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          title={profile.locked ? t("perfis.ver") : t("perfis.editar")}
                          aria-label={profile.locked ? t("perfis.ver") : t("perfis.editar")}
                          onClick={() => openEdit(profile)}
                          data-testid={`button-edit-profile-${profile.id}`}
                        >
                          {profile.locked ? <Eye className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                        </Button>
                        {!profile.isSystem && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            title={t("perfis.excluir")}
                            aria-label={t("perfis.excluir")}
                            onClick={() => setDeleteTarget(profile)}
                            data-testid={`button-delete-profile-${profile.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={open => { if (!open && !saving) closeDialog(); }}>
        <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {!editing ? t("perfis.form.criar_title") : readOnly ? t("perfis.form.ver_title") : t("perfis.form.editar_title")}
            </DialogTitle>
            <DialogDescription>
              {readOnly ? t("perfis.fixo_hint") : editing?.isSystem ? t("perfis.sistema_hint") : t("perfis.subtitle")}
            </DialogDescription>
          </DialogHeader>
          <ProfileForm
            form={form}
            onChange={setForm}
            profiles={sortedProfiles}
            editingId={editing?.id ?? null}
            readOnly={readOnly}
            nameLocked={editing?.isSystem === true}
            error={formError}
          />
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={saving}>
              {readOnly ? "OK" : t("common.cancelar")}
            </Button>
            {!readOnly && (
              <Button onClick={handleSave} disabled={saving} className="bg-sofia hover:bg-sofia/90 text-white" data-testid="button-save-profile">
                {saving ? t("perfis.form.salvando") : editing ? t("perfis.form.salvar") : t("perfis.form.criar")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={open => { if (!open && !deleteMutation.isPending) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("perfis.excluir_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deleteTarget?.name}</strong> — {t("perfis.excluir_desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>{t("common.cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={event => {
                event.preventDefault();
                if (deleteTarget) deleteMutation.mutate({ id: deleteTarget.id });
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-profile"
            >
              {deleteMutation.isPending ? t("perfis.excluindo") : t("perfis.excluir_btn")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
