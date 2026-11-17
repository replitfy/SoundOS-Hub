import { Router, type IRouter, type RequestHandler } from "express";
import { armazenamentoDeAnexos, prefixoDaConversa } from "../services/anexosArmazenamento";
import { eq, ilike, or, and, sql, asc, desc, getTableColumns, isNull, isNotNull, inArray, type SQL } from "drizzle-orm";
import { db, pessoasTable, conversations, pessoaServicos, pessoaParticipacoes, pessoaInstrumentos, pessoaEvidencias, decisionRuns } from "@workspace/db";
import { CreatePessoaBody, UpdatePessoaBody, UpdatePessoaParams, GetPessoaParams, InativarPessoaParams, ReativarPessoaParams, MergePessoaBody, BatchArchivePessoasBody } from "@workspace/api-zod";
import { requireAdminRole, requireAuth, type AuthedRequest } from "../middlewares/roleAuth";
import { registrarEdicaoHumana, getStatusCampos, withPessoaLock, PessoaNotFoundError } from "../services/evidencias";
import { executePessoaMerge, getMergePreview, listPessoaNotes, PessoaMergeError, type MergeChoice } from "../services/pessoaMerge";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Helpers ───────────────────────────────────────────────────
// Adicionar um middleware a uma rota faz o Express inferir req.params como
// string | string[]; os dados da ficha nunca usam params repetidos, então
// sempre pegamos o primeiro valor.
function paramId(raw: string | string[] | undefined): number {
  const s = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  return parseInt(s, 10);
}

const rejectMergedPessoaMutation: RequestHandler = async (req, res, next) => {
  const id = paramId(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [pessoa] = await db.select({
    id: pessoasTable.id,
    mergedIntoPessoaId: pessoasTable.mergedIntoPessoaId,
  }).from(pessoasTable).where(eq(pessoasTable.id, id)).limit(1);
  if (!pessoa) { res.status(404).json({ error: "Pessoa not found" }); return; }
  if (pessoa.mergedIntoPessoaId !== null) {
    res.status(409).json({ error: "Merged pessoas are immutable", mergedIntoPessoaId: pessoa.mergedIntoPessoaId });
    return;
  }
  next();
};

async function generateCodigo(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const digits = Math.floor(100000 + Math.random() * 900000).toString();
    const codigo = `PS-${digits}`;
    const existing = await db
      .select({ id: pessoasTable.id })
      .from(pessoasTable)
      .where(eq(pessoasTable.codigo, codigo))
      .limit(1);
    if (existing.length === 0) return codigo;
  }
  throw new Error("Failed to generate unique codigo after 10 attempts");
}

// ── Subquery: conversation count per pessoa ───────────────────
const convCountSq = db
  .select({
    pessoaId: conversations.pessoaId,
    count: sql<number>`COUNT(*)`.as("count"),
  })
  .from(conversations)
  .groupBy(conversations.pessoaId)
  .as("conv_counts");

