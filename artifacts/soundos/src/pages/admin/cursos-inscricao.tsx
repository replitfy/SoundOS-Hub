import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Plus, Pencil, Copy, Check, X, Link, CalendarDays, MapPin, BookOpen, Power } from "lucide-react";
import { useUserSession } from "@/contexts/user-session";
import { formatDateBR } from "@/lib/date";

interface CursoInscricao {
  id: number;
  slug: string;
  nome: string;
  descricao: string | null;
  local: string | null;
  dataInicio: string | null;
  dataFim: string | null;
  observacoes: string | null;
  ativo: boolean;
  createdAt: string;
  updatedAt: string;
}

const empty = { nome: "", descricao: "", local: "", dataInicio: "", dataFim: "", observacoes: "" };

function getPublicUrl(slug: string) {
  const base = window.location.origin;
  return `${base}/inscricao/${slug}`;
}

function CursoForm({
  initial,
  onSave,
  onCancel,
  isPending,
}: {
  initial: typeof empty;
  onSave: (data: typeof empty) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [form, setForm] = useState(initial);
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <div className="space-y-3 bg-muted/30 rounded-lg p-4 border border-border/40">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Nome do curso *</Label>
          <Input value={form.nome} onChange={set("nome")} placeholder="Ex: Formação em Sound Healing — Turma 12" className="h-8 text-sm" />
        </div>
        <div className="col-span-2 space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Descrição</Label>
          <Textarea value={form.descricao} onChange={set("descricao")} placeholder="Descrição breve do curso" className="text-sm min-h-[60px] resize-none" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Local</Label>
          <Input value={form.local} onChange={set("local")} placeholder="Ex: São Paulo — SP" className="h-8 text-sm" />
        </div>
        <div className="space-y-1" />
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Data início</Label>
          <Input type="date" value={form.dataInicio} onChange={set("dataInicio")} className="h-8 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Data fim</Label>
          <Input type="date" value={form.dataFim} onChange={set("dataFim")} className="h-8 text-sm" />
        </div>
        <div className="col-span-2 space-y-1">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Observações internas</Label>
          <Textarea value={form.observacoes} onChange={set("observacoes")} placeholder="Notas internas" className="text-sm min-h-[50px] resize-none" />
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>
          <X className="h-3.5 w-3.5 mr-1" /> Cancelar
        </Button>
        <Button size="sm" className="h-8" onClick={() => onSave(form)} disabled={!form.nome.trim() || isPending}>
          <Check className="h-3.5 w-3.5 mr-1" /> Salvar
        </Button>
      </div>
    </div>
  );
}

