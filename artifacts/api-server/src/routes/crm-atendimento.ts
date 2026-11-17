import { unlink } from "node:fs/promises";
import { Router, type IRouter, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import multer from "multer";
import { db, commercialOpportunities } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, type AuthedRequest } from "../middlewares/roleAuth";
import { crmKanbanEnabled } from "./commercial-opportunities";
import { listOpportunityFilterOptions, OpportunityRuleError, type OpportunityActor } from "../services/commercialOpportunities";
import {
  adicionarObservacao, apagarCompromisso, apagarTarefa, carregarAtendimento, criarCompromisso, criarTarefa,
  definirTarefaExecutada, editarCompromisso, editarTarefa, salvarInformacoes,
} from "../services/crmAtendimento";
import {
  assumirConversa, carregarChat, confirmarVinculoDoCartao, devolverConversaParaSofia, enviarTextoDaEquipe,
} from "../services/crmChat";
import { carregarConversaDaPessoa, conversaVinculadaDoCartao } from "../services/crmChat";
import { enviarAnexoDaEquipe } from "../services/crmChatAnexos";
import { marcarAnexosComoVistos } from "../services/anexosAcesso";
import { LIMITE_DE_ENVIO, MAIOR_LIMITE_DE_ENVIO } from "../services/anexosConteudo";
import { ArmazenamentoTemporarioDeAnexos, UploadDeAnexoRecusado, type ArquivoRecebido } from "../services/anexosUpload";
import { carregarEstadoDeContato, registrarContato } from "../services/contatoAutorizacao";
import { carregarPessoaDeContato, confirmarVinculoDaConversa } from "../services/conversaWhatsappDaPessoa";
import { enviarAbertura, previaDaAbertura } from "../services/whatsappModeloAbertura";
import {
  SaveCommercialOpportunityInformacoesBody,
  AddCommercialOpportunityNoteBody,
  CreateCommercialOpportunityTaskBody,
  UpdateCommercialOpportunityTaskBody,
  SetCommercialOpportunityTaskDoneBody,
  CreateCommercialOpportunityAppointmentBody,
  UpdateCommercialOpportunityAppointmentBody,
  RegisterCommercialOpportunityContactBody,
  SendCommercialOpportunityChatMessageBody,
  RegisterPessoaContactBody,
  LinkPessoaConversationBody,
} from "@workspace/api-zod";

// Atendimento do cartão do CRM: informações, observações, tarefas, compromissos, autorização de contato e
// conversa de WhatsApp. As rotas de conversa e de envio do modelo exigem as áreas CRM e Conversas (quem
// decide é o servidor, não o menu). O texto de erro é do domínio; o código estável vai em `code`.

const router: IRouter = Router();

// Este roteador é montado antes do dos cartões (a rota fixa /filter-options precisa vir antes de /:id); por
// isso repete a chave de emergência do CRM.
router.use("/crm/opportunities", (_req, res, next) => {
  if (!crmKanbanEnabled()) {
    res.status(404).json({ code: "CRM_KANBAN_DISABLED", error: "CRM Kanban is disabled." });
    return;
  }
  next();
});

function actor(req: AuthedRequest): OpportunityActor {
  const user = req.authedUser;
  if (!user) throw new OpportunityRuleError("Not authenticated.", "UNAUTHENTICATED", 401);
  return { kind: "HUMAN", id: user.id, role: user.role, isAdmin: user.isAdmin };
}

function numero(raw: string | string[] | undefined, campo: string): number {
  const valor = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(valor);
  if (!Number.isSafeInteger(n) || n <= 0) throw new OpportunityRuleError(`Invalid ${campo}.`);
  return n;
}

function areasDe(req: Request): readonly string[] {
  return (req as AuthedRequest).authedUser?.areas ?? [];
}

function requireCrm(req: Request, res: Response, next: NextFunction): void {
  if (!areasDe(req).includes("crm")) {
    res.status(403).json({ code: "CRM_FORBIDDEN", error: "CRM staff permission required." });
    return;
  }
  next();
}

function requireConversas(req: Request, res: Response, next: NextFunction): void {
  if (!areasDe(req).includes("conversas")) {
    res.status(403).json({ code: "CHAT_FORBIDDEN", error: "A conversa do WhatsApp exige a área Conversas." });
    return;
  }
  next();
}

/** Conversa e modelo de abertura: precisam das duas áreas ao mesmo tempo. */
function requireCrmAndConversas(req: Request, res: Response, next: NextFunction): void {
  const areas = areasDe(req);
  if (!areas.includes("crm") || !areas.includes("conversas")) {
    res.status(403).json({ code: "CHAT_FORBIDDEN", error: "A conversa do WhatsApp exige as áreas CRM e Conversas." });
    return;
  }
  next();
}