// ── GET /pessoas ───────────────────────────────────────────────
// Lista de fichas do CRM: contém dados pessoais e de saúde sensíveis, então
// exige um atendente autenticado (não pode ser acessada anonimamente).
router.get("/pessoas", requireAuth, async (req, res): Promise<void> => {
  const {
    search,
    celular,
    ativo,
    arquivado,
    limit = "50",
    offset = "0",
    sort = "nome",
    direction = "asc",
    includeTotal,
  } = req.query as Record<string, string>;

  const conditions: SQL[] = [];

  // The operational list omits unusable orphan rows, but keeps them in the
  // database for audit and possible later enrichment.
  conditions.push(or(
    sql`NULLIF(BTRIM(${pessoasTable.nome}), '') IS NOT NULL`,
    sql`NULLIF(BTRIM(${pessoasTable.email}), '') IS NOT NULL`,
  )!);

  if (ativo === "true") conditions.push(eq(pessoasTable.ativo, true));
  if (ativo === "false") conditions.push(eq(pessoasTable.ativo, false));
  if (arquivado === "true") {
    conditions.push(isNotNull(pessoasTable.arquivadoEm));
  } else {
    // Archived records are intentionally absent from every normal list,
    // including phone lookups used by operational screens.
    conditions.push(isNull(pessoasTable.arquivadoEm));
  }

  const parsedLimit = parseInt(limit, 10);
  const parsedOffset = parseInt(offset, 10);
  const lim = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), includeTotal === "true" ? 100 : 500) : 50;
  const off = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0;

  const selectFields = {
    id: pessoasTable.id,
    codigo: pessoasTable.codigo,
    ativo: pessoasTable.ativo,
    arquivadoEm: pessoasTable.arquivadoEm,
    mergedIntoPessoaId: pessoasTable.mergedIntoPessoaId,
    nome: pessoasTable.nome,
    sobrenome: pessoasTable.sobrenome,
    cpf: pessoasTable.cpf,
    dataNascimento: pessoasTable.dataNascimento,
    sexo: pessoasTable.sexo,
    email: pessoasTable.email,
    celular: pessoasTable.celular,
    instagram: pessoasTable.instagram,
    site: pessoasTable.site,
    profissao: pessoasTable.profissao,
    profissaoCategoria: pessoasTable.profissaoCategoria,
    enderecoRua: pessoasTable.enderecoRua,
    cidade: pessoasTable.cidade,
    estadoUf: pessoasTable.estadoUf,
    cep: pessoasTable.cep,
    servicoInteresse: pessoasTable.servicoInteresse,
    comoFicouSabendo: pessoasTable.comoFicouSabendo,
    qualAmigoParceiro: pessoasTable.qualAmigoParceiro,
    preferenciaContato: pessoasTable.preferenciaContato,
    contatoPara: pessoasTable.contatoPara,
    adicionarContato: pessoasTable.adicionarContato,
    aguaPresencial: pessoasTable.aguaPresencial,
    fogoPresencial: pessoasTable.fogoPresencial,
    workshopAgua: pessoasTable.workshopAgua,
    cacau: pessoasTable.cacau,
    ayahuasca: pessoasTable.ayahuasca,
    concerto: pessoasTable.concerto,
    zapPierre: pessoasTable.zapPierre,
    idAlunoCliente: pessoasTable.idAlunoCliente,
    turma: pessoasTable.turma,
    conectadoProposito: pessoasTable.conectadoProposito,
    buscaEspiritual: pessoasTable.buscaEspiritual,
    lugarMusicaSom: pessoasTable.lugarMusicaSom,
    participouTrabalhoSom: pessoasTable.participouTrabalhoSom,
    qualTrabalhoSom: pessoasTable.qualTrabalhoSom,
    midiaInput: pessoasTable.midiaInput,
    midiaInputOutro: pessoasTable.midiaInputOutro,
    terapeuta: pessoasTable.terapeuta,
    formacaoMusicaTerapia: pessoasTable.formacaoMusicaTerapia,
    objetivoCurso: pessoasTable.objetivoCurso,
    cursoProposito: pessoasTable.cursoProposito,
    cursoExpectativas: pessoasTable.cursoExpectativas,
    outroCurso: pessoasTable.outroCurso,
    sentidoParticipar: pessoasTable.sentidoParticipar,
    experienciaAyahuasca: pessoasTable.experienciaAyahuasca,
    psicodelicosDrogas: pessoasTable.psicodelicosDrogas,
    traumaVida: pessoasTable.traumaVida,
    ansioliticoAntidepressivos: pessoasTable.ansioliticoAntidepressivos,
    problemaSaude: pessoasTable.problemaSaude,
    psicoterapiaPsiquiatria: pessoasTable.psicoterapiaPsiquiatria,
    sensacao: pessoasTable.sensacao,
    sensacaoPerseguido: pessoasTable.sensacaoPerseguido,
    covid: pessoasTable.covid,
    comprovanteCovid: pessoasTable.comprovanteCovid,
    numeroRef: pessoasTable.numeroRef,
    dataRegistro: pessoasTable.dataRegistro,
    createdAt: pessoasTable.createdAt,
    updatedAt: pessoasTable.updatedAt,
    conversationCount: sql<number>`COALESCE(${convCountSq.count}, 0)`,
  };

  let identityFilter: SQL | undefined;
  if (celular) {
    const digits = celular.replace(/\D/g, "");
    identityFilter = ilike(pessoasTable.celularNormalizado, `%${digits}%`);
  } else if (search) {
    const pattern = `%${search}%`;
    const digits = search.replace(/\D/g, "");
    identityFilter = or(
      ilike(pessoasTable.nome, pattern),
      ilike(pessoasTable.sobrenome, pattern),
      ilike(pessoasTable.email, pattern),
      ilike(pessoasTable.cpf, pattern),
      ...(digits.length > 0 ? [ilike(pessoasTable.celularNormalizado, `%${digits}%`)] : []),
    );
  }

  if (identityFilter) conditions.push(identityFilter);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const completionColumns = [
    pessoasTable.sobrenome, pessoasTable.cpf, pessoasTable.dataNascimento, pessoasTable.sexo,
    pessoasTable.email, pessoasTable.celular, pessoasTable.instagram, pessoasTable.site,
    pessoasTable.profissao, pessoasTable.profissaoCategoria, pessoasTable.enderecoRua,
    pessoasTable.cidade, pessoasTable.estadoUf, pessoasTable.cep, pessoasTable.servicoInteresse,
    pessoasTable.comoFicouSabendo, pessoasTable.qualAmigoParceiro, pessoasTable.preferenciaContato,
    pessoasTable.contatoPara, pessoasTable.adicionarContato, pessoasTable.aguaPresencial,
    pessoasTable.fogoPresencial, pessoasTable.workshopAgua, pessoasTable.cacau,
    pessoasTable.ayahuasca, pessoasTable.concerto, pessoasTable.zapPierre,
    pessoasTable.idAlunoCliente, pessoasTable.turma, pessoasTable.conectadoProposito,
    pessoasTable.buscaEspiritual, pessoasTable.lugarMusicaSom, pessoasTable.participouTrabalhoSom,
    pessoasTable.qualTrabalhoSom, pessoasTable.midiaInput, pessoasTable.midiaInputOutro,
    pessoasTable.terapeuta, pessoasTable.formacaoMusicaTerapia, pessoasTable.objetivoCurso,
    pessoasTable.cursoProposito, pessoasTable.cursoExpectativas, pessoasTable.outroCurso,
    pessoasTable.sentidoParticipar, pessoasTable.experienciaAyahuasca,
    pessoasTable.psicodelicosDrogas, pessoasTable.traumaVida,
    pessoasTable.ansioliticoAntidepressivos, pessoasTable.problemaSaude,
    pessoasTable.psicoterapiaPsiquiatria, pessoasTable.sensacao,
    pessoasTable.sensacaoPerseguido, pessoasTable.covid, pessoasTable.comprovanteCovid,
  ];
  const completionExpression = sql<number>`(${sql.join(
    completionColumns.map(column => sql`CASE WHEN COALESCE(${column}::text, '') <> '' THEN 1 ELSE 0 END`),
    sql` + `,
  )})`;
  const sortExpressions: Record<string, SQL> = {
    nome: sql`LOWER(CONCAT(${pessoasTable.nome}, ' ', COALESCE(${pessoasTable.sobrenome}, '')))`,
    codigo: sql`LOWER(${pessoasTable.codigo})`,
    email: sql`LOWER(COALESCE(${pessoasTable.email}, ''))`,
    celular: sql`COALESCE(${pessoasTable.celularNormalizado}, '')`,
    cidade: sql`LOWER(COALESCE(${pessoasTable.cidade}, ''))`,
    profissao: sql`LOWER(COALESCE(${pessoasTable.profissao}, ''))`,
    servicoInteresse: sql`LOWER(COALESCE(${pessoasTable.servicoInteresse}, ''))`,
    comoFicouSabendo: sql`LOWER(COALESCE(${pessoasTable.comoFicouSabendo}, ''))`,
    conversationCount: sql`COALESCE(${convCountSq.count}, 0)`,
    completion: completionExpression,
    createdAt: sql`${pessoasTable.createdAt}`,
  };
  const sortExpression = sortExpressions[sort] ?? sortExpressions.nome!;
  const order = direction === "desc" ? desc(sortExpression) : asc(sortExpression);

  const pessoas = await db
    .select(selectFields)
    .from(pessoasTable)
    .leftJoin(convCountSq, eq(pessoasTable.id, convCountSq.pessoaId))
    .where(where)
    .orderBy(order, asc(pessoasTable.id))
    .limit(lim)
    .offset(off);

  if (includeTotal !== "true") {
    res.json(pessoas);
    return;
  }

  const [[filtered], [all]] = await Promise.all([
    db.select({ count: sql<number>`COUNT(*)::int` }).from(pessoasTable).where(where),
    db.select({ count: sql<number>`COUNT(*)::int` }).from(pessoasTable),
  ]);
  res.json({
    items: pessoas,
    total: filtered?.count ?? 0,
    grandTotal: all?.count ?? 0,
    limit: lim,
    offset: off,
  });
});

