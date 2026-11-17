import { useState, useMemo, useEffect, useRef } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  ArrowLeft, User, MapPin, Heart, BookOpen, Activity,
  Pencil, Check, X, Phone, Mail, Globe, Leaf, MessageSquare,
  ChevronRight, Plus, Trash2, Music, AlertTriangle, Brain,
  ClipboardList, ShieldCheck, ShieldAlert, ShieldQuestion,
  FileText,
} from "lucide-react";
import { useLang } from "@/contexts/language";
import { useUserSession } from "@/contexts/user-session";
import { useAccess } from "@/contexts/access";
import { formatDateBR, formatDateTimeBR } from "@/lib/date";
import { ContatoWhatsappSection } from "./contato-whatsapp-section";
import { LojaInstrumentoRow, LojaInstrumentosStatus, useLojaInstrumentos } from "./instrumentos-loja";

// ── Catalog types ────────────────────────────────────────────────
interface CatalogEntry { id: number; nome: string; ativo: boolean; }

function useCatalog(path: string, authHeader: Record<string, string>) {
  return useQuery<CatalogEntry[]>({
    queryKey: [path],
    queryFn: async () => {
      const r = await fetch(path, { headers: { ...authHeader } });
      if (!r.ok) return [];
      const data: CatalogEntry[] = await r.json();
      return data.filter(d => d.ativo);
    },
    staleTime: 60_000,
  });
}

function CatalogSelect({
  value, onChange, entries, placeholder, autoFocus,
}: {
  value: string; onChange: (v: string) => void;
  entries: CatalogEntry[]; placeholder: string; autoFocus?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      autoFocus={autoFocus}
      className="h-7 text-sm rounded-md border border-input bg-background px-2 py-0 text-foreground focus:outline-none focus:ring-1 focus:ring-ring w-full"
    >
      <option value="">{placeholder}</option>
      {entries.map(e => (
        <option key={e.id} value={e.nome}>{e.nome}</option>
      ))}
    </select>
  );
}

// ── Types ────────────────────────────────────────────────────────
interface Pessoa {
  id: number; codigo: string; ativo: boolean;
  arquivadoEm?: string | null;
  nome: string; sobrenome: string | null; cpf: string | null;
  dataNascimento: string | null; sexo: string | null;
  email: string | null; celular: string | null;
  instagram: string | null; site: string | null;
  profissao: string | null; profissaoCategoria: string | null;
  enderecoRua: string | null; cidade: string | null;
  estadoUf: string | null; cep: string | null;
  servicoInteresse: string | null;
  comoFicouSabendo: string | null; qualAmigoParceiro: string | null;
  preferenciaContato: string | null; contatoPara: string | null;
  adicionarContato: string | null;
  aguaPresencial: string | null; fogoPresencial: string | null;
  workshopAgua: string | null; cacau: string | null;
  ayahuasca: string | null; concerto: string | null;
  zapPierre: string | null; idAlunoCliente: string | null; turma: string | null;
  conectadoProposito: string | null; buscaEspiritual: string | null;
  lugarMusicaSom: string | null; participouTrabalhoSom: string | null;
  qualTrabalhoSom: string | null; midiaInput: string | null;
  midiaInputOutro: string | null; terapeuta: string | null;
  formacaoMusicaTerapia: string | null;
  objetivoCurso: string | null; cursoProposito: string | null;
  cursoExpectativas: string | null; outroCurso: string | null;
  sentidoParticipar: string | null;
  experienciaAyahuasca: string | null; psicodelicosDrogas: string | null;
  traumaVida: string | null; ansioliticoAntidepressivos: string | null;
  problemaSaude: string | null; psicoterapiaPsiquiatria: string | null;
  sensacao: string | null; sensacaoPerseguido: string | null;
  covid: string | null; comprovanteCovid: string | null;
  // Classificação / Segmentação
  perfilPrincipal: string | null;
  objetivosDeclarados: string[] | null;
  macrojornadaPrincipalId: string | null;
  intencaoPrincipal: string | null;
  temperatura: string | null;
  estiloCognitivo: string | null;
  velocidadeEvolucao: string | null;
  preferredLanguage: string | null;
  consentStatus: string | null;
  numeroRef: number | null; dataRegistro: string | null;
  createdAt: string; updatedAt: string;
  conversationCount?: number;
  mergedIntoPessoaId?: number | null;
}

type EditableKey = Exclude<keyof Pessoa,
  "id" | "codigo" | "ativo" | "createdAt" | "updatedAt" | "conversationCount" | "numeroRef" | "dataRegistro"
  | "objetivosDeclarados"
>;

interface PessoaConversation {
  id: number; title: string; model: string; createdAt: string;
}

interface PessoaCampoStatus {
  campo: string; confirmadoPor: string; confirmadoEm: string;
  valorAtual: string | null; valorSugeridoSofia: string | null;
}

interface PessoaServico {
  id: number; pessoaId: number; servicoNome: string;
  dataInteresse: string | null; obs: string | null; createdAt: string;
}
interface PessoaParticipacao {
  id: number; pessoaId: number; curso: string;
  data: string | null; local: string | null; valor: string | null;
  obs: string | null; createdAt: string;
}
interface PessoaInstrumento {
  id: number; pessoaId: number; item: string;
  dataCompra: string | null; valor: string | null;
  obs: string | null; createdAt: string;
}
interface DecisionRunEvidencia {
  campo: string; valor: string | null; tipoEvidencia: string;
  nivelConfianca: string; origem: string;
}
interface DecisionRun {
  id: number; pessoaId: number; conversationId: number | null; messageId: number | null;
  conduta: "triagem" | "comercial" | null; promptId: number | null; model: string | null;
  evidenciasConsideradas: DecisionRunEvidencia[];
  elegibilidadeStatus: "elegivel" | "bloqueado" | "nao_avaliada";
  elegibilidadeMotivo: string | null;
  ofertaPrincipal: string | null; ofertaAlternativa: string | null;
  nbaCategoria: string; nbaJustificativa: string;
  nivelConfianca: "baixa" | "media" | "alta"; createdAt: string;
}

// ── Field component (view + edit) ──────────────────────────────
function Field({
  label, field, value, editing, form, onChange, multiline = false, wide = false, options, status,
}: {
  label: string; field: EditableKey; value: string | null | undefined;
  editing: boolean; form: Partial<Record<EditableKey, string | null>>;
  onChange: (val: string | null) => void; multiline?: boolean; wide?: boolean;
  options?: Array<string | { value: string; label: string }>;
  status?: PessoaCampoStatus;
}) {
  const { t } = useLang();
  const confirmedBadge = status && (
    <span
      title={`Confirmado por ${status.confirmadoPor} em ${formatDateTimeBR(status.confirmadoEm)}. A Sofia não pode sobrescrever este campo automaticamente.`}
      className="inline-flex items-center gap-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 shrink-0"
    >
      <Check className="h-3 w-3" /> confirmado
    </span>
  );
  const diverging = status?.valorSugeridoSofia
    ? (
      <div
        title="A Sofia sugeriu um valor diferente para este campo, mas ele está protegido e não foi alterado."
        className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400 mt-0.5"
      >
        <AlertTriangle className="h-3 w-3 shrink-0" />
        <span className="break-words">Sofia sugere: <span className="italic">"{status.valorSugeridoSofia}"</span></span>
      </div>
    )
    : null;
  if (!editing) {
    const v = value?.trim();
    if (!v) return null;
    return (
      <div className={`flex flex-col gap-0.5 ${wide ? "col-span-2" : ""}`}>
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
          {label}
          {confirmedBadge}
        </span>
        <span className="text-sm text-foreground break-words">{v}</span>
        {diverging}
      </div>
    );
  }
  const formValue = form[field] ?? "";
  return (
    <div className={`space-y-1 ${wide ? "col-span-2" : ""}`}>
      <Label className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
        {label}
        {confirmedBadge}
      </Label>
      {diverging}
      {options ? (
        <select
          value={formValue}
          onChange={e => onChange(e.target.value || null)}
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">{t("pessoa.selecione")}</option>
          {options.map(o => {
            const v = typeof o === "string" ? o : o.value;
            const l = typeof o === "string" ? o : o.label;
            return <option key={v} value={v}>{l}</option>;
          })}
        </select>
      ) : multiline ? (
        <Textarea value={formValue} onChange={e => onChange(e.target.value || null)}
          className="text-sm min-h-[70px] resize-none" placeholder={label} />
      ) : (
        <Input value={formValue} onChange={e => onChange(e.target.value || null)}
          className="h-8 text-sm" placeholder={label} />
      )}
    </div>
  );
}

// ── Section wrapper ─────────────────────────────────────────────
function Section({ title, icon: Icon, children, action }: {
  title: string; icon: React.ElementType;
  children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <Card className="shadow-sm border-border/50">
      <CardHeader className="py-3 px-5 border-b border-border/40">
        <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground flex items-center gap-2">
          <Icon className="h-3.5 w-3.5" />
          {title}
          {action && <div className="ml-auto">{action}</div>}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 py-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">{children}</div>
      </CardContent>
    </Card>
  );
}

