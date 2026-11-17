import { pgTable, serial, text, boolean, integer, date, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { relations } from "drizzle-orm";

export const pessoasTable = pgTable("pessoas", {
  id: serial("id").primaryKey(),
  codigo: text("codigo").notNull().unique(),
  ativo: boolean("ativo").notNull().default(true),
  arquivadoEm: timestamp("arquivado_em", { withTimezone: true }),
  // Tombstone/reference retained after a merge. The source row is never deleted.
  mergedIntoPessoaId: integer("merged_into_pessoa_id").references((): AnyPgColumn => pessoasTable.id, { onDelete: "set null" }),

  // Dados pessoais
  nome: text("nome").notNull(),
  sobrenome: text("sobrenome"),
  cpf: text("cpf"),
  dataNascimento: date("data_nascimento"),
  // Idade dita pela pessoa e a data da declaração; nunca vira data_nascimento.
  idadeDeclarada: integer("idade_declarada"),
  idadeDeclaradaEm: date("idade_declarada_em"),
  sexo: text("sexo"),
  email: text("email"),
  celular: text("celular"),
  celularNormalizado: text("celular_normalizado"),
  instagram: text("instagram"),
  site: text("site"),
  profissao: text("profissao"),
  profissaoCategoria: text("profissao_categoria"),

  // Endereço
  enderecoRua: text("endereco_rua"),
  cidade: text("cidade"),
  estadoUf: text("estado_uf"),
  cep: text("cep"),

  // Interesse / Contato
  servicoInteresse: text("servico_interesse"),
  comoFicouSabendo: text("como_ficou_sabendo"),
  qualAmigoParceiro: text("qual_amigo_parceiro"),
  preferenciaContato: text("preferencia_contato"),
  contatoPara: text("contato_para"),
  adicionarContato: text("adicionar_contato"),

  // Participações
  aguaPresencial: text("agua_presencial"),
  fogoPresencial: text("fogo_presencial"),
  workshopAgua: text("workshop_agua"),
  cacau: text("cacau"),
  ayahuasca: text("ayahuasca"),
  concerto: text("concerto"),
  zapPierre: text("zap_pierre"),
  idAlunoCliente: text("id_aluno_cliente"),
  turma: text("turma"),

  // Perfil Espiritual/Musical
  conectadoProposito: text("conectado_proposito"),
  buscaEspiritual: text("busca_espiritual"),
  lugarMusicaSom: text("lugar_musica_som"),
  participouTrabalhoSom: text("participou_trabalho_som"),
  qualTrabalhoSom: text("qual_trabalho_som"),
  midiaInput: text("midia_input"),
  midiaInputOutro: text("midia_input_outro"),
  terapeuta: text("terapeuta"),
  formacaoMusicaTerapia: text("formacao_musica_terapia"),

  // Curso
  objetivoCurso: text("objetivo_curso"),
  cursoProposito: text("curso_proposito"),
  cursoExpectativas: text("curso_expectativas"),
  outroCurso: text("outro_curso"),
  sentidoParticipar: text("sentido_participar"),

  // Saúde (sensível)
  experienciaAyahuasca: text("experiencia_ayahuasca"),
  psicodelicosDrogas: text("psicodelicos_drogas"),
  traumaVida: text("trauma_vida"),
  ansioliticoAntidepressivos: text("ansiolitico_antidepressivos"),
  problemaSaude: text("problema_saude"),
  psicoterapiaPsiquiatria: text("psicoterapia_psiquiatria"),
  sensacao: text("sensacao"),
  sensacaoPerseguido: text("sensacao_perseguido"),

  // Covid
  covid: text("covid"),
  comprovanteCovid: text("comprovante_covid"),

  // Classificação / Segmentação (doc 13A)
  perfilPrincipal: text("perfil_principal"),
  objetivosDeclarados: text("objetivos_declarados").array(),
  macrojornadaPrincipalId: text("macrojornada_principal_id"),
  intencaoPrincipal: text("intencao_principal"),
  temperatura: text("temperatura"),
  estiloCognitivo: text("estilo_cognitivo"),
  velocidadeEvolucao: text("velocidade_evolucao"),
  preferredLanguage: text("preferred_language"),
  consentStatus: text("consent_status"),

  // Referência numérica do JSON original
  numeroRef: integer("numero_ref"),
  dataRegistro: date("data_registro"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPessoaSchema = createInsertSchema(pessoasTable).omit({
  id: true,
  codigo: true,
  celularNormalizado: true,
  createdAt: true,
  updatedAt: true,
});
export const selectPessoaSchema = createSelectSchema(pessoasTable);

export type InsertPessoa = z.infer<typeof insertPessoaSchema>;
export type Pessoa = typeof pessoasTable.$inferSelect;

// ── 1-para-muitos: Serviços de Interesse ───────────────────────
export const pessoaServicos = pgTable("pessoa_servicos", {
  id: serial("id").primaryKey(),
  pessoaId: integer("pessoa_id").notNull().references(() => pessoasTable.id, { onDelete: "cascade" }),
  servicoNome: text("servico_nome").notNull(),
  cursosInscricaoId: integer("cursos_inscricao_id").references(() => cursosInscricao.id, { onDelete: "set null" }),
  dataInteresse: date("data_interesse"),
  obs: text("obs"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pessoaServicosRelations = relations(pessoaServicos, ({ one }) => ({
  pessoa: one(pessoasTable, { fields: [pessoaServicos.pessoaId], references: [pessoasTable.id] }),
}));

export type PessoaServico = typeof pessoaServicos.$inferSelect;
export type InsertPessoaServico = typeof pessoaServicos.$inferInsert;

// ── 1-para-muitos: Participações ───────────────────────────────
export const pessoaParticipacoes = pgTable("pessoa_participacoes", {
  id: serial("id").primaryKey(),
  pessoaId: integer("pessoa_id").notNull().references(() => pessoasTable.id, { onDelete: "cascade" }),
  curso: text("curso").notNull(),
  data: date("data"),
  local: text("local"),
  valor: text("valor"),
  obs: text("obs"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pessoaParticipacoesRelations = relations(pessoaParticipacoes, ({ one }) => ({
  pessoa: one(pessoasTable, { fields: [pessoaParticipacoes.pessoaId], references: [pessoasTable.id] }),
}));

export type PessoaParticipacao = typeof pessoaParticipacoes.$inferSelect;
export type InsertPessoaParticipacao = typeof pessoaParticipacoes.$inferInsert;

// ── 1-para-muitos: Instrumentos ────────────────────────────────
export const pessoaInstrumentos = pgTable("pessoa_instrumentos", {
  id: serial("id").primaryKey(),
  pessoaId: integer("pessoa_id").notNull().references(() => pessoasTable.id, { onDelete: "cascade" }),
  item: text("item").notNull(),
  dataCompra: date("data_compra"),
  valor: text("valor"),
  obs: text("obs"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pessoaInstrumentosRelations = relations(pessoaInstrumentos, ({ one }) => ({
  pessoa: one(pessoasTable, { fields: [pessoaInstrumentos.pessoaId], references: [pessoasTable.id] }),
}));

export type PessoaInstrumento = typeof pessoaInstrumentos.$inferSelect;
export type InsertPessoaInstrumento = typeof pessoaInstrumentos.$inferInsert;

// ── Catálogos globais ──────────────────────────────────────────
export const servicosCatalogo = pgTable("servicos_catalogo", {
  id: serial("id").primaryKey(),
  nome: text("nome").notNull(),
  descricao: text("descricao"),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ServicoCatalogo = typeof servicosCatalogo.$inferSelect;
export type InsertServicoCatalogo = typeof servicosCatalogo.$inferInsert;

export const instrumentosCatalogo = pgTable("instrumentos_catalogo", {
  id: serial("id").primaryKey(),
  nome: text("nome").notNull(),
  descricao: text("descricao"),
  ativo: boolean("ativo").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type InstrumentoCatalogo = typeof instrumentosCatalogo.$inferSelect;
export type InsertInstrumentoCatalogo = typeof instrumentosCatalogo.$inferInsert;

// ── Cursos de Inscrição ────────────────────────────────────────
export const cursosInscricao = pgTable("cursos_inscricao", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  nome: text("nome").notNull(),
  descricao: text("descricao"),
  local: text("local"),
  dataInicio: date("data_inicio"),
  dataFim: date("data_fim"),
  observacoes: text("observacoes"),
  ativo: boolean("ativo").notNull().default(true),
  nucleo: text("nucleo").notNull().default("EDUCATION"),
  tipoEvento: text("tipo_evento").notNull().default("CURSO"),
  courseId: integer("course_id"),
  // Turma à qual este link pertence. Cada turma gera o seu próprio link; um
  // link sem turma (`null`) é um link avulso, criado à mão.
  classId: integer("class_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type CursoInscricao = typeof cursosInscricao.$inferSelect;
export type InsertCursoInscricao = typeof cursosInscricao.$inferInsert;