// Merge candidate search intentionally includes active, inactive, and archived
// records. Already-merged tombstones are excluded because they can no longer be
// a source for a new merge.
router.get("/pessoas/merge-candidates", requireAdminRole, async (req, res): Promise<void> => {
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const excludeId = Number(req.query.excludeId);
  if (search.length < 2 || !Number.isInteger(excludeId)) {
    res.status(400).json({ error: "search and excludeId are required" }); return;
  }
  const pattern = `%${search}%`;
  const digits = search.replace(/\D/g, "");
  const candidates = await db.select({
    id: pessoasTable.id,
    codigo: pessoasTable.codigo,
    ativo: pessoasTable.ativo,
    arquivadoEm: pessoasTable.arquivadoEm,
    mergedIntoPessoaId: pessoasTable.mergedIntoPessoaId,
    nome: pessoasTable.nome,
    sobrenome: pessoasTable.sobrenome,
    email: pessoasTable.email,
    celular: pessoasTable.celular,
  }).from(pessoasTable).where(and(
    isNull(pessoasTable.mergedIntoPessoaId),
    sql`${pessoasTable.id} <> ${excludeId}`,
    or(
      ilike(pessoasTable.nome, pattern),
      ilike(pessoasTable.sobrenome, pattern),
      ilike(pessoasTable.email, pattern),
      ...(digits.length > 0 ? [ilike(pessoasTable.celularNormalizado, `%${digits}%`)] : []),
    ),
  )).orderBy(asc(pessoasTable.nome), asc(pessoasTable.id)).limit(10);
  res.json(candidates);
});