function run(handler: (req: AuthedRequest, res: Response) => Promise<void>): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req as AuthedRequest, res);
    } catch (error) {
      if (error instanceof OpportunityRuleError) {
        res.status(error.status).json({ code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
        return;
      }
      next(error);
    }
  };
}

function corpo<T>(schema: { safeParse(valor: unknown): { success: true; data: T } | { success: false; error: { message: string } } }, req: Request): T {
  const resultado = schema.safeParse(req.body);
  if (!resultado.success) throw new OpportunityRuleError(resultado.error.message, "INVALID_BODY", 422);
  return resultado.data;
}

async function pessoaDoCartao(opportunityId: number): Promise<number> {
  const [linha] = await db.select({ pessoaId: commercialOpportunities.pessoaId }).from(commercialOpportunities)
    .where(eq(commercialOpportunities.id, opportunityId)).limit(1);
  if (!linha) throw new OpportunityRuleError("Oportunidade não encontrada.", "NOT_FOUND", 404);
  return linha.pessoaId;
}

async function exigirPessoa(pessoaId: number): Promise<void> {
  if (!(await carregarPessoaDeContato(pessoaId))) throw new OpportunityRuleError("Pessoa não encontrada.", "PERSON_NOT_FOUND", 404);
}

// ── Filtros, informações, observações, tarefas, compromissos ───────────────────

router.get("/crm/opportunities/filter-options", requireAuth, requireCrm, run(async (_req, res) => {
  res.json(await listOpportunityFilterOptions());
}));

router.get("/crm/opportunities/:id/atendimento", requireAuth, requireCrm, run(async (req, res) => {
  const dados = await carregarAtendimento(numero(req.params.id, "opportunity id"));
  if (!dados) throw new OpportunityRuleError("Oportunidade não encontrada.", "NOT_FOUND", 404);
  res.json(dados);
}));

router.put("/crm/opportunities/:id/informacoes", requireAuth, requireCrm, run(async (req, res) => {
  const body = corpo(SaveCommercialOpportunityInformacoesBody, req);
  res.json(await salvarInformacoes({ opportunityId: numero(req.params.id, "opportunity id"), actor: actor(req), informacoes: body.informacoes }));
}));

router.post("/crm/opportunities/:id/notas", requireAuth, requireCrm, run(async (req, res) => {
  const body = corpo(AddCommercialOpportunityNoteBody, req);
  res.status(201).json(await adicionarObservacao({ opportunityId: numero(req.params.id, "opportunity id"), actor: actor(req), texto: body.texto }));
}));

router.post("/crm/opportunities/:id/tarefas", requireAuth, requireCrm, run(async (req, res) => {
  const body = corpo(CreateCommercialOpportunityTaskBody, req);
  res.status(201).json(await criarTarefa({ opportunityId: numero(req.params.id, "opportunity id"), actor: actor(req), texto: body.texto, prazo: body.prazo }));
}));

router.patch("/crm/opportunities/:id/tarefas/:taskId", requireAuth, requireCrm, run(async (req, res) => {
  const body = corpo(UpdateCommercialOpportunityTaskBody, req);
  res.json(await editarTarefa({
    opportunityId: numero(req.params.id, "opportunity id"), taskId: numero(req.params.taskId, "task id"),
    actor: actor(req), texto: body.texto, prazo: body.prazo,
  }));
}));

router.post("/crm/opportunities/:id/tarefas/:taskId/executada", requireAuth, requireCrm, run(async (req, res) => {
  const body = corpo(SetCommercialOpportunityTaskDoneBody, req);
  res.json(await definirTarefaExecutada({
    opportunityId: numero(req.params.id, "opportunity id"), taskId: numero(req.params.taskId, "task id"),
    actor: actor(req), executada: body.executada,
  }));
}));

router.delete("/crm/opportunities/:id/tarefas/:taskId", requireAuth, requireCrm, run(async (req, res) => {
  await apagarTarefa({ opportunityId: numero(req.params.id, "opportunity id"), taskId: numero(req.params.taskId, "task id"), actor: actor(req) });
  res.status(204).end();
}));

router.post("/crm/opportunities/:id/compromissos", requireAuth, requireCrm, run(async (req, res) => {
  const body = corpo(CreateCommercialOpportunityAppointmentBody, req);
  res.status(201).json(await criarCompromisso({
    opportunityId: numero(req.params.id, "opportunity id"), actor: actor(req),
    titulo: body.titulo, dataHora: body.dataHora, link: body.link,
  }));
}));

router.patch("/crm/opportunities/:id/compromissos/:appointmentId", requireAuth, requireCrm, run(async (req, res) => {
  const body = corpo(UpdateCommercialOpportunityAppointmentBody, req);
  res.json(await editarCompromisso({
    opportunityId: numero(req.params.id, "opportunity id"), appointmentId: numero(req.params.appointmentId, "appointment id"),
    actor: actor(req), titulo: body.titulo, dataHora: body.dataHora, link: body.link,
  }));
}));

