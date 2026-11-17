import { useState, useEffect } from "react";
import { useListPessoas, useCreatePessoa, useUpdatePessoa, useInativarPessoa, useReativarPessoa } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { UserPlus, Search, ToggleLeft, ToggleRight, Pencil, UserX, UserCheck } from "lucide-react";
import type { Pessoa, PessoaInput } from "@workspace/api-client-react";
import { useLang } from "@/contexts/language";
import { useUserSession } from "@/contexts/user-session";

type FormData = Omit<PessoaInput, "nome"> & { nome: string };

const EMPTY_FORM: FormData = {
  nome: "",
  sobrenome: "",
  cpf: "",
  dataNascimento: "",
  sexo: "",
  email: "",
  celular: "",
  instagram: "",
  site: "",
  profissao: "",
  profissaoCategoria: "",
  enderecoRua: "",
  cidade: "",
  estadoUf: "",
  cep: "",
  servicoInteresse: "",
  comoFicouSabendo: "",
  qualAmigoParceiro: "",
  preferenciaContato: "",
  contatoPara: "",
  adicionarContato: "",
  aguaPresencial: "",
  fogoPresencial: "",
  workshopAgua: "",
  cacau: "",
  ayahuasca: "",
  concerto: "",
  zapPierre: "",
  idAlunoCliente: "",
  turma: "",
  conectadoProposito: "",
  buscaEspiritual: "",
  lugarMusicaSom: "",
  participouTrabalhoSom: "",
  qualTrabalhoSom: "",
  midiaInput: "",
  midiaInputOutro: "",
  terapeuta: "",
  formacaoMusicaTerapia: "",
  objetivoCurso: "",
  cursoProposito: "",
  cursoExpectativas: "",
  outroCurso: "",
  sentidoParticipar: "",
  experienciaAyahuasca: "",
  psicodelicosDrogas: "",
  traumaVida: "",
  ansioliticoAntidepressivos: "",
  problemaSaude: "",
  psicoterapiaPsiquiatria: "",
  sensacao: "",
  sensacaoPerseguido: "",
};

function Field({ label, name, value, onChange, type = "text" }: {
  label: string;
  name: string;
  value: string;
  onChange: (name: string, value: string) => void;
  type?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type={type}
        value={value ?? ""}
        onChange={(e) => onChange(name, e.target.value)}
        className="h-8 text-sm"
      />
    </div>
  );
}