// ── GET /pessoas/:id ────────────────────────────────────────────
router.get("/pessoas/:id", requireAuth, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { celularNormalizado: _skip, ...pessoaFields } = getTableColumns(pessoasTable);
  const [pessoa] = await db.select(pessoaFields).from(pessoasTable).where(eq(pessoasTable.id, id));
  if (!pessoa) { res.status(404).json({ error: "Pessoa not found" }); return; }

  const [countRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(conversations)
    .where(eq(conversations.pessoaId, id));

  const mergeRedirect = pessoa.mergedIntoPessoaId
    ? { mergedIntoPessoaId: pessoa.mergedIntoPessoaId, metadata: "merged_record" }
    : null;
  res.json({ ...pessoa, conversationCount: Number(countRow?.count ?? 0), mergeRedirect });
});

// ── Merge preview/execution and immutable notes ──────────────────
router.get("/pessoas/:id/merge-preview", requireAdminRole, async (req, res): Promise<void> => {
  const targetId = paramId(req.params.id);
  const sourceId = Number(req.query.sourceId);
  if (!Number.isInteger(targetId) || !Number.isInteger(sourceId)) {
    res.status(400).json({ error: "target id and sourceId must be integers" }); return;
  }
  try {
    res.json(await getMergePreview(targetId, sourceId));
  } catch (error) {
    if (error instanceof PessoaMergeError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "INVALID" ? 400 : 409;
      res.status(status).json({ error: error.message }); return;
    }
    throw error;
  }
});

router.post("/pessoas/:id/merge", requireAdminRole, async (req, res): Promise<void> => {
  const targetId = paramId(req.params.id);
  const parsed = MergePessoaBody.safeParse(req.body);
  if (!Number.isInteger(targetId) || !parsed.success) {
    res.status(400).json({ error: parsed.success ? "Invalid target id" : parsed.error.message }); return;
  }
  const body = parsed.data;
  try {
    const result = await executePessoaMerge(targetId, {
      sourceId: body.sourceId,
      nameFrom: body.nameFrom as MergeChoice,
      emailFrom: body.emailFrom as MergeChoice,
      phoneFrom: body.phoneFrom as MergeChoice,
      fieldChoices: body.fieldChoices as Record<string, MergeChoice> | undefined,
      reason: body.reason,
      actorUserId: (req as AuthedRequest).authedUser?.id,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof PessoaMergeError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "INVALID" ? 400 : 409;
      res.status(status).json({ error: error.message }); return;
    }
    throw error;
  }
});

router.get("/pessoas/:id/notes", requireAuth, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [pessoa] = await db.select({ id: pessoasTable.id }).from(pessoasTable).where(eq(pessoasTable.id, id)).limit(1);
  if (!pessoa) { res.status(404).json({ error: "Pessoa not found" }); return; }
  res.json(await listPessoaNotes(id));
});