router.delete("/crm/opportunities/:id/compromissos/:appointmentId", requireAuth, requireCrm, run(async (req, res) => {
  await apagarCompromisso({
    opportunityId: numero(req.params.id, "opportunity id"), appointmentId: numero(req.params.appointmentId, "appointment id"), actor: actor(req),
  });
  res.status(204).end();
}));

// ── Autorização de contato ─────────────────────────────────────────────────────

router.get("/crm/opportunities/:id/contato", requireAuth, requireCrm, run(async (req, res) => {
  res.json(await carregarEstadoDeContato(await pessoaDoCartao(numero(req.params.id, "opportunity id"))));
}));

router.post("/crm/opportunities/:id/contato/registros", requireAuth, requireCrm, run(async (req, res) => {
  const body = corpo(RegisterCommercialOpportunityContactBody, req);
  const opportunityId = numero(req.params.id, "opportunity id");
  const { estado } = await registrarContato({
    pessoaId: await pessoaDoCartao(opportunityId), opportunityId, actor: actor(req),
    kind: body.kind, origem: body.origem, origemTexto: body.origemTexto,
  });
  res.status(201).json(estado);
}));

// ── Conversa de WhatsApp no cartão ─────────────────────────────────────────────

router.get("/crm/opportunities/:id/chat", requireAuth, requireCrmAndConversas, run(async (req, res) => {
  res.json(await carregarChat(numero(req.params.id, "opportunity id")));
}));

router.post("/crm/opportunities/:id/chat/assumir", requireAuth, requireCrmAndConversas, run(async (req, res) => {
  res.json(await assumirConversa({ opportunityId: numero(req.params.id, "opportunity id"), actor: actor(req) }));
}));

router.post("/crm/opportunities/:id/chat/devolver", requireAuth, requireCrmAndConversas, run(async (req, res) => {
  res.json(await devolverConversaParaSofia({ opportunityId: numero(req.params.id, "opportunity id"), actor: actor(req) }));
}));

router.post("/crm/opportunities/:id/chat/vincular-conversa", requireAuth, requireCrmAndConversas, run(async (req, res) => {
  await confirmarVinculoDoCartao({ opportunityId: numero(req.params.id, "opportunity id"), actor: actor(req) });
  res.status(204).end();
}));

router.post("/crm/opportunities/:id/chat/mensagens", requireAuth, requireCrmAndConversas, run(async (req, res) => {
  const body = corpo(SendCommercialOpportunityChatMessageBody, req);
  res.status(201).json(await enviarTextoDaEquipe({ opportunityId: numero(req.params.id, "opportunity id"), actor: actor(req), texto: body.texto }));
}));

// Arquivo (imagem, vídeo, áudio ou documento) enviado pela equipe: um por mensagem. O recebimento confere o tipo
// pelo conteúdo e o limite do tipo enquanto lê; o servidor confere tudo de novo antes de guardar e enviar.
const receberArquivo = multer({
  storage: new ArmazenamentoTemporarioDeAnexos(),
  defParamCharset: "utf8",
  limits: { files: 1, fields: 4, parts: 6, fieldSize: 8 * 1024, fileSize: MAIOR_LIMITE_DE_ENVIO + 1 },
}).single("arquivo");

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function erroDoUpload(erro: unknown): OpportunityRuleError | null {
  if (erro instanceof UploadDeAnexoRecusado) {
    if (erro.motivo === "arquivo_vazio") return new OpportunityRuleError("O arquivo está vazio.", "ATTACHMENT_EMPTY", 422);
    if (erro.motivo === "tamanho_excedido") {
      return new OpportunityRuleError(
        erro.tipo ? `O arquivo passa do limite de ${megabytes(LIMITE_DE_ENVIO[erro.tipo])} MB para este tipo.` : "O arquivo é grande demais.",
        "ATTACHMENT_TOO_LARGE", 413,
      );
    }
    return new OpportunityRuleError(
      "Este tipo de arquivo não pode ser enviado pelo WhatsApp. Use imagem JPEG/PNG/WebP, vídeo MP4, áudio, PDF ou documento do Office.",
      "ATTACHMENT_TYPE_NOT_ALLOWED", 422,
    );
  }
  if (erro instanceof multer.MulterError) {
    if (erro.code === "LIMIT_FILE_SIZE") return new OpportunityRuleError("O arquivo é grande demais.", "ATTACHMENT_TOO_LARGE", 413);
    return new OpportunityRuleError("Envie um único arquivo por mensagem.", "INVALID_BODY", 422);
  }
  return null;
}

