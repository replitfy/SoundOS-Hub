import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  Music, Layers, Plus, Pencil, Trash2, Check, X, Search,
} from "lucide-react";
import { useLang } from "@/contexts/language";
import { useUserSession } from "@/contexts/user-session";

interface CatalogItem {
  id: number;
  nome: string;
  descricao: string | null;
  ativo: boolean;
  createdAt: string;
}

const EMPTY_FORM = { nome: "", descricao: "" };

// ── Generic catalog section (reused for servicos + instrumentos) ─
function CatalogSection({
  title,
  icon: Icon,
  apiPath,
  emptyLabel,
  itemLabel,
}: {
  title: string;
  icon: React.ElementType;
  apiPath: string;
  emptyLabel: string;
  itemLabel: string;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [addingNew, setAddingNew] = useState(false);
  const [newForm, setNewForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const { t } = useLang();
  const { authHeader } = useUserSession();

  const { data: items = [], isLoading } = useQuery<CatalogItem[]>({
    queryKey: [apiPath],
    queryFn: async () => {
      const r = await fetch(apiPath, { headers: { ...authHeader } });
      if (!r.ok) throw new Error("Erro ao carregar");
      return r.json();
    },
  });

  const filtered = items.filter(i =>
    i.nome.toLowerCase().includes(search.toLowerCase()) ||
    (i.descricao ?? "").toLowerCase().includes(search.toLowerCase())
  );

  const addMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ nome: newForm.nome.trim(), descricao: newForm.descricao.trim() || null }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? t("admin.cat.err_adicionar"));
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [apiPath] });
      setAddingNew(false);
      setNewForm(EMPTY_FORM);
      toast.success(`${itemLabel} ${t("admin.cat.adicionado_sfx")}`);
    },
    onError: () => toast.error(t("admin.cat.err_adicionar")),
  });

  const editMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${apiPath}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ nome: editForm.nome.trim(), descricao: editForm.descricao.trim() || null }),
      });
      if (!r.ok) throw new Error("Erro ao salvar");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [apiPath] });
      setEditingId(null);
      toast.success(t("admin.cat.salvo"));
    },
    onError: () => toast.error(t("admin.cat.err_salvar")),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, ativo }: { id: number; ativo: boolean }) => {
      const r = await fetch(`${apiPath}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ ativo }),
      });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [apiPath] }),
    onError: () => toast.error(t("admin.cat.err_status")),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${apiPath}/${id}`, { method: "DELETE", headers: { ...authHeader } });
      if (!r.ok) throw new Error("Erro");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [apiPath] });
      toast.success(`${itemLabel} ${t("admin.cat.removido_sfx")}`);
    },
    onError: () => toast.error(t("admin.cat.err_remover")),
  });

  const startEdit = (item: CatalogItem) => {
    setEditingId(item.id);
    setEditForm({ nome: item.nome, descricao: item.descricao ?? "" });
    setAddingNew(false);
  };

  const activeCount = items.filter(i => i.ativo).length;

  return (
    <Card className="shadow-sm border-border/50">
      <CardHeader className="py-4 px-5 border-b border-border/40">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            {title}
            <Badge variant="secondary" className="text-[10px] font-normal ml-1">
              {activeCount} ativo{activeCount !== 1 ? "s" : ""}
            </Badge>
          </CardTitle>
          <Button
            size="sm"
            onClick={() => { setAddingNew(true); setEditingId(null); }}
            className="h-8 gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" /> {t("common.adicionar")}
          </Button>
        </div>
        {/* Search */}
        <div className="relative mt-3">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={`Buscar ${title.toLowerCase()}...`}
            className="h-8 pl-8 text-sm"
          />
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {/* Add new form */}
        {addingNew && (
          <div className="px-5 py-4 border-b border-border/40 bg-muted/20">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Novo {itemLabel.toLowerCase()}
            </p>
            <div className="space-y-2.5">
              <div className="space-y-1">
                <Label className="text-xs">{t("admin.cat.nome_req")}</Label>
                <Input
                  value={newForm.nome}
                  onChange={e => setNewForm(f => ({ ...f, nome: e.target.value }))}
                  className="h-8 text-sm"
                  placeholder={t("common.nome")}
                  autoFocus
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("admin.cat.descricao")}</Label>
                <Textarea
                  value={newForm.descricao}
                  onChange={e => setNewForm(f => ({ ...f, descricao: e.target.value }))}
                  className="text-sm min-h-[60px] resize-none"
                  placeholder={t("admin.cat.desc_opcional")}
                />
              </div>
              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  onClick={() => addMutation.mutate()}
                  disabled={!newForm.nome.trim() || addMutation.isPending}
                  className="h-7 px-4 text-xs"
                >
                  <Check className="h-3 w-3 mr-1" />
                  {addMutation.isPending ? t("pessoa.salvando") : t("common.salvar")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-3 text-xs"
                  onClick={() => { setAddingNew(false); setNewForm(EMPTY_FORM); }}
                >
                  <X className="h-3 w-3 mr-1" /> {t("common.cancelar")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Column headers */}
        {items.length > 0 && (
          <div className="grid grid-cols-[1fr_2fr_80px_88px] gap-4 px-5 py-2 bg-muted/30 border-b border-border/30">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t("common.nome")}</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t("admin.cat.descricao")}</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t("common.status")}</span>
            <span />
          </div>
        )}

        {isLoading && (
          <div className="flex items-center justify-center py-10 text-muted-foreground/50 text-sm">
            {t("admin.cat.carregando")}
          </div>
        )}

        {!isLoading && filtered.length === 0 && !addingNew && (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground/50 gap-2">
            <Icon className="h-8 w-8 opacity-20" />
            <p className="text-sm">{search ? t("admin.cat.nenhum_resultado") : emptyLabel}</p>
          </div>
        )}

        <div className="divide-y divide-border/30">
          {filtered.map(item => (
            <div key={item.id} className="px-5 py-3">
              {editingId === item.id ? (
                <div className="space-y-2.5">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">{t("admin.cat.nome_req")}</Label>
                      <Input
                        value={editForm.nome}
                        onChange={e => setEditForm(f => ({ ...f, nome: e.target.value }))}
                        className="h-7 text-sm"
                        autoFocus
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t("admin.cat.descricao")}</Label>
                      <Input
                        value={editForm.descricao}
                        onChange={e => setEditForm(f => ({ ...f, descricao: e.target.value }))}
                        className="h-7 text-sm"
                        placeholder={t("admin.cat.desc_opcional")}
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="h-7 px-3 text-xs gap-1"
                      onClick={() => editMutation.mutate(item.id)}
                      disabled={!editForm.nome.trim() || editMutation.isPending}
                    >
                      <Check className="h-3 w-3" /> {t("common.salvar")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-3 text-xs gap-1"
                      onClick={() => setEditingId(null)}
                    >
                      <X className="h-3 w-3" /> {t("common.cancelar")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-[1fr_2fr_80px_88px] gap-4 items-center">
                  <span className={`text-sm font-medium ${!item.ativo ? "text-muted-foreground/50 line-through" : "text-foreground"}`}>
                    {item.nome}
                  </span>
                  <span className="text-sm text-muted-foreground truncate">
                    {item.descricao ?? <span className="italic opacity-40">—</span>}
                  </span>
                  <Switch
                    checked={item.ativo}
                    onCheckedChange={ativo => toggleMutation.mutate({ id: item.id, ativo })}
                    aria-label="Ativo"
                  />
                  <div className="flex gap-1 justify-end">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => startEdit(item)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive/60 hover:text-destructive"
                      onClick={() => {
                        if (confirm(`${t("admin.cat.confirmar_remover")} "${item.nome}"?`)) deleteMutation.mutate(item.id);
                      }}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main page ───────────────────────────────────────────────────
export default function AdminCatalogos() {
  const { t } = useLang();
  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2.5">
          <Layers className="h-6 w-6 text-muted-foreground" />
          {t("admin.cat.title")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t("admin.cat.subtitle")}
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <CatalogSection
          title={t("admin.cat.servicos")}
          icon={Layers}
          apiPath="/api/admin/catalogos/servicos"
          emptyLabel={t("admin.cat.nenhum_servico")}
          itemLabel={t("admin.cat.servico")}
        />
        <CatalogSection
          title={t("admin.cat.instrumentos")}
          icon={Music}
          apiPath="/api/admin/catalogos/instrumentos"
          emptyLabel={t("admin.cat.nenhum_instrumento")}
          itemLabel={t("admin.cat.instrumento")}
        />
      </div>
    </div>
  );
}