// ── GET /pessoas/:id/conversations ─────────────────────────────
router.get("/pessoas/:id/conversations", requireAuth, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [pessoa] = await db.select({ id: pessoasTable.id }).from(pessoasTable).where(eq(pessoasTable.id, id)).limit(1);
  if (!pessoa) { res.status(404).json({ error: "Pessoa not found" }); return; }

  const convs = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      model: conversations.model,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(eq(conversations.pessoaId, id))
    .orderBy(sql`${conversations.createdAt} DESC`);

  res.json(convs);
});

// ── GET /pessoas/:id/servicos ───────────────────────────────────
router.get("/pessoas/:id/servicos", requireAuth, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const rows = await db.select().from(pessoaServicos).where(eq(pessoaServicos.pessoaId, id)).orderBy(pessoaServicos.createdAt);
  res.json(rows);
});

// ── POST /pessoas/:id/servicos ──────────────────────────────────
router.post("/pessoas/:id/servicos", requireAuth, rejectMergedPessoaMutation, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { servicoNome, dataInteresse, obs } = req.body as { servicoNome: string; dataInteresse?: string; obs?: string };
  if (!servicoNome?.trim()) { res.status(400).json({ error: "servicoNome is required" }); return; }
  const [row] = await db.insert(pessoaServicos).values({ pessoaId: id, servicoNome: servicoNome.trim(), dataInteresse: dataInteresse || null, obs: obs || null }).returning();
  res.status(201).json(row);
});

// ── DELETE /pessoas/:id/servicos/:sid ───────────────────────────
router.delete("/pessoas/:id/servicos/:sid", requireAuth, rejectMergedPessoaMutation, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  const sid = paramId(req.params.sid);
  if (isNaN(sid)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(pessoaServicos).where(and(eq(pessoaServicos.id, sid), eq(pessoaServicos.pessoaId, id)));
  res.status(204).send();
});

// ── PATCH /pessoas/:id/servicos/:sid ───────────────────────────
router.patch("/pessoas/:id/servicos/:sid", requireAuth, rejectMergedPessoaMutation, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  const sid = paramId(req.params.sid);
  if (isNaN(sid)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { servicoNome, dataInteresse, obs } = req.body as { servicoNome?: string; dataInteresse?: string; obs?: string };
  const update: Record<string, unknown> = {};
  if (servicoNome !== undefined) update.servicoNome = servicoNome;
  if (dataInteresse !== undefined) update.dataInteresse = dataInteresse || null;
  if (obs !== undefined) update.obs = obs || null;
  const [row] = await db.update(pessoaServicos).set(update).where(and(eq(pessoaServicos.id, sid), eq(pessoaServicos.pessoaId, id))).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

// ── GET /pessoas/:id/participacoes ─────────────────────────────
router.get("/pessoas/:id/participacoes", requireAuth, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const rows = await db.select().from(pessoaParticipacoes).where(eq(pessoaParticipacoes.pessoaId, id)).orderBy(pessoaParticipacoes.createdAt);
  res.json(rows);
});

// ── POST /pessoas/:id/participacoes ────────────────────────────
router.post("/pessoas/:id/participacoes", requireAuth, rejectMergedPessoaMutation, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { curso, data, local, valor, obs } = req.body as { curso: string; data?: string; local?: string; valor?: string; obs?: string };
  if (!curso?.trim()) { res.status(400).json({ error: "curso is required" }); return; }
  const [row] = await db.insert(pessoaParticipacoes).values({ pessoaId: id, curso: curso.trim(), data: data || null, local: local || null, valor: valor || null, obs: obs || null }).returning();
  res.status(201).json(row);
});

// ── DELETE /pessoas/:id/participacoes/:pid ─────────────────────
router.delete("/pessoas/:id/participacoes/:pid", requireAuth, rejectMergedPessoaMutation, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  const pid = paramId(req.params.pid);
  if (isNaN(pid)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(pessoaParticipacoes).where(and(eq(pessoaParticipacoes.id, pid), eq(pessoaParticipacoes.pessoaId, id)));
  res.status(204).send();
});