router.post("/crm/opportunities/:id/chat/anexos", requireAuth, requireCrmAndConversas, (req: Request, res: Response, next: NextFunction) => {
  receberArquivo(req, res, erro => {
    if (!erro) { next(); return; }
    const regra = erroDoUpload(erro);
    if (regra) { res.status(regra.status).json({ code: regra.code, error: regra.message }); return; }
    next(erro);
  });
}, run(async (req, res) => {
  const opportunityId = numero(req.params.id, "opportunity id");
  const arquivo = req.file as (Express.Multer.File & ArquivoRecebido) | undefined;
  if (!arquivo) throw new OpportunityRuleError("Escolha o arquivo a enviar.", "FILE_REQUIRED", 422);
  try {
    const legenda = (req.body as { legenda?: unknown } | undefined)?.legenda;
    res.status(201).json(await enviarAnexoDaEquipe({
      opportunityId, actor: actor(req),
      arquivo: { caminho: arquivo.caminho, tamanho: arquivo.tamanho, sha256: arquivo.sha256, nomeOriginal: arquivo.originalname },
      legenda,
    }));
  } finally {
    await unlink(arquivo.caminho).catch(() => undefined);
  }
}));

// A equipe abriu a conversa do cartão: os arquivos recebidos passam a vistos (some do aviso de conversas aguardando).
router.post("/crm/opportunities/:id/chat/vistos", requireAuth, requireCrmAndConversas, run(async (req, res) => {
  let conversationId: number;
  try {
    ({ conversationId } = await conversaVinculadaDoCartao(numero(req.params.id, "opportunity id")));
  } catch (erro) {
    // Sem conversa vinculada não há conteúdo à vista: nada a marcar.
    if (erro instanceof OpportunityRuleError && erro.code === "CONVERSATION_NOT_LINKED") { res.status(204).end(); return; }
    throw erro;
  }
  await marcarAnexosComoVistos(conversationId, actor(req).id as number);
  res.status(204).end();
}));

router.get("/crm/opportunities/:id/chat/modelo-abertura", requireAuth, requireCrmAndConversas, run(async (req, res) => {
  res.json(await previaDaAbertura(await pessoaDoCartao(numero(req.params.id, "opportunity id"))));
}));

router.post("/crm/opportunities/:id/chat/modelo-abertura", requireAuth, requireCrmAndConversas, run(async (req, res) => {
  const opportunityId = numero(req.params.id, "opportunity id");
  res.status(201).json(await enviarAbertura({ pessoaId: await pessoaDoCartao(opportunityId), opportunityId, actor: actor(req) }));
}));

// ── Ficha da pessoa ────────────────────────────────────────────────────────────
// Estas rotas ficam sob /pessoas: o bloqueio por área do servidor exige a área Pessoas. O modelo de
// abertura e o vínculo da conversa exigem, além disso, CRM e Conversas.

router.get("/pessoas/:id/contato", requireAuth, run(async (req, res) => {
  const pessoaId = numero(req.params.id, "pessoa id");
  await exigirPessoa(pessoaId);
  res.json(await carregarEstadoDeContato(pessoaId));
}));

router.post("/pessoas/:id/contato/registros", requireAuth, run(async (req, res) => {
  const body = corpo(RegisterPessoaContactBody, req);
  const { estado } = await registrarContato({
    pessoaId: numero(req.params.id, "pessoa id"), actor: actor(req),
    kind: body.kind, origem: body.origem, origemTexto: body.origemTexto,
  });
  res.status(201).json(estado);
}));

// Leitura da conversa inteira na ficha: a área Pessoas vem do bloqueio do servidor, e as mensagens exigem também Conversas.
router.get("/pessoas/:id/whatsapp/conversa", requireAuth, requireConversas, run(async (req, res) => {
  res.json(await carregarConversaDaPessoa(numero(req.params.id, "pessoa id")));
}));

router.get("/pessoas/:id/whatsapp/modelo-abertura", requireAuth, requireCrmAndConversas, run(async (req, res) => {
  res.json(await previaDaAbertura(numero(req.params.id, "pessoa id")));
}));

router.post("/pessoas/:id/whatsapp/modelo-abertura", requireAuth, requireCrmAndConversas, run(async (req, res) => {
  res.status(201).json(await enviarAbertura({ pessoaId: numero(req.params.id, "pessoa id"), actor: actor(req) }));
}));

router.post("/pessoas/:id/whatsapp/vincular-conversa", requireAuth, requireCrmAndConversas, run(async (req, res) => {
  const body = corpo(LinkPessoaConversationBody, req);
  await confirmarVinculoDaConversa({ pessoaId: numero(req.params.id, "pessoa id"), conversationId: body.conversationId, actor: actor(req) });
  res.status(204).end();
}));

export default router;