export default function AdminCursosInscricao() {
  const qc = useQueryClient();
  const { user, authHeader } = useUserSession();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(empty);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const { data: cursos = [], isLoading } = useQuery<CursoInscricao[]>({
    queryKey: ["/api/cursos-inscricao"],
    queryFn: async () => {
      const r = await fetch("/api/cursos-inscricao", { headers: authHeader });
      if (!r.ok) throw new Error("Erro ao carregar cursos");
      return r.json();
    },
    enabled: !!user?.id,
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof empty) => {
      const r = await fetch("/api/cursos-inscricao", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error("Erro ao criar curso");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/cursos-inscricao"] });
      setCreating(false);
      toast.success("Curso criado com sucesso");
    },
    onError: () => toast.error("Erro ao criar curso"),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: typeof empty }) => {
      const r = await fetch(`/api/cursos-inscricao/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error("Erro ao atualizar");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/cursos-inscricao"] });
      setEditingId(null);
      toast.success("Curso atualizado");
    },
    onError: () => toast.error("Erro ao atualizar curso"),
  });

  const toggleAtivoMutation = useMutation({
    mutationFn: async ({ id, ativo }: { id: number; ativo: boolean }) => {
      const r = await fetch(`/api/cursos-inscricao/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ ativo }),
      });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/cursos-inscricao"] }),
    onError: () => toast.error("Erro ao alterar status"),
  });

  const copyLink = async (curso: CursoInscricao) => {
    const url = getPublicUrl(curso.slug);
    await navigator.clipboard.writeText(url);
    setCopiedId(curso.id);
    toast.success("Link copiado!");
    setTimeout(() => setCopiedId(null), 2000);
  };

  const startEdit = (c: CursoInscricao) => {
    setEditingId(c.id);
    setEditForm({
      nome: c.nome,
      descricao: c.descricao ?? "",
      local: c.local ?? "",
      dataInicio: c.dataInicio ?? "",
      dataFim: c.dataFim ?? "",
      observacoes: c.observacoes ?? "",
    });
  };

  const genericLink = `${window.location.origin}/inscricao`;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Cursos & Links de Inscrição</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Crie cursos e compartilhe o link de inscrição pública com alunos.
          </p>
        </div>
        <Button size="sm" onClick={() => { setCreating(true); setEditingId(null); }} disabled={creating}>
          <Plus className="h-4 w-4 mr-1" /> Novo Curso
        </Button>
      </div>

      {/* Link genérico */}
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="py-3 px-4 flex items-center gap-3">
          <Link className="h-4 w-4 text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-primary">Link genérico de inscrição</p>
            <p className="text-xs text-muted-foreground truncate">{genericLink}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Para novos contatos ou alunos atualizando dados — sem vínculo com curso específico.
            </p>
          </div>
          <Button size="sm" variant="outline" className="h-7 shrink-0"
            onClick={async () => { await navigator.clipboard.writeText(genericLink); toast.success("Link copiado!"); }}>
            <Copy className="h-3 w-3 mr-1" /> Copiar
          </Button>
        </CardContent>
      </Card>

      {/* Create form */}
      {creating && (
        <CursoForm
          initial={empty}
          onSave={data => createMutation.mutate(data)}
          onCancel={() => setCreating(false)}
          isPending={createMutation.isPending}
        />
      )}

      {/* List */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground text-center py-8">Carregando...</p>
      ) : cursos.length === 0 && !creating ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <BookOpen className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">Nenhum curso cadastrado ainda.</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Clique em "Novo Curso" para começar.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {cursos.map(c => (
            <Card key={c.id} className={`shadow-sm transition-opacity ${!c.ativo ? "opacity-60" : ""}`}>
              {editingId === c.id ? (
                <CardContent className="pt-4 pb-3">
                  <CursoForm
                    initial={editForm}
                    onSave={data => updateMutation.mutate({ id: c.id, data })}
                    onCancel={() => setEditingId(null)}
                    isPending={updateMutation.isPending}
                  />
                </CardContent>
              ) : (
                <CardContent className="py-4 px-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-foreground">{c.nome}</span>
                        <Badge variant={c.ativo ? "default" : "secondary"} className="text-[10px] h-4">
                          {c.ativo ? "Ativo" : "Inativo"}
                        </Badge>
                      </div>
                      {c.descricao && (
                        <p className="text-xs text-muted-foreground mt-0.5">{c.descricao}</p>
                      )}
                      <div className="flex items-center gap-4 mt-1.5 flex-wrap">
                        {c.local && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <MapPin className="h-3 w-3" /> {c.local}
                          </span>
                        )}
                        {(c.dataInicio || c.dataFim) && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <CalendarDays className="h-3 w-3" />
                            {formatDateBR(c.dataInicio, "?")} {c.dataFim ? `→ ${formatDateBR(c.dataFim, "?")}` : ""}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex items-center gap-1.5">
                        <Link className="h-3 w-3 text-muted-foreground/60 shrink-0" />
                        <span className="text-[11px] text-muted-foreground truncate max-w-xs">
                          /inscricao/{c.slug}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"
                        onClick={() => copyLink(c)}>
                        {copiedId === c.id
                          ? <Check className="h-3 w-3 text-green-600" />
                          : <Copy className="h-3 w-3" />}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2"
                        onClick={() => startEdit(c)}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="ghost"
                        className={`h-7 px-2 ${c.ativo ? "text-destructive/70 hover:text-destructive" : "text-green-600 hover:text-green-700"}`}
                        onClick={() => toggleAtivoMutation.mutate({ id: c.id, ativo: !c.ativo })}
                        disabled={toggleAtivoMutation.isPending}
                        title={c.ativo ? "Desativar" : "Ativar"}>
                        <Power className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
