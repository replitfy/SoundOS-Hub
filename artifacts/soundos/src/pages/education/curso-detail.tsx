import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useLocation, Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import type { FormalizacaoInfo } from "@/lib/formalizacao";
import { FormalizacaoActions, FormalizacaoStatus } from "./formalizacao-panel";
import { useUserSession } from "@/contexts/user-session";
import { useAccess } from "@/contexts/access";
import { useLang } from "@/contexts/language";
import {
  ArrowLeft, Copy, Eye, ExternalLink,
  Plus, Trash2, Save, FileText, Users,
  CheckCircle2, ArrowUp, ArrowDown, Settings2
} from "lucide-react";

// --- Types ---
interface FormField {
  key: string;
  label: string;
  type: 'text' | 'email' | 'tel' | 'date' | 'textarea' | 'select';
  required: boolean;
  active?: boolean;
  options?: string[];
}

interface FormVersion {
  id: number;
  numero: number;
  campos: FormField[];
  createdAt: string;
}

interface EventForm {
  id: number;
  eventoId: number;
  tipo: 'INTERESSE' | 'COMPLETO';
  slug: string;
  ativo: boolean;
  versoes: FormVersion[];
}

interface EventDetail {
  id: number;
  nome: string;
  slug: string;
  descricao: string | null;
  local: string | null;
  dataInicio: string | null;
  dataFim: string | null;
  observacoes: string | null;
  ativo: boolean;
  nucleo: string;
  tipoEvento: string;
  courseId: number | null;
  classId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface Matriculado {
  enrollmentId: number;
  pessoaId: number;
  nome: string;
  sobrenome: string | null;
  email: string | null;
  celular: string | null;
  paymentStatus: string;
  contractStatus: string;
}

interface PreInscrito {
  id: number;
  pessoaId: number;
  nome: string;
  sobrenome: string | null;
  email: string | null;
  celular: string | null;
  latestAnswers: Record<string, unknown>;
  formalizacao?: FormalizacaoInfo | null;
}

interface Interessado {
  id: number;
  pessoaId: number;
  nome: string;
  sobrenome: string | null;
  email: string | null;
  celular: string | null;
  formalizacao?: FormalizacaoInfo | null;
}

interface DetalheData {
  event: EventDetail;
  matriculados: Matriculado[];
  preinscritos: PreInscrito[];
  interessados: Interessado[];
}

// --- Draggable Field List (Simplified without dnd library for now, using up/down buttons) ---
function FieldEditor({
  field,
  index,
  isCore,
  alwaysOptional,
  isAdmin,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast
}: {
  field: FormField;
  index: number;
  isCore: boolean;
  /** Campo essencial que nunca é obrigatório (Instagram no formulário de interesse). */
  alwaysOptional: boolean;
  isAdmin: boolean;
  onUpdate: (f: FormField) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  return (
    <div className={`flex gap-3 p-3 border border-border/50 rounded-lg items-start relative group ${field.active === false ? "bg-muted/50 opacity-70" : "bg-muted/30"}`}>
      <div className="flex flex-col gap-1 mt-1">
        <Button size="sm" variant="ghost" className="h-5 w-5 p-0" onClick={onMoveUp} disabled={isFirst || !isAdmin}>
          <ArrowUp className="h-3 w-3" />
        </Button>
        <Button size="sm" variant="ghost" className="h-5 w-5 p-0" onClick={onMoveDown} disabled={isLast || !isAdmin}>
          <ArrowDown className="h-3 w-3" />
        </Button>
      </div>

      <div className="flex-1 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Chave / ID</Label>
            <Input
              value={field.key}
              disabled
              className="h-8 text-xs font-mono"
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label className="text-xs">Texto exibido no formulário</Label>
            <Input
              value={field.label}
              onChange={e => onUpdate({ ...field, label: e.target.value })}
              disabled={!isAdmin}
              className="h-8 text-xs"
              placeholder="Digite a pergunta ou o nome do campo"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Tipo</Label>
            <Select
              value={field.type}
              onValueChange={(val: FormField["type"]) => onUpdate({ ...field, type: val })}
              disabled={isCore || !isAdmin}
            >
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="text">Texto curto</SelectItem>
                <SelectItem value="textarea">Texto longo</SelectItem>
                <SelectItem value="email">E-mail</SelectItem>
                <SelectItem value="tel">Telefone (WhatsApp)</SelectItem>
                <SelectItem value="date">Data</SelectItem>
                <SelectItem value="select">Lista de opções</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {field.type === 'select' && (
          <div className="space-y-1">
            <Label className="text-xs">Opções (separadas por vírgula)</Label>
            <Input
              value={field.options?.join(', ') || ''}
              onChange={e => onUpdate({ ...field, options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
              disabled={!isAdmin}
              placeholder="Opção 1, Opção 2, Opção 3"
              className="h-8 text-xs"
            />
          </div>
        )}

        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <Switch
              checked={field.active !== false}
              onCheckedChange={active => onUpdate({ ...field, active })}
              disabled={isCore || !isAdmin}
            />
            Campo ativo
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <Checkbox
              checked={alwaysOptional ? false : field.required}
              onCheckedChange={c => onUpdate({ ...field, required: !!c })}
              disabled={(isCore && field.required) || alwaysOptional || !isAdmin}
            />
            Obrigatório
          </label>
          {isCore && (
            <span className="text-xs text-muted-foreground">Campo essencial: não pode ser inativado.</span>
          )}
        </div>
      </div>

      {!isCore && isAdmin && (
        <Button
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

// --- Form Editor Component ---
function FormEditor({
  form,
  eventoId,
  isAdmin
}: {
  form: EventForm;
  eventoId: number;
  isAdmin: boolean;
}) {
  const { authHeader } = useUserSession();
  const qc = useQueryClient();
  const latestVersion = form.versoes[0];
  const [campos, setCampos] = useState<FormField[]>(latestVersion?.campos || []);
  const [ativo, setAtivo] = useState(form.ativo);
  const [saving, setSaving] = useState(false);

  const coreKeys = form.tipo === 'INTERESSE'
    ? ['nome', 'celular', 'instagram', 'email']
    : ['nome', 'celular', 'email'];

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/cursos-inscricao/${eventoId}/formularios/${form.tipo}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ ativo, campos })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(typeof err.error === "string" ? err.error : "Erro ao salvar formulário");
      }
      toast.success(`Formulário ${form.tipo} salvo com sucesso`);
      qc.invalidateQueries({ queryKey: ["/api/cursos-inscricao", eventoId, "formularios"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar. Verifique se as chaves são únicas.");
    } finally {
      setSaving(false);
    }
  };

  const getBaseUrl = () => {
    const base = import.meta.env.BASE_URL;
    const path = base.endsWith('/') ? base.slice(0, -1) : base;
    return window.location.origin + path;
  };

  const copyIframe = () => {
    const url = `${getBaseUrl()}/${form.tipo === 'INTERESSE' ? 'interesse' : 'inscricao'}/${form.slug}?embed=1`;
    const code = `<iframe src="${url}" width="100%" height="600" frameborder="0" style="border:none; border-radius: 8px;"></iframe>`;
    navigator.clipboard.writeText(code);
    toast.success("Código iframe copiado!");
  };

  const copyLink = () => {
    const url = `${getBaseUrl()}/${form.tipo === 'INTERESSE' ? 'interesse' : 'inscricao'}/${form.slug}`;
    navigator.clipboard.writeText(url);
    toast.success("Link copiado!");
  };

  const addField = () => {
    setCampos([...campos, { key: `campo_${Date.now()}`, label: "Novo Campo", type: "text", required: false, active: true }]);
  };

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="py-4 px-5 border-b border-border/40 flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            {form.tipo === 'INTERESSE' ? 'Lista de Interesse' : 'Inscrição Completa'}
            <Badge variant={ativo ? "default" : "secondary"} className="text-[10px]">
              {ativo ? 'Ativo' : 'Inativo'}
            </Badge>
          </CardTitle>
          <CardDescription className="text-xs mt-1">
            /{form.tipo === 'INTERESSE' ? 'interesse' : 'inscricao'}/{form.slug}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <div className="flex items-center gap-2 mr-4 border-r border-border pr-4">
              <Switch checked={ativo} onCheckedChange={setAtivo} />
              <Label className="text-sm font-medium">Habilitado</Label>
            </div>
          )}
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={copyLink}>
            <Copy className="h-3.5 w-3.5 mr-1.5" /> Link
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={copyIframe}>
            <ExternalLink className="h-3.5 w-3.5 mr-1.5" /> Iframe Wix
          </Button>
          <Button size="sm" variant="secondary" className="h-8 text-xs" asChild>
            <a href={`${getBaseUrl()}/${form.tipo === 'INTERESSE' ? 'interesse' : 'inscricao'}/${form.slug}`} target="_blank" rel="noreferrer">
              <Eye className="h-3.5 w-3.5 mr-1.5" /> Preview
            </a>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-5 space-y-6">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Campos do Formulário</h3>
            {isAdmin && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={addField}>
                <Plus className="h-3 w-3 mr-1" /> Adicionar Campo
              </Button>
            )}
          </div>

          <div className="space-y-3">
            {campos.map((field, i) => (
              <FieldEditor
                key={i}
                field={field}
                index={i}
                isCore={coreKeys.includes(field.key)}
                alwaysOptional={form.tipo === 'INTERESSE' && field.key === 'instagram'}
                isAdmin={isAdmin}
                isFirst={i === 0}
                isLast={i === campos.length - 1}
                onUpdate={f => {
                  const newC = [...campos];
                  newC[i] = f;
                  setCampos(newC);
                }}
                onRemove={() => {
                  setCampos(campos.filter((_, idx) => idx !== i));
                }}
                onMoveUp={() => {
                  if (i === 0) return;
                  const newC = [...campos];
                  [newC[i-1], newC[i]] = [newC[i], newC[i-1]];
                  setCampos(newC);
                }}
                onMoveDown={() => {
                  if (i === campos.length - 1) return;
                  const newC = [...campos];
                  [newC[i+1], newC[i]] = [newC[i], newC[i+1]];
                  setCampos(newC);
                }}
              />
            ))}
          </div>
        </div>

        {isAdmin && (
          <div className="flex justify-end pt-2 border-t border-border/40">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Salvando..." : <><Save className="h-4 w-4 mr-2" /> Salvar Versão</>}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Confirmation Dialog ---
function ConfirmationDialog({ open, onClose, matricula, eventoId }: { open: boolean, onClose: () => void, matricula: PreInscrito, eventoId: number }) {
  const { authHeader } = useUserSession();
  const qc = useQueryClient();
  const [price, setPrice] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("pending");
  const [contractStatus, setContractStatus] = useState("pending");
  const [saving, setSaving] = useState(false);

  const confirm = async () => {
    if (!price) {
      toast.error("Informe o preço");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/cursos-inscricao/${eventoId}/preinscricoes/${matricula.id}/confirmar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          price: Number(price.replace(',', '.')),
          paymentStatus,
          contractStatus
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(typeof err.error === "string" ? err.error : "Erro ao confirmar");
      }
      toast.success("Inscrição confirmada e convertida em matrícula!");
      qc.invalidateQueries({ queryKey: ["/api/cursos-inscricao", eventoId, "detalhe"] });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao confirmar");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirmar Matrícula</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <p className="text-sm text-muted-foreground">
            Confirme a inscrição de <strong>{matricula?.nome} {matricula?.sobrenome}</strong> gerando uma matrícula na turma vinculada.
          </p>
          <div className="space-y-1">
            <Label>Valor Acordado (R$)</Label>
            <Input type="number" step="0.01" value={price} onChange={e => setPrice(e.target.value)} placeholder="0.00" />
          </div>
          <div className="space-y-1">
            <Label>Status do Pagamento</Label>
            <Select value={paymentStatus} onValueChange={setPaymentStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pendente</SelectItem>
                <SelectItem value="paid">Pago</SelectItem>
                <SelectItem value="installments">Parcelado</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Status do Contrato</Label>
            <Select value={contractStatus} onValueChange={setContractStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pendente</SelectItem>
                <SelectItem value="signed">Assinado</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={confirm} disabled={saving || !price}>Confirmar Matrícula</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Main Page ---
export default function EducationCursoDetail() {
  const { t } = useLang();
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { authHeader } = useUserSession();
  const { isAdmin: isAdminProfile } = useAccess();
  const initialParams = new URLSearchParams(window.location.search);
  const [readOnly, setReadOnly] = useState(initialParams.get("view") === "readonly");
  const [activeTab, setActiveTab] = useState(initialParams.get("tab") === "forms" ? "forms" : "pessoas");
  const isAdmin = !readOnly && isAdminProfile;

  const [confirmTarget, setConfirmTarget] = useState<PreInscrito | null>(null);

  const { data: event, isLoading: loadingEvt } = useQuery<EventDetail>({
    queryKey: ["/api/cursos-inscricao", Number(id)],
    queryFn: async () => {
      const r = await fetch(`/api/cursos-inscricao/${id}`, { headers: authHeader });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    }
  });

  const { data: formularios, isLoading: loadingForms } = useQuery<EventForm[]>({
    queryKey: ["/api/cursos-inscricao", Number(id), "formularios"],
    queryFn: async () => {
      const r = await fetch(`/api/cursos-inscricao/${id}/formularios`, { headers: authHeader });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    }
  });

  const editableForms = (formularios ?? []).filter(form => form.tipo !== 'INTERESSE');

  const { data: detalhe, isLoading: loadingDet } = useQuery<DetalheData>({
    queryKey: ["/api/cursos-inscricao", Number(id), "detalhe"],
    refetchInterval: 30_000,
    refetchOnWindowFocus: "always",
    queryFn: async () => {
      const r = await fetch(`/api/cursos-inscricao/${id}/detalhe`, { headers: authHeader });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    }
  });

  if (loadingEvt) return <div className="p-8"><Skeleton className="h-8 w-64 mb-4" /><Skeleton className="h-40 w-full" /></div>;
  if (!event) return <div className="p-8 text-center text-muted-foreground">Evento não encontrado.</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/education/cursos")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{event.nome}</h1>
            <p className="text-sm text-muted-foreground">
              {readOnly ? "Ficha completa do evento · somente leitura" : "Gerenciamento de inscrições e formulários"}
            </p>
          </div>
        </div>
      </div>

      <Card className="border-border/50 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base">Informações do evento</CardTitle>
              <CardDescription>Dados gerais cadastrados para esta edição.</CardDescription>
            </div>
            <Badge variant={event.ativo ? "default" : "secondary"}>
              {event.ativo ? "Ativo" : "Arquivado"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-border/40 pt-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["Tipo", event.tipoEvento],
            ["Núcleo", event.nucleo === "EDUCATION" ? "Education" : "Experiences"],
            ["Data de início", event.dataInicio ? event.dataInicio.split("-").reverse().join("/") : "—"],
            ["Data de fim", event.dataFim ? event.dataFim.split("-").reverse().join("/") : "—"],
            ["Local", event.local || "—"],
            ["Turma vinculada", event.classId ? `#${event.classId}` : "Sem turma"],
            ["Curso vinculado", event.courseId ? `#${event.courseId}` : "Sem curso"],
            ["Slug", event.slug],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
              <p className="mt-1 break-words text-sm text-foreground">{value}</p>
            </div>
          ))}
          {event.descricao && (
            <div className="sm:col-span-2 lg:col-span-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Descrição</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{event.descricao}</p>
            </div>
          )}
          {event.observacoes && (
            <div className="sm:col-span-2 lg:col-span-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Observações</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{event.observacoes}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="space-y-6"
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <TabsList className="bg-muted/50 w-full justify-start rounded-lg h-auto p-1 sm:w-auto">
            <TabsTrigger value="pessoas" className="py-2 px-4 gap-2 data-[state=active]:bg-background">
              <Users className="h-4 w-4" /> Pessoas ({detalhe ? (detalhe.interessados?.length + detalhe.preinscritos?.length + detalhe.matriculados?.length) : '...'})
            </TabsTrigger>
            <TabsTrigger value="forms" className="py-2 px-4 gap-2 data-[state=active]:bg-background">
              <FileText className="h-4 w-4" /> {readOnly ? "Formulários" : "Formulários Configuráveis"}
            </TabsTrigger>
          </TabsList>
          {readOnly && isAdminProfile && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setReadOnly(false);
                setActiveTab("forms");
                window.history.replaceState(null, "", `/education/cursos/${event.id}?tab=forms`);
              }}
            >
              <Settings2 className="mr-2 h-4 w-4" />
              Editar formulários
            </Button>
          )}
        </div>

        <TabsContent value="pessoas" className="space-y-6 outline-none">
          {!detalhe ? <Skeleton className="h-64" /> : (
            <>
              {/* Matriculados (Confirmed) */}
              <Card className="border-border/50 shadow-sm">
                <CardHeader className="py-4 border-b border-border/40 bg-green-50/30 dark:bg-green-950/10">
                  <CardTitle className="text-base flex items-center gap-2 text-green-700 dark:text-green-400">
                    <CheckCircle2 className="h-4 w-4" /> Matrículas Confirmadas ({detalhe.matriculados?.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {detalhe.matriculados?.length === 0 ? (
                    <div className="p-6 text-center text-sm text-muted-foreground">Nenhuma matrícula confirmada.</div>
                  ) : (
                    <div className="divide-y divide-border/40">
                      {detalhe.matriculados.map((m) => (
                        <div key={m.enrollmentId} className="p-4 flex items-center justify-between hover:bg-muted/20">
                          <div>
                            <p className="font-medium text-sm">
                              <a href={`/pessoas/${m.pessoaId}`} className="hover:underline">{m.nome} {m.sobrenome}</a>
                            </p>
                            <div className="text-xs text-muted-foreground mt-0.5 flex gap-3">
                              <span>{m.email}</span>
                              <span>{m.celular}</span>
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-1 text-xs">
                            <Badge variant="outline" className="font-normal border-green-200 text-green-700 bg-green-50">
                              Matriculado
                            </Badge>
                            <span className="text-muted-foreground">{t("fz.status.payment")}: {m.paymentStatus === "paid" ? t("fz.status.paid") : m.paymentStatus === "installments" ? t("fz.status.installments") : t("fz.status.pending")}</span>
                            <span className="text-muted-foreground">{t("fz.status.contract")}: {m.contractStatus === "signed" ? t("fz.status.contract_signed") : t("fz.status.contract_pending")}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Pre-inscritos (COMPLETO form) */}
              <Card className="border-border/50 shadow-sm">
                <CardHeader className="py-4 border-b border-border/40">
                  <CardTitle className="text-base flex items-center gap-2">
                    Pré-inscrições ({detalhe.preinscritos?.length})
                  </CardTitle>
                  <CardDescription className="text-xs">Preencheram o formulário completo</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  {detalhe.preinscritos?.length === 0 ? (
                    <div className="p-6 text-center text-sm text-muted-foreground">Nenhuma pré-inscrição.</div>
                  ) : (
                    <div className="divide-y divide-border/40">
                      {detalhe.preinscritos.map((m) => (
                        <div key={m.id} className="p-4 flex items-center justify-between hover:bg-muted/20">
                          <div>
                            <p className="font-medium text-sm">
                              <a href={`/pessoas/${m.pessoaId}`} className="hover:underline">{m.nome} {m.sobrenome}</a>
                            </p>
                            <div className="text-xs text-muted-foreground mt-0.5 flex gap-3">
                              <span>{m.email}</span>
                              <span>{m.celular}</span>
                            </div>
                            {m.latestAnswers && (
                              <div className="mt-2 text-[11px] text-muted-foreground/80 line-clamp-1">
                                {Object.entries(m.latestAnswers).map(([k,v]) => `${k}: ${v}`).join(' | ')}
                              </div>
                            )}
                            <div className="mt-2"><FormalizacaoStatus f={m.formalizacao} rowId={m.id} /></div>
                          </div>
                          <div className="flex flex-col items-end gap-2">
                            {isAdmin && <FormalizacaoActions eventoId={event.id} preId={m.id} nome={`${m.nome} ${m.sobrenome ?? ""}`.trim()} f={m.formalizacao} />}
                            {isAdmin && event.classId ? (
                              <Button size="sm" variant="secondary" onClick={() => setConfirmTarget(m)}>
                                Confirmar Matrícula
                              </Button>
                            ) : (
                              <Badge variant="secondary">Pendente</Badge>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Interessados (INTERESSE form) */}
              <Card className="border-border/50 shadow-sm">
                <CardHeader className="py-4 border-b border-border/40">
                  <CardTitle className="text-base flex items-center gap-2">
                    Interessados ({detalhe.interessados?.length})
                  </CardTitle>
                  <CardDescription className="text-xs">Preencheram a lista de interesse</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  {detalhe.interessados?.length === 0 ? (
                    <div className="p-6 text-center text-sm text-muted-foreground">Nenhum interessado.</div>
                  ) : (
                    <div className="divide-y divide-border/40">
                      {detalhe.interessados.map((m) => (
                        <div key={m.id} className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between hover:bg-muted/20">
                          <div>
                            <p className="font-medium text-sm">
                              <a href={`/pessoas/${m.pessoaId}`} className="hover:underline">{m.nome} {m.sobrenome}</a>
                            </p>
                            <div className="text-xs text-muted-foreground mt-0.5 flex gap-3">
                              <span>{m.email}</span>
                              <span>{m.celular}</span>
                            </div>
                            <div className="mt-2"><FormalizacaoStatus f={m.formalizacao} rowId={m.id} /></div>
                          </div>
                          {isAdmin && <FormalizacaoActions eventoId={event.id} preId={m.id} nome={`${m.nome} ${m.sobrenome ?? ""}`.trim()} f={m.formalizacao} />}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="forms" className="space-y-6 outline-none">
          {/* O formulário de interesse agora é único (genérico); o de evento só segue recebendo cadastros pelos links antigos. */}
          <p className="text-xs text-muted-foreground" data-testid="interesse-generico-aviso">
            A lista de interesse agora é um formulário único para o site. O link e o código de iframe ficam na página{" "}
            <Link href="/education/interesse" className="underline">Formulário de interesse</Link>.
          </p>
          {loadingForms ? <Skeleton className="h-64" /> : !editableForms.length ? (
            <div className="p-8 text-center border rounded-xl border-dashed">
              <p className="text-muted-foreground">Nenhum formulário configurável retornado pela API para este evento.</p>
            </div>
          ) : (
            <>
              {editableForms.map(form => (
                <FormEditor key={form.id} form={form} eventoId={event.id} isAdmin={isAdmin} />
              ))}
            </>
          )}
        </TabsContent>
      </Tabs>

      {confirmTarget && (
        <ConfirmationDialog
          open={!!confirmTarget}
          onClose={() => setConfirmTarget(null)}
          matricula={confirmTarget}
          eventoId={event.id}
        />
      )}
    </div>
  );
}