// ── PATCH /pessoas/:id/participacoes/:pid ──────────────────────
router.patch("/pessoas/:id/participacoes/:pid", requireAuth, rejectMergedPessoaMutation, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  const pid = paramId(req.params.pid);
  if (isNaN(pid)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { curso, data, local, valor, obs } = req.body as { curso?: string; data?: string; local?: string; valor?: string; obs?: string };
  const update: Record<string, unknown> = {};
  if (curso !== undefined) update.curso = curso;
  if (data !== undefined) update.data = data || null;
  if (local !== undefined) update.local = local || null;
  if (valor !== undefined) update.valor = valor || null;
  if (obs !== undefined) update.obs = obs || null;
  const [row] = await db.update(pessoaParticipacoes).set(update).where(and(eq(pessoaParticipacoes.id, pid), eq(pessoaParticipacoes.pessoaId, id))).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

// ── GET /pessoas/:id/instrumentos ──────────────────────────────
router.get("/pessoas/:id/instrumentos", requireAuth, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const rows = await db.select().from(pessoaInstrumentos).where(eq(pessoaInstrumentos.pessoaId, id)).orderBy(pessoaInstrumentos.createdAt);
  res.json(rows);
});

// ── POST /pessoas/:id/instrumentos ─────────────────────────────
router.post("/pessoas/:id/instrumentos", requireAuth, rejectMergedPessoaMutation, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { item, dataCompra, valor, obs } = req.body as { item: string; dataCompra?: string; valor?: string; obs?: string };
  if (!item?.trim()) { res.status(400).json({ error: "item is required" }); return; }
  const [row] = await db.insert(pessoaInstrumentos).values({ pessoaId: id, item: item.trim(), dataCompra: dataCompra || null, valor: valor || null, obs: obs || null }).returning();
  res.status(201).json(row);
});

// ── DELETE /pessoas/:id/instrumentos/:iid ──────────────────────
router.delete("/pessoas/:id/instrumentos/:iid", requireAuth, rejectMergedPessoaMutation, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  const iid = paramId(req.params.iid);
  if (isNaN(iid)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(pessoaInstrumentos).where(and(eq(pessoaInstrumentos.id, iid), eq(pessoaInstrumentos.pessoaId, id)));
  res.status(204).send();
});

// ── PATCH /pessoas/:id/instrumentos/:iid ───────────────────────
router.patch("/pessoas/:id/instrumentos/:iid", requireAuth, rejectMergedPessoaMutation, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  const iid = paramId(req.params.iid);
  if (isNaN(iid)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { item, dataCompra, valor, obs } = req.body as { item?: string; dataCompra?: string; valor?: string; obs?: string };
  const update: Record<string, unknown> = {};
  if (item !== undefined) update.item = item;
  if (dataCompra !== undefined) update.dataCompra = dataCompra || null;
  if (valor !== undefined) update.valor = valor || null;
  if (obs !== undefined) update.obs = obs || null;
  const [row] = await db.update(pessoaInstrumentos).set(update).where(and(eq(pessoaInstrumentos.id, iid), eq(pessoaInstrumentos.pessoaId, id))).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

// ── POST /pessoas ──────────────────────────────────────────────
// Criação de uma ficha pela equipe (tela de CRM). É um dado inserido por um
// humano, então passa pelo mesmo caminho de evidência "validada" da edição
// humana (registrarEdicaoHumana): cada campo rastreado recebe uma evidência
// e fica confirmado/travado contra sobrescrita futura da Sofia.
router.post("/pessoas", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreatePessoaBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const codigo = await generateCodigo();
  const origem = `humano:${(req as AuthedRequest).authedUser!.id}`;

  const pessoa = await db.transaction(async (tx) => {
    const [created] = await tx.insert(pessoasTable).values({
      ...parsed.data,
      codigo,
    }).returning();
    if (!created) return undefined;
    await registrarEdicaoHumana(created.id, parsed.data as Record<string, unknown>, origem, tx);
    return created;
  });

  if (!pessoa) { res.status(500).json({ error: "Erro ao criar pessoa" }); return; }
  res.status(201).json(pessoa);
});

// ── PATCH /pessoas/:id ─────────────────────────────────────────
// Edição feita por um humano pela tela da ficha: os campos tocados aqui geram
// evidência "validada" e ficam travados contra sobrescrita futura da Sofia.
// requireAuth verifica a identidade contra a tabela de usuários (não confia no
// header bruto) — a origem da evidência usa o id verificado no servidor.
router.patch("/pessoas/:id", requireAuth, rejectMergedPessoaMutation, async (req, res): Promise<void> => {
  const rawId = req.params.id;
  const id = parseInt(Array.isArray(rawId) ? (rawId[0] ?? "") : rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = UpdatePessoaBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const origem = `humano:${(req as AuthedRequest).authedUser!.id}`;
  const { celularNormalizado: _skip, ...returnFields } = getTableColumns(pessoasTable);

  // UPDATE oficial + evidência + confirmação na mesma transação, com lock de
  // linha: nunca deixa um UPDATE aplicado sem sua evidência correspondente, e
  // serializa contra uma tentativa concorrente da Sofia sobre a mesma pessoa.
  let pessoa: Record<string, unknown> | undefined;
  try {
    pessoa = await withPessoaLock(id, async (tx) => {
      const [updated] = await tx
        .update(pessoasTable)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(pessoasTable.id, id))
        .returning(returnFields);
      if (!updated) return undefined;
      await registrarEdicaoHumana(id, parsed.data as Record<string, unknown>, origem, tx);
      return updated;
    });
  } catch (err) {
    if (err instanceof PessoaNotFoundError) { res.status(404).json({ error: "Pessoa not found" }); return; }
    throw err;
  }

  if (!pessoa) { res.status(404).json({ error: "Pessoa not found" }); return; }
  res.json(pessoa);
});

// ── GET /pessoas/:id/evidencias ─────────────────────────────────
// Auditoria: histórico completo (append-only) de evidências gravadas sobre a
// pessoa — inclui valores sensíveis, então exige papel de administrador.
router.get("/pessoas/:id/evidencias", requireAdminRole, async (req, res): Promise<void> => {
  const rawId = req.params.id;
  const id = parseInt(Array.isArray(rawId) ? (rawId[0] ?? "") : rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const rows = await db.select().from(pessoaEvidencias)
    .where(eq(pessoaEvidencias.pessoaId, id))
    .orderBy(desc(pessoaEvidencias.createdAt));
  res.json(rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })));
});