function PessoaModal({
  open,
  onClose,
  pessoa,
}: {
  open: boolean;
  onClose: () => void;
  pessoa: Pessoa | null;
}) {
  const queryClient = useQueryClient();
  const { t } = useLang();
  const { authHeader } = useUserSession();
  const createMutation = useCreatePessoa({ request: { headers: authHeader } });
  const updateMutation = useUpdatePessoa({ request: { headers: authHeader } });

  const buildForm = (p: Pessoa | null): FormData =>
    p
      ? {
          nome: p.nome ?? "",
          sobrenome: p.sobrenome ?? "",
          cpf: p.cpf ?? "",
          dataNascimento: p.dataNascimento ?? "",
          sexo: p.sexo ?? "",
          email: p.email ?? "",
          celular: p.celular ?? "",
          instagram: p.instagram ?? "",
          site: p.site ?? "",
          profissao: p.profissao ?? "",
          profissaoCategoria: p.profissaoCategoria ?? "",
          enderecoRua: p.enderecoRua ?? "",
          cidade: p.cidade ?? "",
          estadoUf: p.estadoUf ?? "",
          cep: p.cep ?? "",
          servicoInteresse: p.servicoInteresse ?? "",
          comoFicouSabendo: p.comoFicouSabendo ?? "",
          qualAmigoParceiro: p.qualAmigoParceiro ?? "",
          preferenciaContato: p.preferenciaContato ?? "",
          contatoPara: p.contatoPara ?? "",
          adicionarContato: p.adicionarContato ?? "",
          aguaPresencial: p.aguaPresencial ?? "",
          fogoPresencial: p.fogoPresencial ?? "",
          workshopAgua: p.workshopAgua ?? "",
          cacau: p.cacau ?? "",
          ayahuasca: p.ayahuasca ?? "",
          concerto: p.concerto ?? "",
          zapPierre: p.zapPierre ?? "",
          idAlunoCliente: p.idAlunoCliente ?? "",
          turma: p.turma ?? "",
          conectadoProposito: p.conectadoProposito ?? "",
          buscaEspiritual: p.buscaEspiritual ?? "",
          lugarMusicaSom: p.lugarMusicaSom ?? "",
          participouTrabalhoSom: p.participouTrabalhoSom ?? "",
          qualTrabalhoSom: p.qualTrabalhoSom ?? "",
          midiaInput: p.midiaInput ?? "",
          midiaInputOutro: p.midiaInputOutro ?? "",
          terapeuta: p.terapeuta ?? "",
          formacaoMusicaTerapia: p.formacaoMusicaTerapia ?? "",
          objetivoCurso: p.objetivoCurso ?? "",
          cursoProposito: p.cursoProposito ?? "",
          cursoExpectativas: p.cursoExpectativas ?? "",
          outroCurso: p.outroCurso ?? "",
          sentidoParticipar: p.sentidoParticipar ?? "",
          experienciaAyahuasca: p.experienciaAyahuasca ?? "",
          psicodelicosDrogas: p.psicodelicosDrogas ?? "",
          traumaVida: p.traumaVida ?? "",
          ansioliticoAntidepressivos: p.ansioliticoAntidepressivos ?? "",
          problemaSaude: p.problemaSaude ?? "",
          psicoterapiaPsiquiatria: p.psicoterapiaPsiquiatria ?? "",
          sensacao: p.sensacao ?? "",
          sensacaoPerseguido: p.sensacaoPerseguido ?? "",
        }
      : { ...EMPTY_FORM };

  const [form, setForm] = useState<FormData>(() => buildForm(pessoa));

  useEffect(() => {
    setForm(buildForm(pessoa));
  }, [pessoa, open]);

  const handleChange = (name: string, value: string) => {
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async () => {
    if (!form.nome.trim()) {
      toast.error(t("leads.nome_req"));
      return;
    }
    const payload = Object.fromEntries(
      Object.entries(form).filter(([, v]) => v !== "")
    ) as unknown as PessoaInput;

    try {
      if (pessoa) {
        await updateMutation.mutateAsync({ id: pessoa.id, data: payload });
        toast.success(t("leads.atualizado"));
      } else {
        await createMutation.mutateAsync({ data: payload });
        toast.success(t("leads.criado"));
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/pessoas"] });
      onClose();
    } catch {
      toast.error(t("leads.erro_salvar"));
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            {pessoa ? (
              <>
                <span>{t("leads.editar_lead")}</span>
                <span className="text-sm font-mono bg-muted px-2 py-0.5 rounded text-muted-foreground">{pessoa.codigo}</span>
              </>
            ) : t("leads.novo_lead")}
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="pessoais" className="mt-2">
          <TabsList className="grid grid-cols-4 w-full h-auto gap-1 mb-4">
            <TabsTrigger value="pessoais" className="text-xs">{t("leads.dados_pessoais")}</TabsTrigger>
            <TabsTrigger value="interesse" className="text-xs">{t("leads.interesse")}</TabsTrigger>
            <TabsTrigger value="participacoes" className="text-xs">{t("leads.partic_perfil")}</TabsTrigger>
            <TabsTrigger value="saude" className="text-xs">{t("leads.saude")}</TabsTrigger>
          </TabsList>

          {/* DADOS PESSOAIS */}
          <TabsContent value="pessoais" className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("leads.f.nome")} name="nome" value={form.nome} onChange={handleChange} />
              <Field label={t("leads.f.sobrenome")} name="sobrenome" value={form.sobrenome ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.cpf")} name="cpf" value={form.cpf ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.nascimento")} name="dataNascimento" value={form.dataNascimento ?? ""} onChange={handleChange} type="date" />
              <Field label={t("leads.f.sexo")} name="sexo" value={form.sexo ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.profissao")} name="profissao" value={form.profissao ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.prof_cat")} name="profissaoCategoria" value={form.profissaoCategoria ?? ""} onChange={handleChange} />
              <Field label={t("common.email")} name="email" value={form.email ?? ""} onChange={handleChange} type="email" />
              <Field label={t("common.celular")} name="celular" value={form.celular ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.instagram")} name="instagram" value={form.instagram ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.site")} name="site" value={form.site ?? ""} onChange={handleChange} />
            </div>
            <div className="border-t pt-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t("leads.f.endereco")}</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("leads.f.rua")} name="enderecoRua" value={form.enderecoRua ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.cidade")} name="cidade" value={form.cidade ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.estado")} name="estadoUf" value={form.estadoUf ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.cep")} name="cep" value={form.cep ?? ""} onChange={handleChange} />
              </div>
            </div>
          </TabsContent>

          {/* INTERESSE */}
          <TabsContent value="interesse" className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("leads.servico_int")} name="servicoInteresse" value={form.servicoInteresse ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.como_soube")} name="comoFicouSabendo" value={form.comoFicouSabendo ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.qual_amigo")} name="qualAmigoParceiro" value={form.qualAmigoParceiro ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.pref_contato")} name="preferenciaContato" value={form.preferenciaContato ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.contato_para")} name="contatoPara" value={form.contatoPara ?? ""} onChange={handleChange} />
            </div>
            <div className="border-t pt-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t("leads.f.curso")}</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("leads.f.objetivo_curso")} name="objetivoCurso" value={form.objetivoCurso ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.proposito_curso")} name="cursoProposito" value={form.cursoProposito ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.expectativas")} name="cursoExpectativas" value={form.cursoExpectativas ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.outro_curso")} name="outroCurso" value={form.outroCurso ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.sentido_partic")} name="sentidoParticipar" value={form.sentidoParticipar ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.add_contato")} name="adicionarContato" value={form.adicionarContato ?? ""} onChange={handleChange} />
              </div>
            </div>
          </TabsContent>

          {/* PARTICIPAÇÕES & PERFIL */}
          <TabsContent value="participacoes" className="space-y-4">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t("leads.f.participacoes")}</p>
              <div className="grid grid-cols-3 gap-3">
                <Field label={t("leads.f.agua_pres")} name="aguaPresencial" value={form.aguaPresencial ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.fogo_pres")} name="fogoPresencial" value={form.fogoPresencial ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.workshop_agua")} name="workshopAgua" value={form.workshopAgua ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.cacau")} name="cacau" value={form.cacau ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.ayahuasca")} name="ayahuasca" value={form.ayahuasca ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.concerto")} name="concerto" value={form.concerto ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.zap_pierre")} name="zapPierre" value={form.zapPierre ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.id_aluno")} name="idAlunoCliente" value={form.idAlunoCliente ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.turma")} name="turma" value={form.turma ?? ""} onChange={handleChange} />
              </div>
            </div>
            <div className="border-t pt-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t("leads.f.perfil_esp")}</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("leads.f.conectado")} name="conectadoProposito" value={form.conectadoProposito ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.busca_esp")} name="buscaEspiritual" value={form.buscaEspiritual ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.lugar_musica")} name="lugarMusicaSom" value={form.lugarMusicaSom ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.partic_som")} name="participouTrabalhoSom" value={form.participouTrabalhoSom ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.qual_som")} name="qualTrabalhoSom" value={form.qualTrabalhoSom ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.midia")} name="midiaInput" value={form.midiaInput ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.midia_outro")} name="midiaInputOutro" value={form.midiaInputOutro ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.terapeuta")} name="terapeuta" value={form.terapeuta ?? ""} onChange={handleChange} />
                <Field label={t("leads.f.formacao")} name="formacaoMusicaTerapia" value={form.formacaoMusicaTerapia ?? ""} onChange={handleChange} />
              </div>
            </div>
          </TabsContent>

          {/* SAÚDE */}
          <TabsContent value="saude" className="space-y-3">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
              <p className="text-xs text-amber-800 font-medium">{t("leads.f.saude_aviso")}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("leads.f.exp_ayahuasca")} name="experienciaAyahuasca" value={form.experienciaAyahuasca ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.psicodelicos")} name="psicodelicosDrogas" value={form.psicodelicosDrogas ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.trauma")} name="traumaVida" value={form.traumaVida ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.ansiolitico")} name="ansioliticoAntidepressivos" value={form.ansioliticoAntidepressivos ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.prob_saude")} name="problemaSaude" value={form.problemaSaude ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.psicoterapia")} name="psicoterapiaPsiquiatria" value={form.psicoterapiaPsiquiatria ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.sensacao")} name="sensacao" value={form.sensacao ?? ""} onChange={handleChange} />
              <Field label={t("leads.f.sensacao_pers")} name="sensacaoPerseguido" value={form.sensacaoPerseguido ?? ""} onChange={handleChange} />
            </div>
          </TabsContent>
        </Tabs>

        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={onClose} disabled={isPending}>{t("common.cancelar")}</Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending ? t("pessoa.salvando") : pessoa ? t("pessoa.salvar_alt") : t("leads.criar")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function Leads() {
  const queryClient = useQueryClient();
  const { t, lang } = useLang();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [apenasAtivos, setApenasAtivos] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editPessoa, setEditPessoa] = useState<Pessoa | null>(null);

  const { authHeader } = useUserSession();
  const inativarMutation = useInativarPessoa({ request: { headers: authHeader } });
  const reativarMutation = useReativarPessoa({ request: { headers: authHeader } });

  const { data: pessoas, isLoading } = useListPessoas(
    { search: debouncedSearch || undefined, ativo: apenasAtivos ? "true" : undefined },
    { request: { headers: authHeader } },
  );

  const handleSearchChange = (v: string) => {
    setSearch(v);
    clearTimeout((handleSearchChange as any)._t);
    (handleSearchChange as any)._t = setTimeout(() => setDebouncedSearch(v), 300);
  };

  const openNew = () => {
    setEditPessoa(null);
    setModalOpen(true);
  };

  const openEdit = (p: Pessoa) => {
    setEditPessoa(p);
    setModalOpen(true);
  };

  const handleToggleAtivo = async (p: Pessoa) => {
    try {
      if (p.ativo) {
        await inativarMutation.mutateAsync({ id: p.id });
        toast.success(`${p.nome} ${t("leads.inativado")}`);
      } else {
        await reativarMutation.mutateAsync({ id: p.id });
        toast.success(`${p.nome} ${t("leads.reativado")}`);
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/pessoas"] });
    } catch {
      toast.error(t("admin.cat.err_status"));
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-1">{t("leads.title")}</h1>
          <p className="text-muted-foreground">{t("leads.subtitle")}</p>
        </div>
        <Button onClick={openNew} className="flex items-center gap-2">
          <UserPlus className="h-4 w-4" />
          {t("leads.novo_lead")}
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            className="pl-8 h-9 text-sm"
            placeholder={t("leads.buscar")}
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </div>
        <button
          onClick={() => setApenasAtivos(!apenasAtivos)}
          className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md border transition-colors ${
            apenasAtivos
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-background text-muted-foreground border-border hover:bg-muted"
          }`}
        >
          {apenasAtivos ? <ToggleRight className="h-3.5 w-3.5" /> : <ToggleLeft className="h-3.5 w-3.5" />}
          {apenasAtivos ? t("leads.somente_ativos") : t("leads.todos")}
        </button>
      </div>

      {/* Table */}
      <Card className="shadow-sm border-border/50">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">{t("common.codigo")}</TableHead>
                  <TableHead>{t("common.nome")}</TableHead>
                  <TableHead>{t("common.email")}</TableHead>
                  <TableHead>{t("common.celular")}</TableHead>
                  <TableHead>{t("leads.cidade_uf")}</TableHead>
                  <TableHead>{t("leads.servico_int")}</TableHead>
                  <TableHead className="w-20 text-center">{t("common.status")}</TableHead>
                  <TableHead className="w-20 text-right">{t("common.acoes")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!pessoas || pessoas.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                      {t("leads.nenhum")}
                    </TableCell>
                  </TableRow>
                ) : (
                  pessoas.map((p) => (
                    <TableRow key={p.id} className="group">
                      <TableCell className="font-mono text-xs text-muted-foreground">{p.codigo}</TableCell>
                      <TableCell className="font-medium">
                        {p.nome}{p.sobrenome ? ` ${p.sobrenome}` : ""}
                      </TableCell>
                      <TableCell className="text-sm">{p.email ?? "-"}</TableCell>
                      <TableCell className="text-sm">{p.celular ?? "-"}</TableCell>
                      <TableCell className="text-sm">
                        {[p.cidade, p.estadoUf].filter(Boolean).join(" / ") || "-"}
                      </TableCell>
                      <TableCell className="text-sm">{p.servicoInteresse ?? "-"}</TableCell>
                      <TableCell className="text-center">
                        <Badge variant={p.ativo ? "default" : "secondary"} className="text-[10px]">
                          {p.ativo ? t("common.ativo") : t("pessoa.inativo")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => openEdit(p)}
                            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                            title={t("common.editar")}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => handleToggleAtivo(p)}
                            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                            title={p.ativo ? t("common.inativar") : t("common.reativar")}
                          >
                            {p.ativo ? <UserX className="h-3.5 w-3.5" /> : <UserCheck className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <PessoaModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        pessoa={editPessoa}
      />
    </div>
  );
}