// ── Serviços de Interesse (1-para-muitos) ───────────────────────
function ServicosSection({ pessoaId }: { pessoaId: number }) {
  const qc = useQueryClient();
  const { t } = useLang();
  const { authHeader } = useUserSession();
  const [addingNew, setAddingNew] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [newForm, setNewForm] = useState({ servicoNome: "", dataInteresse: "", obs: "" });
  const [editForm, setEditForm] = useState<{ servicoNome: string; dataInteresse: string; obs: string }>({ servicoNome: "", dataInteresse: "", obs: "" });
  const { data: catalogServicos = [] } = useCatalog("/api/admin/catalogos/servicos", authHeader);

  const { data: servicos = [] } = useQuery<PessoaServico[]>({
    queryKey: ["/api/pessoas", pessoaId, "servicos"],
    queryFn: async () => {
      const r = await fetch(`/api/pessoas/${pessoaId}/servicos`, { headers: { ...authHeader } });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    },
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/pessoas/${pessoaId}/servicos`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ servicoNome: newForm.servicoNome, dataInteresse: newForm.dataInteresse || null, obs: newForm.obs || null }),
      });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pessoas", pessoaId, "servicos"] });
      setAddingNew(false);
      setNewForm({ servicoNome: "", dataInteresse: "", obs: "" });
      toast.success(t("pessoa.add_servico"));
    },
    onError: () => toast.error(t("pessoa.err_add_servico")),
  });

  const editMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/pessoas/${pessoaId}/servicos/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ servicoNome: editForm.servicoNome, dataInteresse: editForm.dataInteresse || null, obs: editForm.obs || null }),
      });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pessoas", pessoaId, "servicos"] });
      setEditingId(null);
      toast.success(t("pessoa.upd_servico"));
    },
    onError: () => toast.error(t("pessoa.erro_atualizar")),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/pessoas/${pessoaId}/servicos/${id}`, { method: "DELETE", headers: { ...authHeader } });
      if (!r.ok) throw new Error("Erro");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pessoas", pessoaId, "servicos"] });
      toast.success(t("pessoa.del_servico"));
    },
    onError: () => toast.error(t("pessoa.erro_remover")),
  });

  const startEdit = (s: PessoaServico) => {
    setEditingId(s.id);
    setEditForm({ servicoNome: s.servicoNome, dataInteresse: s.dataInteresse ?? "", obs: s.obs ?? "" });
  };

  return (
    <Card className="shadow-sm border-border/50">
      <CardHeader className="py-3 px-5 border-b border-border/40">
        <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground flex items-center gap-2">
          <Heart className="h-3.5 w-3.5" />
          {t("pessoa.servicos")}
          <Button size="sm" variant="ghost"
            className="ml-auto h-6 px-2 text-[11px] normal-case font-normal tracking-normal gap-1"
            onClick={() => { setAddingNew(true); setEditingId(null); }}>
            <Plus className="h-3 w-3" /> {t("pessoa.adicionar")}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {servicos.length === 0 && !addingNew && (
          <p className="text-xs text-muted-foreground/60 text-center py-5">{t("pessoa.servico_vazio")}</p>
        )}
        {servicos.length > 0 && (
          <div className="divide-y divide-border/40">
            <div className="grid grid-cols-[1fr_120px_1fr_64px] gap-3 px-5 py-2 bg-muted/30">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t("pessoa.servico")}</span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t("common.data")}</span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t("common.observacao")}</span>
              <span />
            </div>
            {servicos.map(s => (
              <div key={s.id} className="px-5 py-3">
                {editingId === s.id ? (
                  <div className="grid grid-cols-[1fr_120px_1fr_auto] gap-2 items-center">
                    <CatalogSelect value={editForm.servicoNome} onChange={v => setEditForm(f => ({ ...f, servicoNome: v }))} entries={catalogServicos} placeholder={t("pessoa.sel_servico")} autoFocus />
                    <Input type="date" value={editForm.dataInteresse} onChange={e => setEditForm(f => ({ ...f, dataInteresse: e.target.value }))} className="h-7 text-sm" />
                    <Input value={editForm.obs} onChange={e => setEditForm(f => ({ ...f, obs: e.target.value }))} className="h-7 text-sm" placeholder={t("common.observacao")} />
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-green-600 hover:text-green-700"
                        onClick={() => editMutation.mutate(s.id)} disabled={editMutation.isPending}>
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground"
                        onClick={() => setEditingId(null)}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-[1fr_120px_1fr_64px] gap-3 items-center">
                    <span className="text-sm font-medium text-foreground">{s.servicoNome}</span>
                    <span className="text-sm text-muted-foreground">{formatDateBR(s.dataInteresse)}</span>
                    <span className="text-sm text-muted-foreground truncate">{s.obs ?? "—"}</span>
                    <div className="flex gap-1 justify-end">
                      <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        onClick={() => startEdit(s)}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive/70 hover:text-destructive"
                        onClick={() => deleteMutation.mutate(s.id)} disabled={deleteMutation.isPending}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {addingNew && (
          <div className="px-5 py-3 border-t border-border/40 bg-muted/20">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">{t("pessoa.novo_servico")}</p>
            <div className="grid grid-cols-[1fr_120px_1fr_auto] gap-2 items-center">
              <CatalogSelect value={newForm.servicoNome} onChange={v => setNewForm(f => ({ ...f, servicoNome: v }))} entries={catalogServicos} placeholder={t("pessoa.sel_servico_req")} autoFocus />
              <Input type="date" value={newForm.dataInteresse} onChange={e => setNewForm(f => ({ ...f, dataInteresse: e.target.value }))} className="h-7 text-sm" />
              <Input value={newForm.obs} onChange={e => setNewForm(f => ({ ...f, obs: e.target.value }))} className="h-7 text-sm" placeholder={t("common.observacao")} />
              <div className="flex gap-1">
                <Button size="sm" className="h-7 px-3 text-xs" onClick={() => addMutation.mutate()} disabled={!newForm.servicoNome.trim() || addMutation.isPending}>
                  {t("pessoa.salvar")}
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setAddingNew(false); setNewForm({ servicoNome: "", dataInteresse: "", obs: "" }); }}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Participações (1-para-muitos) ───────────────────────────────
function ParticipacoesSection({ pessoaId }: { pessoaId: number }) {
  const qc = useQueryClient();
  const { t } = useLang();
  const { authHeader } = useUserSession();
  const [addingNew, setAddingNew] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const emptyNew = { curso: "", data: "", local: "", valor: "", obs: "" };
  const [newForm, setNewForm] = useState(emptyNew);
  const [editForm, setEditForm] = useState(emptyNew);

  const { data: participacoes = [] } = useQuery<PessoaParticipacao[]>({
    queryKey: ["/api/pessoas", pessoaId, "participacoes"],
    queryFn: async () => {
      const r = await fetch(`/api/pessoas/${pessoaId}/participacoes`, { headers: { ...authHeader } });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    },
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/pessoas/${pessoaId}/participacoes`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ curso: newForm.curso, data: newForm.data || null, local: newForm.local || null, valor: newForm.valor || null, obs: newForm.obs || null }),
      });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pessoas", pessoaId, "participacoes"] });
      setAddingNew(false); setNewForm(emptyNew);
      toast.success(t("pessoa.add_participacao"));
    },
    onError: () => toast.error(t("pessoa.err_add_participacao")),
  });

  const editMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/pessoas/${pessoaId}/participacoes/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ curso: editForm.curso, data: editForm.data || null, local: editForm.local || null, valor: editForm.valor || null, obs: editForm.obs || null }),
      });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pessoas", pessoaId, "participacoes"] });
      setEditingId(null);
      toast.success(t("pessoa.upd_participacao"));
    },
    onError: () => toast.error(t("pessoa.erro_atualizar")),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/pessoas/${pessoaId}/participacoes/${id}`, { method: "DELETE", headers: { ...authHeader } });
      if (!r.ok) throw new Error("Erro");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pessoas", pessoaId, "participacoes"] });
      toast.success(t("pessoa.del_participacao"));
    },
    onError: () => toast.error(t("pessoa.erro_remover")),
  });

  const startEdit = (p: PessoaParticipacao) => {
    setEditingId(p.id);
    setEditForm({ curso: p.curso, data: p.data ?? "", local: p.local ?? "", valor: p.valor ?? "", obs: p.obs ?? "" });
  };

  return (
    <Card className="shadow-sm border-border/50">
      <CardHeader className="py-3 px-5 border-b border-border/40">
        <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground flex items-center gap-2">
          <BookOpen className="h-3.5 w-3.5" />
          {t("pessoa.participacoes")}
          <Button size="sm" variant="ghost"
            className="ml-auto h-6 px-2 text-[11px] normal-case font-normal tracking-normal gap-1"
            onClick={() => { setAddingNew(true); setEditingId(null); }}>
            <Plus className="h-3 w-3" /> {t("pessoa.adicionar")}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {participacoes.length === 0 && !addingNew && (
          <p className="text-xs text-muted-foreground/60 text-center py-5">{t("pessoa.participacao_vazia")}</p>
        )}
        {participacoes.length > 0 && (
          <div className="divide-y divide-border/40">
            <div className="grid grid-cols-[1.5fr_110px_1fr_100px_1.5fr_60px] gap-3 px-5 py-2 bg-muted/30">
              {[t("edu.turmas.curso"), t("common.data"), t("edu.turmas.local"), t("common.valor"), t("common.observacao"), ""].map((h, i) => (
                <span key={i} className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{h}</span>
              ))}
            </div>
            {participacoes.map(p => (
              <div key={p.id} className="px-5 py-3">
                {editingId === p.id ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-[1.5fr_110px_1fr_100px] gap-2">
                      <Input value={editForm.curso} onChange={e => setEditForm(f => ({ ...f, curso: e.target.value }))} className="h-7 text-sm" placeholder={t("pessoa.p_curso_req")} />
                      <Input type="date" value={editForm.data} onChange={e => setEditForm(f => ({ ...f, data: e.target.value }))} className="h-7 text-sm" />
                      <Input value={editForm.local} onChange={e => setEditForm(f => ({ ...f, local: e.target.value }))} className="h-7 text-sm" placeholder={t("pessoa.p_local")} />
                      <Input value={editForm.valor} onChange={e => setEditForm(f => ({ ...f, valor: e.target.value }))} className="h-7 text-sm" placeholder={t("pessoa.p_valor")} />
                    </div>
                    <div className="flex gap-2 items-center">
                      <Input value={editForm.obs} onChange={e => setEditForm(f => ({ ...f, obs: e.target.value }))} className="h-7 text-sm flex-1" placeholder={t("pessoa.p_obs")} />
                      <Button size="sm" className="h-7 px-3 text-xs gap-1" onClick={() => editMutation.mutate(p.id)} disabled={!editForm.curso.trim() || editMutation.isPending}>
                        <Check className="h-3 w-3" /> {t("pessoa.salvar")}
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditingId(null)}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-[1.5fr_110px_1fr_100px_1.5fr_60px] gap-3 items-center">
                    <span className="text-sm font-medium text-foreground">{p.curso}</span>
                    <span className="text-sm text-muted-foreground">{formatDateBR(p.data)}</span>
                    <span className="text-sm text-muted-foreground">{p.local ?? "—"}</span>
                    <span className="text-sm text-muted-foreground">{p.valor ?? "—"}</span>
                    <span className="text-sm text-muted-foreground truncate">{p.obs ?? "—"}</span>
                    <div className="flex gap-1 justify-end">
                      <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground hover:text-foreground" onClick={() => startEdit(p)}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive/70 hover:text-destructive"
                        onClick={() => deleteMutation.mutate(p.id)} disabled={deleteMutation.isPending}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {addingNew && (
          <div className="px-5 py-3 border-t border-border/40 bg-muted/20">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">{t("pessoa.nova_participacao")}</p>
            <div className="space-y-2">
              <div className="grid grid-cols-[1.5fr_110px_1fr_100px] gap-2">
                <Input value={newForm.curso} onChange={e => setNewForm(f => ({ ...f, curso: e.target.value }))} className="h-7 text-sm" placeholder={t("pessoa.p_curso_req")} autoFocus />
                <Input type="date" value={newForm.data} onChange={e => setNewForm(f => ({ ...f, data: e.target.value }))} className="h-7 text-sm" />
                <Input value={newForm.local} onChange={e => setNewForm(f => ({ ...f, local: e.target.value }))} className="h-7 text-sm" placeholder={t("pessoa.p_local")} />
                <Input value={newForm.valor} onChange={e => setNewForm(f => ({ ...f, valor: e.target.value }))} className="h-7 text-sm" placeholder={t("pessoa.p_valor")} />
              </div>
              <div className="flex gap-2 items-center">
                <Input value={newForm.obs} onChange={e => setNewForm(f => ({ ...f, obs: e.target.value }))} className="h-7 text-sm flex-1" placeholder={t("pessoa.p_obs")} />
                <Button size="sm" className="h-7 px-3 text-xs" onClick={() => addMutation.mutate()} disabled={!newForm.curso.trim() || addMutation.isPending}>
                  {t("pessoa.salvar")}
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setAddingNew(false); setNewForm(emptyNew); }}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface FormularioEvento {
  /** Nulo no formulário de interesse genérico, que não pertence a um evento. */
  eventoId: number | null;
  eventoNome: string;
  formType: "INTERESSE" | "COMPLETO" | "INTERESSE_GERAL";
  /** Nulo no formulário genérico, que não tem versões. */
  version: number | null;
  answers: Record<string, unknown>;
  submittedAt: string;
  grupo?: string | null;
  grupoLabel?: string | null;
  paginaOrigem?: string | null;
}

function formularioTipoLabel(form: FormularioEvento): string {
  if (form.formType === "INTERESSE_GERAL") return "Interesse geral (site)";
  const tipo = form.formType === "INTERESSE" ? "Lista de Interesse" : "Inscrição Completa";
  return `${tipo} · versão ${form.version}`;
}

// ── Formulários de Eventos ───────────────────────────────────────
function FormulariosEventoSection({ pessoaId }: { pessoaId: number }) {
  const { authHeader } = useUserSession();

  const { data: formularios = [] } = useQuery<FormularioEvento[]>({
    queryKey: ["/api/pessoas", pessoaId, "formularios-evento"],
    queryFn: async () => {
      const r = await fetch(`/api/pessoas/${pessoaId}/formularios-evento`, { headers: authHeader });
      if (!r.ok) {
        throw new Error("Erro");
      }
      return r.json();
    },
  });

  if (formularios.length === 0) return null;

  return (
    <Card className="shadow-sm border-border/50">
      <CardHeader className="py-3 px-5 border-b border-border/40">
        <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground flex items-center gap-2">
          <FileText className="h-3.5 w-3.5" />
          Formulários de Eventos
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border/40">
          {formularios.map(form => (
            <div key={`${form.eventoId ?? "geral"}-${form.formType}-${form.version ?? 0}-${form.submittedAt}`} className="p-5 space-y-3" data-testid="formulario-evento-item">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h4 className="text-sm font-medium text-foreground">{form.eventoNome}</h4>
                  <p className="text-xs text-muted-foreground mt-0.5">{formularioTipoLabel(form)}</p>
                  {(form.grupo || form.paginaOrigem) && (
                    <p className="text-xs text-muted-foreground mt-0.5 break-all" data-testid="formulario-evento-origem">
                      {form.grupo ? `Grupo: ${form.grupoLabel ?? form.grupo}` : null}
                      {form.grupo && form.paginaOrigem ? " · " : null}
                      {form.paginaOrigem ? `Página: ${form.paginaOrigem}` : null}
                    </p>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatDateTimeBR(form.submittedAt)}
                </div>
              </div>
              {form.answers && Object.keys(form.answers).length > 0 && (
                <div className="bg-muted/30 rounded-md p-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-2">
                    {Object.entries(form.answers).map(([key, value]) => (
                      <div key={key} className="flex flex-col gap-0.5">
                        <span className="text-[10px] uppercase font-medium text-muted-foreground tracking-wide">{key}</span>
                        <span className="text-xs text-foreground break-words">{String(value)}</span>
                      </div>
                    ))}
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

// ── Decisões da Sofia (auditoria do motor de decisão — Documento 14A) ──
const NBA_LABELS: Record<string, string> = {
  aprender: "Aprender", consumir_conteudo: "Consumir conteúdo", explorar: "Explorar",
  participar: "Participar", aprofundar: "Aprofundar", experimentar: "Experimentar",
  conversar: "Conversar", comunidade: "Comunidade", comprar: "Comprar", pausar: "Pausar",
};

function DecisionRunsSection({ pessoaId }: { pessoaId: number }) {
  const { authHeader } = useUserSession();

  const { data: runs = [], isLoading } = useQuery<DecisionRun[]>({
    queryKey: ["/api/pessoas", pessoaId, "decision-runs"],
    queryFn: async () => {
      const r = await fetch(`/api/pessoas/${pessoaId}/decision-runs`, { headers: { ...authHeader } });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    },
  });

  return (
    <Card className="shadow-sm border-border/50">
      <CardHeader className="py-3 px-5 border-b border-border/40">
        <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground flex items-center gap-2">
          <ClipboardList className="h-3.5 w-3.5" />
          Decisões da Sofia
          {runs.length > 0 && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal ml-0.5">
              {runs.length}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading && <p className="text-xs text-muted-foreground/60 text-center py-5">Carregando…</p>}
        {!isLoading && runs.length === 0 && (
          <p className="text-xs text-muted-foreground/60 text-center py-5">Nenhuma decisão registrada ainda para esta pessoa.</p>
        )}
        {runs.length > 0 && (
          <div className="divide-y divide-border/40">
            {runs.map(run => {
              const Icon = run.elegibilidadeStatus === "bloqueado" ? ShieldAlert
                : run.elegibilidadeStatus === "elegivel" ? ShieldCheck : ShieldQuestion;
              const iconColor = run.elegibilidadeStatus === "bloqueado" ? "text-destructive"
                : run.elegibilidadeStatus === "elegivel" ? "text-emerald-600" : "text-muted-foreground";
              return (
                <div key={run.id} className="px-5 py-3 flex gap-3">
                  <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${iconColor}`} />
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
                        NBA: {NBA_LABELS[run.nbaCategoria] ?? run.nbaCategoria}
                      </Badge>
                      {run.conduta && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal capitalize">{run.conduta}</Badge>
                      )}
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
                        confiança {run.nivelConfianca}
                      </Badge>
                      {run.ofertaPrincipal && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">oferta: {run.ofertaPrincipal}</Badge>
                      )}
                      <span className="text-[10px] text-muted-foreground/60 ml-auto shrink-0">
                        {formatDateTimeBR(run.createdAt)}
                      </span>
                    </div>
                    <p className="text-sm text-foreground">{run.nbaJustificativa}</p>
                    {run.elegibilidadeMotivo && (
                      <p className="text-xs text-muted-foreground">Elegibilidade: {run.elegibilidadeMotivo}</p>
                    )}
                    {run.evidenciasConsideradas.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {run.evidenciasConsideradas.map((e, i) => (
                          <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground">
                            {e.campo}: {e.valor ?? "(vazio)"} [{e.nivelConfianca}]
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Instrumentos (1-para-muitos) ────────────────────────────────
function InstrumentosSection({ pessoaId }: { pessoaId: number }) {
  const qc = useQueryClient();
  const { t } = useLang();
  const { authHeader } = useUserSession();
  const [addingNew, setAddingNew] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const emptyNew = { item: "", dataCompra: "", valor: "", obs: "" };
  const [newForm, setNewForm] = useState(emptyNew);
  const [editForm, setEditForm] = useState(emptyNew);
  const { data: catalogInstrumentos = [] } = useCatalog("/api/admin/catalogos/instrumentos", authHeader);

  const { data: instrumentos = [] } = useQuery<PessoaInstrumento[]>({
    queryKey: ["/api/pessoas", pessoaId, "instrumentos"],
    queryFn: async () => {
      const r = await fetch(`/api/pessoas/${pessoaId}/instrumentos`, { headers: { ...authHeader } });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    },
  });

  // Compras da loja: calculadas pelo servidor, somente leitura, ao lado dos registros manuais.
  const loja = useLojaInstrumentos(pessoaId);
  const lojaItens = loja.data?.itens ?? [];
  const hasRows = instrumentos.length + lojaItens.length > 0;

  const addMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/pessoas/${pessoaId}/instrumentos`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ item: newForm.item, dataCompra: newForm.dataCompra || null, valor: newForm.valor || null, obs: newForm.obs || null }),
      });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pessoas", pessoaId, "instrumentos"] });
      setAddingNew(false); setNewForm(emptyNew);
      toast.success(t("pessoa.add_instrumento"));
    },
    onError: () => toast.error(t("pessoa.err_add_instrumento")),
  });

  const editMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/pessoas/${pessoaId}/instrumentos/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ item: editForm.item, dataCompra: editForm.dataCompra || null, valor: editForm.valor || null, obs: editForm.obs || null }),
      });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pessoas", pessoaId, "instrumentos"] });
      setEditingId(null);
      toast.success(t("pessoa.upd_instrumento"));
    },
    onError: () => toast.error(t("pessoa.erro_atualizar")),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/pessoas/${pessoaId}/instrumentos/${id}`, { method: "DELETE", headers: { ...authHeader } });
      if (!r.ok) throw new Error("Erro");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pessoas", pessoaId, "instrumentos"] });
      toast.success(t("pessoa.del_instrumento"));
    },
    onError: () => toast.error(t("pessoa.erro_remover")),
  });

  const startEdit = (i: PessoaInstrumento) => {
    setEditingId(i.id);
    setEditForm({ item: i.item, dataCompra: i.dataCompra ?? "", valor: i.valor ?? "", obs: i.obs ?? "" });
  };

  return (
    <Card className="shadow-sm border-border/50">
      <CardHeader className="py-3 px-5 border-b border-border/40">
        <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground flex items-center gap-2">
          <Music className="h-3.5 w-3.5" />
          {t("pessoa.instrumentos")}
          <Button size="sm" variant="ghost"
            className="ml-auto h-6 px-2 text-[11px] normal-case font-normal tracking-normal gap-1"
            onClick={() => { setAddingNew(true); setEditingId(null); }}>
            <Plus className="h-3 w-3" /> {t("pessoa.adicionar")}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {!hasRows && !addingNew && !loja.isLoading && (
          <p className="text-xs text-muted-foreground/60 text-center py-5">{t("pessoa.instrumento_vazio")}</p>
        )}
        {hasRows && (
          <div className="divide-y divide-border/40">
            <div className="grid grid-cols-[1.5fr_120px_100px_1fr_60px] gap-3 px-5 py-2 bg-muted/30">
              {[t("pessoa.item"), t("pessoa.data_compra"), t("common.valor"), t("common.observacao"), ""].map((h, i) => (
                <span key={i} className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{h}</span>
              ))}
            </div>
            {instrumentos.map(i => (
              <div key={i.id} className="px-5 py-3">
                {editingId === i.id ? (
                  <div className="grid grid-cols-[1.5fr_120px_100px_1fr_auto] gap-2 items-center">
                    <CatalogSelect value={editForm.item} onChange={v => setEditForm(f => ({ ...f, item: v }))} entries={catalogInstrumentos} placeholder={t("pessoa.sel_instrumento")} autoFocus />
                    <Input type="date" value={editForm.dataCompra} onChange={e => setEditForm(f => ({ ...f, dataCompra: e.target.value }))} className="h-7 text-sm" />
                    <Input value={editForm.valor} onChange={e => setEditForm(f => ({ ...f, valor: e.target.value }))} className="h-7 text-sm" placeholder={t("pessoa.p_valor")} />
                    <Input value={editForm.obs} onChange={e => setEditForm(f => ({ ...f, obs: e.target.value }))} className="h-7 text-sm" placeholder={t("pessoa.p_obs")} />
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-green-600 hover:text-green-700"
                        onClick={() => editMutation.mutate(i.id)} disabled={editMutation.isPending}>
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground"
                        onClick={() => setEditingId(null)}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-[1.5fr_120px_100px_1fr_60px] gap-3 items-center">
                    <span className="text-sm font-medium text-foreground">{i.item}</span>
                    <span className="text-sm text-muted-foreground">{formatDateBR(i.dataCompra)}</span>
                    <span className="text-sm text-muted-foreground">{i.valor ?? "—"}</span>
                    <span className="text-sm text-muted-foreground truncate">{i.obs ?? "—"}</span>
                    <div className="flex gap-1 justify-end">
                      <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground hover:text-foreground" onClick={() => startEdit(i)}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive/70 hover:text-destructive"
                        onClick={() => deleteMutation.mutate(i.id)} disabled={deleteMutation.isPending}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {lojaItens.map(row => <LojaInstrumentoRow key={row.id} row={row} />)}
          </div>
        )}
        <LojaInstrumentosStatus query={loja} />
        {addingNew && (
          <div className="px-5 py-3 border-t border-border/40 bg-muted/20">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-2">{t("pessoa.novo_instrumento")}</p>
            <div className="grid grid-cols-[1.5fr_120px_100px_1fr_auto] gap-2 items-center">
              <CatalogSelect value={newForm.item} onChange={v => setNewForm(f => ({ ...f, item: v }))} entries={catalogInstrumentos} placeholder={t("pessoa.sel_instrumento_req")} autoFocus />
              <Input type="date" value={newForm.dataCompra} onChange={e => setNewForm(f => ({ ...f, dataCompra: e.target.value }))} className="h-7 text-sm" />
              <Input value={newForm.valor} onChange={e => setNewForm(f => ({ ...f, valor: e.target.value }))} className="h-7 text-sm" placeholder={t("pessoa.p_valor")} />
              <Input value={newForm.obs} onChange={e => setNewForm(f => ({ ...f, obs: e.target.value }))} className="h-7 text-sm" placeholder={t("pessoa.p_obs")} />
              <div className="flex gap-1">
                <Button size="sm" className="h-7 px-3 text-xs" onClick={() => addMutation.mutate()} disabled={!newForm.item.trim() || addMutation.isPending}>
                  {t("pessoa.salvar")}
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setAddingNew(false); setNewForm(emptyNew); }}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main component ──────────────────────────────────────────────
interface PessoaNote {
  id: number;
  noteType?: string;
  type?: string;
  body?: string;
  content?: string;
  text?: string;
  createdAt: string;
}

function NotesSection({ pessoaId }: { pessoaId: number }) {
  const { t } = useLang();
  const { authHeader } = useUserSession();

  const { data: notes = [], isLoading } = useQuery<PessoaNote[]>({
    queryKey: ["/api/pessoas", pessoaId, "notes"],
    queryFn: async () => {
      const r = await fetch(`/api/pessoas/${pessoaId}/notes`, { headers: { ...authHeader } });
      if (!r.ok) return [];
      return r.json();
    },
  });

  return (
    <Card className="shadow-sm border-border/50 h-full">
      <CardHeader className="py-3 px-5 border-b border-border/40">
        <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground flex items-center gap-2">
          <FileText className="h-3.5 w-3.5" />
          {t("pessoas.notes_title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <p className="text-xs text-muted-foreground/60 text-center py-5">Carregando...</p>
        ) : notes.length === 0 ? (
          <p className="text-xs text-muted-foreground/60 text-center py-5">{t("pessoas.notes_empty")}</p>
        ) : (
          <div className="divide-y divide-border/40 max-h-[400px] overflow-y-auto">
            {notes.map(note => {
              const body = note.body || note.content || note.text;
              return (
                <div key={note.id} className="px-5 py-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                      {note.noteType ?? note.type ?? "Nota"}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatDateTimeBR(note.createdAt)}
                    </span>
                  </div>
                  <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                    {body}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Merge Component ────────────────────────────────────────────────
function MergeDialog({ targetPessoa, open, setOpen, initialSourceId = null }: {
  targetPessoa: Pessoa; open: boolean; setOpen: (v: boolean) => void; initialSourceId?: number | null;
}) {
  const { t } = useLang();
  const { authHeader } = useUserSession();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sourceId, setSourceId] = useState<number | null>(initialSourceId);
  
  const [nameFrom, setNameFrom] = useState<"target" | "source">("target");
  const [emailFrom, setEmailFrom] = useState<"target" | "source">("target");
  const [phoneFrom, setPhoneFrom] = useState<"target" | "source">("target");
  const [fieldChoices, setFieldChoices] = useState<Record<string, "target" | "source">>({});
  const [reason, setReason] = useState("");

  useEffect(() => {
    const tId = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(tId);
  }, [search]);

  // Search existing people
  const { data: searchResults = [] } = useQuery<Pessoa[]>({
    queryKey: ["/api/pessoas/search-merge", debouncedSearch],
    queryFn: async () => {
      if (!debouncedSearch) return [];
      const params = new URLSearchParams({ search: debouncedSearch, excludeId: String(targetPessoa.id) });
      const r = await fetch(`/api/pessoas/merge-candidates?${params}`, { headers: { ...authHeader } });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: open && debouncedSearch.length >= 2,
  });

  // Get preview when source is selected
  const { data: preview, isLoading: isPreviewLoading } = useQuery<{
    target: any; source: any;
    defaults: { nameFrom: "target"|"source"; emailFrom: "target"|"source"; phoneFrom: "target"|"source" };
    relationshipCounts: { target: Record<string, number>; source: Record<string, number> };
    collisionCounts: Record<string, number>;
    fieldConflicts: Array<{ field: string; targetValue: unknown; sourceValue: unknown; defaultFrom: "target" | "source" }>;
    secondaryContacts: Array<{ type: "email" | "phone"; value: string; sourcePersonId: number }>;
  }>({
    queryKey: ["/api/pessoas", targetPessoa.id, "merge-preview", sourceId],
    queryFn: async () => {
      const r = await fetch(`/api/pessoas/${targetPessoa.id}/merge-preview?sourceId=${sourceId}`, { headers: { ...authHeader } });
      if (!r.ok) throw new Error("Erro preview");
      return r.json();
    },
    enabled: open && sourceId !== null,
  });

  useEffect(() => {
    if (preview) {
      setNameFrom(preview.defaults.nameFrom);
      setEmailFrom(preview.defaults.emailFrom);
      setPhoneFrom(preview.defaults.phoneFrom);
      setFieldChoices(Object.fromEntries(preview.fieldConflicts.map(conflict => [conflict.field, conflict.defaultFrom])));
    }
  }, [preview]);

  const mergeMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/pessoas/${targetPessoa.id}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ sourceId, nameFrom, emailFrom, phoneFrom, fieldChoices, reason }),
      });
      if (!r.ok) throw new Error("Erro");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pessoas"] });
      toast.success(t("pessoas.fundir_success"));
      setOpen(false);
    },
    onError: () => toast.error(t("pessoas.fundir_error")),
  });

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm ${open ? "" : "hidden"}`}>
      <div className="bg-background border border-border rounded-lg shadow-xl w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t("pessoas.fundir_title")}</h2>
            <p className="text-sm text-muted-foreground">{t("pessoas.fundir_desc")}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={() => setOpen(false)}><X className="h-5 w-5" /></Button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Source Selection */}
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">{t("pessoas.fundir_source")}</Label>
            {!sourceId ? (
              <div className="relative">
                <Input placeholder={t("pessoas.fundir_source_placeholder")} value={search} onChange={e => setSearch(e.target.value)} />
                {searchResults.length > 0 && (
                  <div className="absolute top-full mt-1 w-full bg-background border border-border rounded-md shadow-lg z-10 max-h-48 overflow-y-auto">
                    {searchResults.map(p => (
                      <div key={p.id} className="p-2 hover:bg-muted cursor-pointer text-sm flex flex-col" onClick={() => setSourceId(p.id)}>
                        <span className="font-medium">{p.nome} {p.sobrenome}</span>
                        <span className="text-xs text-muted-foreground">
                          {p.email || p.celular || "Sem contato"} - {p.codigo}
                          {p.arquivadoEm ? " · Arquivada" : !p.ativo ? " · Inativa" : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

            ) : (
              <div className="flex items-center justify-between p-3 border border-border rounded-md bg-muted/20">
                <span className="text-sm font-medium">Id: {sourceId} Selecionado</span>
                <Button variant="ghost" size="sm" onClick={() => setSourceId(null)}>{t("common.cancelar")}</Button>
              </div>
            )}
          </div>

          {isPreviewLoading && <p className="text-sm text-muted-foreground">Carregando preview...</p>}

          {preview && (
            <div className="space-y-6 animate-in fade-in">
              <h3 className="font-semibold text-foreground border-b border-border pb-2">{t("pessoas.fundir_preview")}</h3>
              
              <div className="grid grid-cols-3 gap-4 bg-muted/10 p-4 rounded-md border border-border">
                <div className="font-medium text-sm text-muted-foreground">Campo</div>
                <div className="font-medium text-sm text-foreground">{t("pessoas.fundir_target")} ({preview.target.id})</div>
                <div className="font-medium text-sm text-foreground">{t("pessoas.fundir_source")} ({preview.source.id})</div>

                {/* Name */}
                <div className="text-sm font-medium pt-2">Nome</div>
                <label className="flex items-start gap-2 pt-2 cursor-pointer">
                  <input type="radio" name="name" checked={nameFrom === "target"} onChange={() => setNameFrom("target")} className="mt-1" />
                  <span className="text-sm">{preview.target.nome} {preview.target.sobrenome}</span>
                </label>
                <label className="flex items-start gap-2 pt-2 cursor-pointer">
                  <input type="radio" name="name" checked={nameFrom === "source"} onChange={() => setNameFrom("source")} className="mt-1" />
                  <span className="text-sm">{preview.source.nome} {preview.source.sobrenome}</span>
                </label>

                {/* Email */}
                <div className="text-sm font-medium pt-2">Email</div>
                <label className="flex items-start gap-2 pt-2 cursor-pointer">
                  <input type="radio" name="email" checked={emailFrom === "target"} onChange={() => setEmailFrom("target")} className="mt-1" />
                  <span className="text-sm">{preview.target.email || t("pessoas.merge_na")}</span>
                </label>
                <label className="flex items-start gap-2 pt-2 cursor-pointer">
                  <input type="radio" name="email" checked={emailFrom === "source"} onChange={() => setEmailFrom("source")} className="mt-1" />
                  <span className="text-sm">{preview.source.email || t("pessoas.merge_na")}</span>
                </label>

                {/* Phone */}
                <div className="text-sm font-medium pt-2">Telefone</div>
                <label className="flex items-start gap-2 pt-2 cursor-pointer">
                  <input type="radio" name="phone" checked={phoneFrom === "target"} onChange={() => setPhoneFrom("target")} className="mt-1" />
                  <span className="text-sm">{preview.target.celular || t("pessoas.merge_na")}</span>
                </label>
                <label className="flex items-start gap-2 pt-2 cursor-pointer">
                  <input type="radio" name="phone" checked={phoneFrom === "source"} onChange={() => setPhoneFrom("source")} className="mt-1" />
                  <span className="text-sm">{preview.source.celular || t("pessoas.merge_na")}</span>
                </label>
              </div>

              {preview.fieldConflicts.length > 0 && (
                <div className="space-y-3">
                  <h4 className="text-xs uppercase font-semibold text-amber-700 dark:text-amber-400">
                    {t("pessoas.merge_field_conflicts")}
                  </h4>
                  {preview.fieldConflicts.map(conflict => (
                    <div key={conflict.field} className="grid grid-cols-3 gap-3 rounded-md border border-border p-3">
                      <span className="text-sm font-medium">{conflict.field}</span>
                      {(["target", "source"] as const).map(side => (
                        <label key={side} className="flex items-start gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name={`field-${conflict.field}`}
                            checked={fieldChoices[conflict.field] === side}
                            onChange={() => setFieldChoices(current => ({ ...current, [conflict.field]: side }))}
                            className="mt-1"
                          />
                          <span className="text-sm break-words">
                            {String(side === "target" ? conflict.targetValue : conflict.sourceValue)}
                          </span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {preview.secondaryContacts?.length > 0 && (
                <div className="bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 p-3 rounded-md text-sm flex gap-2 items-start">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <p>{t("pessoas.merge_warn_secondary")}</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <h4 className="text-xs uppercase font-semibold text-muted-foreground">{t("pessoas.merge_rels_target")}</h4>
                  <ul className="text-sm text-foreground space-y-1">
                    {Object.entries(preview.relationshipCounts.target).map(([k,v]) => (
                      <li key={k}>{k}: {v as number}</li>
                    ))}
                  </ul>
                </div>
                <div className="space-y-2">
                  <h4 className="text-xs uppercase font-semibold text-muted-foreground">{t("pessoas.merge_rels_source")}</h4>
                  <ul className="text-sm text-foreground space-y-1">
                    {Object.entries(preview.relationshipCounts.source).map(([k,v]) => (
                      <li key={k}>{k}: {v as number}</li>
                    ))}
                  </ul>
                </div>
              </div>
              
              {Object.values(preview.collisionCounts).some(count => count > 0) && (
                <div className="space-y-2 pt-2">
                  <h4 className="text-xs uppercase font-semibold text-destructive">{t("pessoas.merge_collisions")}</h4>
                  <ul className="text-sm text-foreground space-y-1">
                    {Object.entries(preview.collisionCounts).filter(([, value]) => value > 0).map(([k,v]) => (
                      <li key={k}>{k}: {v as number}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="space-y-2 pt-4">
                <Label>{t("pessoas.fundir_reason")}</Label>
                <Textarea aria-label={t("pessoas.fundir_reason")} value={reason} onChange={e => setReason(e.target.value)} required />
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border flex justify-end gap-2 bg-muted/20">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={mergeMutation.isPending}>{t("common.cancelar")}</Button>
          <Button variant="destructive" onClick={() => mergeMutation.mutate()} disabled={!preview || !reason.trim() || mergeMutation.isPending}>
            {mergeMutation.isPending ? t("common.salvando") : t("pessoas.fundir_confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Detail Component ─────────────────────────────────────────────
export default function PessoaDetail() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { t, lang } = useLang();

  const pessoaId = parseInt(params.id, 10);
  const { authHeader } = useUserSession();

  const { data: pessoa, isLoading, error } = useQuery<Pessoa>({
    queryKey: ["/api/pessoas", pessoaId],
    queryFn: async () => {
      const res = await fetch(`/api/pessoas/${pessoaId}`, { headers: { ...authHeader } });
      if (!res.ok) throw new Error("Pessoa não encontrada");
      return res.json();
    },
    enabled: !isNaN(pessoaId),
  });

  const { data: conversas = [] } = useQuery<PessoaConversation[]>({
    queryKey: ["/api/pessoas", pessoaId, "conversations"],
    queryFn: async () => {
      const res = await fetch(`/api/pessoas/${pessoaId}/conversations`, { headers: { ...authHeader } });
      if (!res.ok) throw new Error("Erro ao carregar conversas");
      return res.json();
    },
    enabled: !isNaN(pessoaId),
  });

  const editRequestedRef = useRef(
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("edit") === "1",
  );
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Record<EditableKey, string | null>>>({});
  const [objetivos, setObjetivos] = useState<[string, string, string]>(["", "", ""]);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  // Link vindo do cartão do CRM (?fundir=ID): abre a fusão já com a ficha duplicada escolhida, só na primeira vez.
  const [mergeSourceFromLink, setMergeSourceFromLink] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const requested = Number(new URLSearchParams(window.location.search).get("fundir"));
    return Number.isSafeInteger(requested) && requested > 0 ? requested : null;
  });
  const [mergeDialogOpen, setMergeDialogOpen] = useState(mergeSourceFromLink !== null);

  const { isAdmin } = useAccess();

  const isMergedTombstone = pessoa?.ativo === false && !!pessoa?.mergedIntoPessoaId;

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/pessoas/${pessoaId}`, {
        method: "DELETE",
        headers: { ...authHeader },
      });
      if (!res.ok) throw new Error("Erro ao apagar");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pessoas"] });
      toast.success(`${pessoa?.nome ?? "Pessoa"} apagada com sucesso.`);
      navigate("/pessoas");
    },
    onError: () => toast.error("Erro ao apagar. Permissão negada."),
  });

  const startEdit = () => {
    if (!pessoa) return;
    setForm({
      nome: pessoa.nome,
      sobrenome: pessoa.sobrenome ?? "",
      cpf: pessoa.cpf ?? "",
      dataNascimento: pessoa.dataNascimento ?? "",
      sexo: pessoa.sexo ?? "",
      email: pessoa.email ?? "",
      celular: pessoa.celular ?? "",
      instagram: pessoa.instagram ?? "",
      site: pessoa.site ?? "",
      profissao: pessoa.profissao ?? "",
      profissaoCategoria: pessoa.profissaoCategoria ?? "",
      enderecoRua: pessoa.enderecoRua ?? "",
      cidade: pessoa.cidade ?? "",
      estadoUf: pessoa.estadoUf ?? "",
      cep: pessoa.cep ?? "",
      comoFicouSabendo: pessoa.comoFicouSabendo ?? "",
      qualAmigoParceiro: pessoa.qualAmigoParceiro ?? "",
      preferenciaContato: pessoa.preferenciaContato ?? "",
      contatoPara: pessoa.contatoPara ?? "",
      adicionarContato: pessoa.adicionarContato ?? "",
      idAlunoCliente: pessoa.idAlunoCliente ?? "",
      turma: pessoa.turma ?? "",
      // Classificação
      perfilPrincipal: pessoa.perfilPrincipal ?? "",
      macrojornadaPrincipalId: pessoa.macrojornadaPrincipalId ?? "",
      intencaoPrincipal: pessoa.intencaoPrincipal ?? "",
      temperatura: pessoa.temperatura ?? "",
      estiloCognitivo: pessoa.estiloCognitivo ?? "",
      velocidadeEvolucao: pessoa.velocidadeEvolucao ?? "",
      preferredLanguage: pessoa.preferredLanguage ?? "",
      consentStatus: pessoa.consentStatus ?? "",
      // Espiritual
      conectadoProposito: pessoa.conectadoProposito ?? "",
      buscaEspiritual: pessoa.buscaEspiritual ?? "",
      lugarMusicaSom: pessoa.lugarMusicaSom ?? "",
      participouTrabalhoSom: pessoa.participouTrabalhoSom ?? "",
      qualTrabalhoSom: pessoa.qualTrabalhoSom ?? "",
      midiaInput: pessoa.midiaInput ?? "",
      midiaInputOutro: pessoa.midiaInputOutro ?? "",
      terapeuta: pessoa.terapeuta ?? "",
      formacaoMusicaTerapia: pessoa.formacaoMusicaTerapia ?? "",
      // Curso
      objetivoCurso: pessoa.objetivoCurso ?? "",
      cursoProposito: pessoa.cursoProposito ?? "",
      cursoExpectativas: pessoa.cursoExpectativas ?? "",
      outroCurso: pessoa.outroCurso ?? "",
      sentidoParticipar: pessoa.sentidoParticipar ?? "",
      // Saúde
      experienciaAyahuasca: pessoa.experienciaAyahuasca ?? "",
      psicodelicosDrogas: pessoa.psicodelicosDrogas ?? "",
      traumaVida: pessoa.traumaVida ?? "",
      ansioliticoAntidepressivos: pessoa.ansioliticoAntidepressivos ?? "",
      problemaSaude: pessoa.problemaSaude ?? "",
      psicoterapiaPsiquiatria: pessoa.psicoterapiaPsiquiatria ?? "",
      sensacao: pessoa.sensacao ?? "",
      sensacaoPerseguido: pessoa.sensacaoPerseguido ?? "",
    });
    const arr = Array.isArray(pessoa.objetivosDeclarados) ? pessoa.objetivosDeclarados : [];
    setObjetivos([arr[0] ?? "", arr[1] ?? "", arr[2] ?? ""]);
    setEditing(true);
  };

  useEffect(() => {
    if (pessoa && editRequestedRef.current) {
      editRequestedRef.current = false;
      startEdit();
    }
  }, [pessoa]);

  const cancelEdit = () => { setEditing(false); setForm({}); setObjetivos(["", "", ""]); };

  const set = (field: EditableKey) => (val: string | null) =>
    setForm(f => ({ ...f, [field]: val }));

  const patchMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, v === "" ? null : v])
      );
      const objetivosArr = objetivos.map(s => s.trim()).filter(Boolean);
      body.objetivosDeclarados = objetivosArr;
      const res = await fetch(`/api/pessoas/${pessoaId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Erro ao salvar");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/pessoas"] });
      queryClient.invalidateQueries({ queryKey: ["/api/pessoas", pessoaId, "campos-status"] });
      setEditing(false);
      setForm({});
      toast.success(t("pessoa.ficha_atualizada"));
    },
    onError: () => toast.error(t("pessoa.erro_salvar")),
  });

  const { data: camposStatus = [] } = useQuery<PessoaCampoStatus[]>({
    queryKey: ["/api/pessoas", pessoaId, "campos-status"],
    queryFn: async () => {
      const r = await fetch(`/api/pessoas/${pessoaId}/campos-status`, {
        headers: { ...authHeader },
      });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !isNaN(pessoaId),
  });
  const camposStatusMap = useMemo(
    () => new Map(camposStatus.map(c => [c.campo, c])),
    [camposStatus],
  );

  const F = (label: string, field: EditableKey, multi = false, wide = false, options?: Array<string | {value: string; label: string}>) => (
    <Field key={field} label={label} field={field}
      value={pessoa ? (pessoa[field] as string | null | undefined) : null}
      editing={editing} form={form} onChange={set(field)} multiline={multi} wide={wide} options={options}
      status={camposStatusMap.get(field)} />
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-primary rounded-full animate-bounce" />
          <span className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:0.2s]" />
          <span className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:0.4s]" />
        </div>
      </div>
    );
  }

  if (error || !pessoa) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-muted-foreground">{t("pessoa.nao_encontrada")}</p>
        <Button variant="outline" onClick={() => navigate("/pessoas")}>
          <ArrowLeft className="h-4 w-4 mr-2" /> {t("pessoa.voltar")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-10">

      {/* Delete confirmation overlay */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-background border border-border rounded-lg shadow-xl w-full max-w-md mx-4 p-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
                <AlertTriangle className="h-5 w-5 text-destructive" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">Apagar pessoa?</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Esta ação é <strong>permanente</strong> e não pode ser desfeita.
                </p>
              </div>
            </div>
            <div className="rounded-md bg-destructive/5 border border-destructive/20 px-4 py-3 mb-5 text-sm text-foreground">
              <p className="font-medium mb-1">
                {pessoa?.nome}{pessoa?.sobrenome ? ` ${pessoa.sobrenome}` : ""}{" "}
                <span className="font-mono text-xs text-muted-foreground">({pessoa?.codigo})</span>
              </p>
              <p className="text-muted-foreground text-xs">
                Todos os dados vinculados serão apagados: conversas com a Sofia, serviços de interesse, participações e instrumentos.
              </p>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(false)} disabled={deleteMutation.isPending}>
                Cancelar
              </Button>
              <Button variant="destructive" size="sm" onClick={() => deleteMutation.mutate()} disabled={deleteMutation.isPending}>
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                {deleteMutation.isPending ? "Apagando…" : "Confirmar apagar"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Header bar */}
      {isMergedTombstone && (
        <div className="bg-destructive/10 border border-destructive/20 text-destructive p-4 rounded-md flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-sm">{t("pessoas.merged_tombstone")}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => navigate(`/pessoas/${pessoa.mergedIntoPessoaId}`)}>
            {t("pessoas.view_canonical")}
          </Button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => navigate("/pessoas")} className="-ml-2">
          <ArrowLeft className="h-4 w-4 mr-1" /> {t("pessoas.title")}
        </Button>
        <div className="flex gap-2">
          {isMergedTombstone ? null : editing ? (
            <>
              <Button size="sm" variant="outline" onClick={cancelEdit} disabled={patchMutation.isPending}>
                <X className="h-3.5 w-3.5 mr-1" /> {t("pessoa.cancelar")}
              </Button>
              <Button size="sm" onClick={() => patchMutation.mutate()} disabled={patchMutation.isPending}>
                <Check className="h-3.5 w-3.5 mr-1" />
                {patchMutation.isPending ? t("pessoa.salvando") : t("pessoa.salvar_alt")}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm" variant="outline"
                onClick={() => setMergeDialogOpen(true)}
              >
                {t("pessoas.fundir")}
              </Button>
              <Button
                size="sm" variant="outline"
                onClick={() => setDeleteConfirm(true)}
                className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/50"
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Apagar
              </Button>
              <Button size="sm" variant="outline" onClick={startEdit}>
                <Pencil className="h-3.5 w-3.5 mr-1" /> {t("pessoa.editar")}
              </Button>
            </>
          )}
        </div>
      </div>

      {mergeDialogOpen && pessoa && !isMergedTombstone && (
        <MergeDialog
          targetPessoa={pessoa}
          open={mergeDialogOpen}
          setOpen={open => {
            setMergeDialogOpen(open);
            if (!open) setMergeSourceFromLink(null);
          }}
          initialSourceId={mergeSourceFromLink}
        />
      )}

      {/* Identity card */}
      <Card className="shadow-sm border-border/50">
        <CardContent className="pt-5 pb-4 px-5">
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <span className="text-primary font-bold text-xl">{(pessoa.nome[0] ?? "?").toUpperCase()}</span>
            </div>
            <div className="flex-1 min-w-0">
              {editing ? (
                <div className="flex flex-wrap gap-2 mb-2">
                  <Input value={form.nome ?? ""} onChange={e => set("nome")(e.target.value || null)}
                    className="h-9 font-semibold text-base w-36" placeholder={t("pessoa.f.nome")} />
                  <Input value={form.sobrenome ?? ""} onChange={e => set("sobrenome")(e.target.value || null)}
                    className="h-9 w-48" placeholder={t("pessoa.f.sobrenome")} />
                </div>
              ) : (
                <h1 className="text-xl font-bold text-foreground">
                  {pessoa.nome}{pessoa.sobrenome ? ` ${pessoa.sobrenome}` : ""}
                </h1>
              )}
              <div className="flex flex-wrap items-center gap-2 mt-1">
                <Badge variant="outline" className="text-[10px] font-mono">{pessoa.codigo}</Badge>
                {pessoa.idAlunoCliente && (
                  <Badge variant="outline" className="text-[10px] font-mono">ID: {pessoa.idAlunoCliente}</Badge>
                )}
                {pessoa.perfilPrincipal && (
                  <Badge variant="secondary" className="text-[10px]">{pessoa.perfilPrincipal}</Badge>
                )}
                {pessoa.temperatura && (
                  <Badge variant="outline" className="text-[10px] capitalize">{pessoa.temperatura.replace("_", " ")}</Badge>
                )}
                {!pessoa.ativo && <Badge variant="secondary">{t("pessoa.inativo")}</Badge>}
              </div>
              {!editing && (
                <div className="flex flex-wrap items-center gap-4 mt-3 text-sm text-muted-foreground">
                  {pessoa.celular && (
                    <span className="flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" /> {pessoa.celular}</span>
                  )}
                  {pessoa.email && (
                    <span className="flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" /> {pessoa.email}</span>
                  )}
                  {pessoa.cidade && (
                    <span className="flex items-center gap-1.5">
                      <MapPin className="h-3.5 w-3.5" />
                      {pessoa.cidade}{pessoa.estadoUf ? `, ${pessoa.estadoUf}` : ""}
                    </span>
                  )}
                  {pessoa.instagram && (
                    <span className="flex items-center gap-1.5">
                      <Globe className="h-3.5 w-3.5" /> @{pessoa.instagram.replace(/^@/, "")}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {editing && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
          <Pencil className="h-3.5 w-3.5 shrink-0" />
          {t("pessoa.modo_edicao")} — {t("pessoa.salvar_alt")}
        </div>
      )}

      {/* Tabbed content */}
      <Tabs defaultValue="perfil" className="space-y-4">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="perfil" className="gap-1.5">
            <User className="h-3.5 w-3.5" /> Perfil
          </TabsTrigger>
          <TabsTrigger value="classificacao" className="gap-1.5">
            <Brain className="h-3.5 w-3.5" /> Classificação
          </TabsTrigger>
          <TabsTrigger value="historico" className="gap-1.5">
            <BookOpen className="h-3.5 w-3.5" /> Histórico
          </TabsTrigger>
          <TabsTrigger value="sofia" className="gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" /> Sofia
            {conversas.length > 0 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal ml-0.5">
                {conversas.length}
              </Badge>
            )}
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="decisoes" className="gap-1.5">
              <ClipboardList className="h-3.5 w-3.5" /> Decisões
            </TabsTrigger>
          )}
        </TabsList>

        {/* ── Tab: Perfil ───────────────────────────────────────── */}
        <TabsContent value="perfil" className="space-y-4 mt-0">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section title={t("pessoa.dados_pessoais")} icon={User}>
              {F(t("pessoa.f.cpf"), "cpf")}
              {F(t("pessoa.f.data_nasc"), "dataNascimento")}
              {F(t("pessoa.f.sexo"), "sexo", false, false, ["Masculino", "Feminino"])}
              {F(t("pessoa.f.email"), "email")}
              {F(t("pessoa.f.celular"), "celular")}
              {F(t("pessoa.f.instagram"), "instagram")}
              {F(t("pessoa.f.site"), "site")}
              {F(t("pessoa.f.profissao"), "profissao")}
              {F(t("pessoa.f.profissao_cat"), "profissaoCategoria")}
              {!editing && pessoa.numeroRef != null && (
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{t("pessoa.ref_original")}</span>
                  <span className="text-sm text-foreground">{pessoa.numeroRef}</span>
                </div>
              )}
              {!editing && pessoa.dataRegistro && (
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{t("pessoa.data_registro")}</span>
                  <span className="text-sm text-foreground">{formatDateBR(pessoa.dataRegistro)}</span>
                </div>
              )}
            </Section>

            <Section title={t("pessoa.endereco")} icon={MapPin}>
              {F(t("pessoa.f.rua"), "enderecoRua", false, true)}
              {F(t("pessoa.f.cidade"), "cidade")}
              {F(t("pessoa.f.estado"), "estadoUf")}
              {F(t("pessoa.f.cep"), "cep")}
            </Section>

            <Section title={t("pessoa.contato_origem")} icon={Phone}>
              {F(t("pessoa.f.como_ficou"), "comoFicouSabendo")}
            </Section>
          </div>
          <ContatoWhatsappSection pessoaId={pessoaId} />
        </TabsContent>

        {/* ── Tab: Classificação ────────────────────────────────── */}
        <TabsContent value="classificacao" className="space-y-4 mt-0">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Section title="Segmentação Sofia" icon={Brain}>
              {F("Perfil principal", "perfilPrincipal", false, false, [
                { value: "P1", label: "P1 — Explorador Espiritual" },
                { value: "P2", label: "P2 — Profissional de Cura" },
                { value: "P3", label: "P3 — Músico em Expansão" },
                { value: "P4", label: "P4 — Buscador de Bem-Estar" },
                { value: "P5", label: "P5 — Líder Comunitário" },
              ])}
              {F("Temperatura relacional", "temperatura", false, false, [
                "inativo", "latente", "frio", "morno", "quente", "muito_quente",
              ])}
              {F("Macrojornada principal", "macrojornadaPrincipalId", false, false, [
                { value: "MJ01", label: "MJ01 — Autoconhecimento" },
                { value: "MJ02", label: "MJ02 — Cura" },
                { value: "MJ03", label: "MJ03 — Profissionalização" },
                { value: "MJ04", label: "MJ04 — Expansão Musical" },
                { value: "MJ05", label: "MJ05 — Comunidade" },
                { value: "MJ06", label: "MJ06 — Liderança" },
              ])}
              {F("Estilo cognitivo", "estiloCognitivo", false, false, [
                "Estruturado", "Visionário", "Vivencial", "Profissional",
              ])}
              {F("Velocidade de evolução", "velocidadeEvolucao", false, false, [
                "Contemplativa", "Moderada", "Acelerada",
              ])}
              {F("Idioma preferido", "preferredLanguage", false, false, [
                "pt-BR", "fr", "en", "es",
              ])}
              {F("Consentimento LGPD", "consentStatus", false, false, [
                "pendente", "concedido", "revogado",
              ])}
            </Section>

            <Section title="Intenção & Objetivos" icon={Leaf}>
              {F("Intenção principal", "intencaoPrincipal", false, true)}
              {/* Objetivos declarados — up to 3 items (text[]) */}
              {!editing && pessoa.objetivosDeclarados && pessoa.objetivosDeclarados.length > 0 && (
                <div className="col-span-2 flex flex-col gap-0.5">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Objetivos declarados</span>
                  <ul className="space-y-0.5">
                    {pessoa.objetivosDeclarados.map((obj, i) => (
                      <li key={i} className="text-sm flex items-start gap-1.5">
                        <span className="text-muted-foreground shrink-0">{i + 1}.</span>
                        <span>{obj}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {editing && (
                <div className="col-span-2 space-y-1.5">
                  <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                    Objetivos declarados <span className="font-normal normal-case">(até 3)</span>
                  </Label>
                  {([0, 1, 2] as const).map(i => (
                    <Input
                      key={i}
                      value={objetivos[i]}
                      onChange={e => setObjetivos(prev => {
                        const n: [string, string, string] = [...prev] as [string, string, string];
                        n[i] = e.target.value;
                        return n;
                      })}
                      className="h-8 text-sm"
                      placeholder={`Objetivo ${i + 1}`}
                    />
                  ))}
                </div>
              )}
            </Section>

            <Section title="Interesse & Contato" icon={Phone}>
              {F(t("pessoa.f.indicado_por"), "qualAmigoParceiro")}
              {F(t("pessoa.f.pref_contato"), "preferenciaContato")}
              {F(t("pessoa.f.contato_para"), "contatoPara", false, true)}
              {F(t("pessoa.f.obs_adicionais"), "adicionarContato", true, true)}
              {F(t("pessoa.f.id_aluno"), "idAlunoCliente")}
              {F(t("pessoa.f.turma"), "turma")}
              {F(t("leads.servico_int"), "servicoInteresse", false, true)}
            </Section>
          </div>
        </TabsContent>

        {/* ── Tab: Histórico ────────────────────────────────────── */}
        <TabsContent value="historico" className="space-y-4 mt-0">
          <FormulariosEventoSection pessoaId={pessoaId} />
          <ServicosSection pessoaId={pessoaId} />
          <InstrumentosSection pessoaId={pessoaId} />
          <ParticipacoesSection pessoaId={pessoaId} />
          <NotesSection pessoaId={pessoaId} />
        </TabsContent>

        {/* ── Tab: Sofia ────────────────────────────────────────── */}
        <TabsContent value="sofia" className="space-y-4 mt-0">
          {/* Conversas */}
          <Card className="shadow-sm border-border/50">
            <CardHeader className="py-3 px-5 border-b border-border/40">
              <CardTitle className="text-xs font-bold tracking-[0.12em] uppercase text-muted-foreground flex items-center gap-2">
                <MessageSquare className="h-3.5 w-3.5" />
                {t("pessoa.conversas")}
                {conversas.length > 0 && (
                  <Badge variant="secondary" className="text-[10px] ml-1 px-1.5 py-0 font-normal">
                    {conversas.length}
                  </Badge>
                )}
                <Button
                  size="sm" variant="outline"
                  className="ml-auto h-6 px-2 text-[11px] normal-case font-normal tracking-normal"
                  onClick={() => navigate(`/sofia?pessoa=${pessoaId}`)}>
                  <MessageSquare className="h-3 w-3 mr-1" />
                  {t("pessoa.nova_conversa")}
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {conversas.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground/60 gap-2">
                  <MessageSquare className="h-8 w-8 opacity-20" />
                  <p className="text-xs">{t("pessoa.nenhuma_conversa")}</p>
                </div>
              ) : (
                <div className="divide-y divide-border/50">
                  {conversas.map(conv => (
                    <button
                      key={conv.id}
                      onClick={() => navigate(`/sofia?pessoa=${pessoaId}&conv=${conv.id}`)}
                      className="w-full flex items-center gap-4 px-5 py-3 hover:bg-muted/40 transition-colors text-left group">
                      <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                        <MessageSquare className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{conv.title}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{conv.model}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs text-muted-foreground/60">
                          {formatDateBR(conv.createdAt)}
                        </span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Campos sensíveis — admin only */}
          {isAdmin && (
            <>
              <Section title={t("pessoa.perfil_espiritual")} icon={Leaf}>
                {F(t("pessoa.f.conectado"), "conectadoProposito", true, true)}
                {F(t("pessoa.f.busca_espiritual"), "buscaEspiritual", false, true)}
                {F(t("pessoa.f.lugar_musica"), "lugarMusicaSom", false, true)}
                {F(t("pessoa.f.participou_som"), "participouTrabalhoSom")}
                {F(t("pessoa.f.qual_trabalho_som"), "qualTrabalhoSom", true, true)}
                {F(t("pessoa.f.midia_input"), "midiaInput")}
                {F(t("pessoa.f.midia_outro"), "midiaInputOutro")}
                {F(t("pessoa.f.terapeuta"), "terapeuta")}
                {F(t("pessoa.f.formacao"), "formacaoMusicaTerapia", true, true)}
              </Section>

              <Section title={t("pessoa.curso_proposito")} icon={BookOpen}>
                {F(t("pessoa.f.objetivo_curso"), "objetivoCurso", true, true)}
                {F(t("pessoa.f.proposito_curso"), "cursoProposito", true, true)}
                {F(t("pessoa.f.expectativas"), "cursoExpectativas", true, true)}
                {F(t("pessoa.f.outro_curso"), "outroCurso")}
                {F(t("pessoa.f.sentido_participar"), "sentidoParticipar", true, true)}
              </Section>

              <Section title={t("pessoa.saude_bem")} icon={Activity}>
                {F(t("pessoa.f.exp_ayahuasca"), "experienciaAyahuasca", true, true)}
                {F(t("pessoa.f.psicodelicosDrogas"), "psicodelicosDrogas", false, true)}
                {F(t("pessoa.f.trauma_vida"), "traumaVida", true, true)}
                {F(t("pessoa.f.ansiolitico"), "ansioliticoAntidepressivos")}
                {F(t("pessoa.f.problema_saude"), "problemaSaude", true, true)}
                {F(t("pessoa.f.psicoterapia"), "psicoterapiaPsiquiatria")}
                {F(t("pessoa.f.sensacao"), "sensacao", true, true)}
                {F(t("pessoa.f.sensacao_perseguido"), "sensacaoPerseguido", false, true)}
                {F("Covid", "covid")}
                {F("Comprovante Covid", "comprovanteCovid")}
              </Section>
            </>
          )}
        </TabsContent>

        {/* ── Tab: Decisões ─────────────────────────────────────── */}
        <TabsContent value="decisoes" className="space-y-4 mt-0">
          <DecisionRunsSection pessoaId={pessoaId} />
        </TabsContent>
      </Tabs>

      <div className="text-xs text-muted-foreground/50 text-right">
        {t("pessoa.cadastro")}: {formatDateTimeBR(pessoa.createdAt)} ·
        {t("pessoa.atualizado")}: {formatDateTimeBR(pessoa.updatedAt)}
      </div>
    </div>
  );
}