// ── GET /pessoas/:id/campos-status ──────────────────────────────
// Para a ficha: quais campos estão confirmados por humano e se há uma
// sugestão pendente da Sofia divergente do valor oficial. Qualquer atendente
// autenticado pode ver (é o que alimenta os badges na tela da ficha).
router.get("/pessoas/:id/campos-status", requireAuth, async (req, res): Promise<void> => {
  const rawId = req.params.id;
  const id = parseInt(Array.isArray(rawId) ? (rawId[0] ?? "") : rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const status = await getStatusCampos(id);
  res.json(status);
});

// ── GET /pessoas/:id/decision-runs ──────────────────────────────
// Auditoria do motor de decisão da Sofia (Documento 14A): histórico de
// decisões relevantes (recomendação, bloqueio por elegibilidade, handoff),
// com evidências consideradas, elegibilidade avaliada e NBA escolhida.
router.get("/pessoas/:id/decision-runs", requireAdminRole, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const rows = await db.select().from(decisionRuns)
    .where(eq(decisionRuns.pessoaId, id))
    .orderBy(desc(decisionRuns.createdAt))
    .limit(100);
  res.json(rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })));
});

// ── PATCH /pessoas/:id/inativar ────────────────────────────────
router.patch("/pessoas/:id/inativar", requireAuth, rejectMergedPessoaMutation, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [pessoa] = await db
    .update(pessoasTable)
    .set({ ativo: false, updatedAt: new Date() })
    .where(and(eq(pessoasTable.id, id), isNull(pessoasTable.mergedIntoPessoaId)))
    .returning();

  if (!pessoa) { res.status(404).json({ error: "Pessoa not found" }); return; }
  res.json(pessoa);
});

// ── PATCH /pessoas/:id/reativar ────────────────────────────────
router.patch("/pessoas/:id/reativar", requireAuth, rejectMergedPessoaMutation, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [pessoa] = await db
    .update(pessoasTable)
    .set({ ativo: true, updatedAt: new Date() })
    .where(and(eq(pessoasTable.id, id), isNull(pessoasTable.mergedIntoPessoaId)))
    .returning();

  if (!pessoa) { res.status(404).json({ error: "Pessoa not found" }); return; }
  res.json(pessoa);
});

// ── PATCH /pessoas/:id/arquivar ────────────────────────────────
router.patch("/pessoas/:id/arquivar", requireAuth, rejectMergedPessoaMutation, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [pessoa] = await db
    .update(pessoasTable)
    .set({ arquivadoEm: new Date(), updatedAt: new Date() })
    .where(and(eq(pessoasTable.id, id), isNull(pessoasTable.mergedIntoPessoaId)))
    .returning();

  if (!pessoa) { res.status(404).json({ error: "Pessoa not found" }); return; }
  res.json(pessoa);
});

// Batch archive is intentionally all-or-none: validation and updates share the
// same transaction and every row is locked in id order.
router.post("/pessoas/batch/archive", requireAuth, async (req, res): Promise<void> => {
  const parsed = BatchArchivePessoasBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const numericIds = parsed.data.ids;
  if (new Set(numericIds).size !== numericIds.length) {
    res.status(400).json({ error: "ids must be unique" }); return;
  }
  try {
    const archivedCount = await db.transaction(async (tx) => {
      for (const id of [...numericIds].sort((a, b) => a - b)) {
        await tx.execute(sql`SELECT id FROM pessoas WHERE id = ${id} FOR UPDATE`);
      }
      const rows = await tx.select().from(pessoasTable).where(inArray(pessoasTable.id, numericIds));
      if (rows.length !== numericIds.length) throw new Error("One or more pessoas were not found");
      if (rows.some(row => row.mergedIntoPessoaId !== null)) throw new Error("Merged pessoas cannot be archived");
      const idsToArchive = rows.filter(row => row.arquivadoEm === null).map(row => row.id);
      if (idsToArchive.length === 0) return 0;
      const now = new Date();
      const archived = await tx.update(pessoasTable)
        .set({ arquivadoEm: now, updatedAt: now })
        .where(inArray(pessoasTable.id, idsToArchive))
        .returning();
      return archived.length;
    });
    res.json({ archivedCount, ids: numericIds });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Batch archive failed" });
  }
});

// ── PATCH /pessoas/:id/restaurar ───────────────────────────────
router.patch("/pessoas/:id/restaurar", requireAuth, rejectMergedPessoaMutation, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [pessoa] = await db
    .update(pessoasTable)
    .set({ arquivadoEm: null, updatedAt: new Date() })
    .where(and(eq(pessoasTable.id, id), isNull(pessoasTable.mergedIntoPessoaId)))
    .returning();

  if (!pessoa) { res.status(404).json({ error: "Pessoa not found" }); return; }
  res.json(pessoa);
});

// ── DELETE /pessoas/:id ─────────────────────────────────────────
router.delete("/pessoas/:id", requireAdminRole, rejectMergedPessoaMutation, async (req, res): Promise<void> => {
  const rawId = req.params.id;
  const id = parseInt(Array.isArray(rawId) ? (rawId[0] ?? "") : rawId, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [pessoa] = await db
    .select({ id: pessoasTable.id, nome: pessoasTable.nome })
    .from(pessoasTable)
    .where(eq(pessoasTable.id, id))
    .limit(1);

  if (!pessoa) { res.status(404).json({ error: "Pessoa not found" }); return; }

  // Deleting a pessoa cascades into pessoa_evidencias (ON DELETE CASCADE), but
  // that table has a DB-level append-only trigger blocking DELETE by default.
  // This is the one legitimate case where wiping a person's evidence history
  // is correct (the person record itself is gone), so the transaction opts in
  // via a session-local flag the trigger checks explicitly.
  const conversasApagadas = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.allow_evidencia_cascade_delete = 'on'`);
    await tx.delete(pessoaServicos).where(eq(pessoaServicos.pessoaId, id));
    await tx.delete(pessoaParticipacoes).where(eq(pessoaParticipacoes.pessoaId, id));
    await tx.delete(pessoaInstrumentos).where(eq(pessoaInstrumentos.pessoaId, id));
    const apagadas = await tx.delete(conversations).where(eq(conversations.pessoaId, id)).returning({ id: conversations.id });
    await tx.delete(pessoasTable).where(eq(pessoasTable.id, id));
    return apagadas;
  });

  // Os arquivos das conversas (anexos do WhatsApp) saem do armazenamento junto com a ficha. Depois do commit:
  // se o armazenamento falhar, a ficha já foi apagada e o erro vai para o log (só contagem, sem dados da pessoa).
  for (const conversa of conversasApagadas) {
    try {
      await armazenamentoDeAnexos().apagarPrefixo(prefixoDaConversa(conversa.id));
    } catch (erro) {
      logger.error({ erroTipo: (erro as { name?: string })?.name, conversationId: conversa.id }, "ficha apagada: não consegui apagar os arquivos da conversa");
    }
  }

  res.status(204).send();
});

export default router;
