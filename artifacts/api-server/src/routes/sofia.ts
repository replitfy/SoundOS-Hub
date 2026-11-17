import { listarMensagensDaConversa } from "../services/conversaMensagens";
import { conteudoParaASofia } from "../services/anexosConteudo";
import { marcarAnexosComoVistos } from "../services/anexosAcesso";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq, asc, desc, sql, inArray, and } from "drizzle-orm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import multer from "multer";
import * as XLSX from "xlsx";
import { db, pool, canalEnvios, type CanalEnvioStatus, knowledgeItemsTable, knowledgeChunksTable, promptsTable, conversations as conversationsTable, messages, pessoasTable, videosTable, videoEnvios, decisionRuns, sofiaEntityRegistry } from "@workspace/db";
import {
  CreateKnowledgeItemBody,
  DeleteKnowledgeItemParams,
  CreatePromptBody,
  ActivatePromptParams,
  UpdateCondutaConfigBody,
  SofiaChatBody,
  CreateConversationBody,
  ListConversationMessagesParams,
  CreateVideoBody,
  UpdateVideoParams,
  UpdateVideoBody,
  DeleteVideoParams,
  ListVideoEnviosQueryParams,
  ListConversationsQueryParams,
  UpdateConversationVisibilityParams,
  UpdateConversationVisibilityBody,
} from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  DEFAULT_SOFIA_MODEL_ID,
  SofiaModelUnavailableError,
  assertSofiaModelAvailable,
  isSupportedSofiaModel,
  runSofiaFinalRound,
  runSofiaToolRound,
  toProviderSofiaModel,
} from "../services/sofiaModels";
import { generateEmbeddings, generateQueryEmbedding, embeddingsAvailable } from "../lib/embeddingClient.js";
import { expandQuery } from "../lib/ragQueryExpander.js";
import { filtrarAtualizacaoSofia, withPessoaLock, PessoaNotFoundError, registrarEvidencia, type TipoEvidenciaSofia } from "../services/evidencias";
import { namesLikelySame } from "../services/identityMatching";
import { normalizeBrazilianPhone } from "../services/phone";
import { resumirConversasAguardandoEquipe } from "../services/conversasAguardandoEquipe";
import { ULTIMO_ENVIO_FALHOU } from "../services/falhasDeEnvio";
import { traduzirErroDeEnvio } from "../services/metaErros";
import { requireAuth, requireAdminRole, type AuthedRequest } from "../middlewares/roleAuth";
import { isPgUniqueViolation } from "../lib/pg-errors";
import {
  detectPreTrigger, detectPostTrigger, buildHandoffSummary,
  handoffTransitionMessage, HANDOFF_ALREADY_ACTIVE_MESSAGE,
} from "../services/handoff";
import {
  determineConduta, condutaPromptBlock, detectClosingRequest, needsHumanCommercialData, hasCommercialLeakage,
  getCondutaConfig, saveCondutaConfig, resolveSofiaMode, type Conduta,
} from "../services/conduta";
import {
  detectModuloComPrerequisito, detectTodosModulosSemAncora, resolveOfertaModulo,
  getModulosConcluidos, checkModuleEligibility, detectDeclaredModuleNonCompletion,
  recordDecisionRun, safeRecordDecisionRun, classifyDecision, deterministicBlockedMessage,
  MODULO_LABEL, type Modulo, type EligibilityCheck,
  MODULE_PREREQUISITES,
} from "../services/decisionEngine";
import {
  findMentionedPublishedProducts,
  formatPublicProductFacts,
  getPublicProductFacts,
  searchPublishedProducts,
  type CatalogProduct,
} from "../services/wixCatalog";
import {
  crawlUpcomingEvents,
  eventAbsenceErrorMessage,
  EVENT_SYNC_TAG,
  isCatalogProductFactRequest,
  isBareCatalogAvailabilityProbe,
  isPotentialCatalogProductFactRequest,
  hasCompleteEnoughEventSnapshot,
  isDirectInformationalQuestion,
  isGeneralStoreCatalogQuestion,
  planEventAbsenceConfirmation,
  GENERAL_STORE_CATALOG_ANSWER,
} from "../services/soundfulnessEvents";
import { syncOfficialEventAgenda } from "../services/officialEventAgendaSync";
import {
  getOfferInfo, getInstrumentFamilyInfo, getEventInfo, sendContentAsset, finalizeContentAsset,
  SofiaEntityUpdateSchema,
  validSourceRefs,
  containsCommercialFacts,
  hasUsableFacts,
  evaluateRegistryReadiness,
  checkCommercialGate, resolveEntityCandidates, checkFactualCommercialBoundary,
} from "../services/sofiaFacts";
import { classifySofiaIntent, requestedCommercialCapability, shouldExposeFactualTools, decidePreGenerationGovernance, factualDecisionShape, factualToolNbaCode, buildDeterministicFactualResponse, shouldReplaceCommercialLeakage, factualFastPathEnvironmentAllowed, persistFactualExchangeAfterAudit, detectFactualOfferingIntent } from "../services/sofiaRouting";
import { formatUpcomingOfferings, listUpcomingOfferings } from "../services/sofiaUpcomingOfferings";
import { interesseDoPedidoDeValor } from "../services/sofiaTools/interesse";
import { ocultarValoresEmReais } from "../services/ocultarValores";
import { isTransactionAdvancementRequest } from "../services/commercialIntent";
import { handleSimpleSofiaChat } from "../services/sofiaSimpleChat";
import { SOFIA_CONVERSATION_LOCK_NAMESPACE } from "../services/conversationLock";

// pdf-parse ships CJS only; use createRequire so Node's ESM loader doesn't try
// to resolve its (broken) ESM entry point when this bundle is externalised.
const _require = createRequire(import.meta.url);
type PdfParseResult = { text: string; numpages: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pdfParse: (buf: Buffer) => Promise<PdfParseResult> = _require("pdf-parse");

const router: IRouter = Router();
export const factualRouteTestHooks: {
  beforeDecisionRun: (() => void | Promise<void>) | null;
} = { beforeDecisionRun: null };
export const handoffRouteTestHooks: {
  beforePersistPreTrigger: (() => void | Promise<void>) | null;
} = { beforePersistPreTrigger: null };


async function lockConversationUntilResponseEnds(
  conversationId: number,
  res: Response,
): Promise<void> {
  const waitDeadline = Date.now() + 5_000;
  let responseClosed = res.destroyed;
  let released = false;
  let unlockLockedClient: (() => Promise<void>) | null = null;
  const release = async (): Promise<void> => {
    const unlock = unlockLockedClient;
    if (released || !unlock) return;
    released = true;
    unlockLockedClient = null;
    await unlock();
  };
  res.once("close", () => {
    responseClosed = true;
    void release();
  });

  while (!responseClosed && Date.now() < waitDeadline) {
    const client = await pool.connect();
    if (responseClosed) {
      client.release();
      throw new Error("response closed while waiting for conversation lock");
    }
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired",
        [SOFIA_CONVERSATION_LOCK_NAMESPACE, conversationId],
      );
      if (result.rows[0]?.acquired) {
        unlockLockedClient = async () => {
          try {
            await client.query(
              "SELECT pg_advisory_unlock($1, $2)",
              [SOFIA_CONVERSATION_LOCK_NAMESPACE, conversationId],
            );
            client.release();
          } catch {
            client.release(true);
          }
        };
        res.once("finish", () => { void release(); });
        if (responseClosed || res.destroyed) {
          await release();
          throw new Error("response closed after acquiring conversation lock");
        }
        return;
      }
      client.release();
    } catch (error) {
      if (!released && !unlockLockedClient) client.release(true);
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  throw new Error(
    responseClosed
      ? "response closed while waiting for conversation lock"
      : "timed out waiting for conversation lock",
  );
}

// ── Multer upload middleware ────────────────────────────────────
const ALLOWED_EXTENSIONS = new Set([".md", ".txt", ".pdf"]);
const ALLOWED_MIME = new Set(["text/plain", "text/markdown", "application/pdf", "application/octet-stream"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter(_req, file, cb) {
    const ext = "." + (file.originalname.split(".").pop() ?? "").toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) cb(null, true);
    else cb(new Error(`Tipo de arquivo não permitido. Use .md, .txt ou .pdf`));
  },
});

// ── Text chunking ───────────────────────────────────────────────
function chunkText(text: string, fileExt: string): { content: string; tokenCount: number }[] {
  const WORDS_PER_CHUNK = 400;
  const OVERLAP_WORDS = 50;
  const chunks: string[] = [];

  if (fileExt === ".md") {
    // Split by ## headings first, preserving heading as first line of each chunk
    const sections = text.split(/(?=^##\s)/m).filter(s => s.trim().length > 0);
    for (const section of sections) {
      // Further split long sections by paragraphs
      const paragraphs = section.split(/\n\n+/).filter(p => p.trim().length > 20);
      let current = "";
      for (const para of paragraphs) {
        if ((current + "\n\n" + para).split(/\s+/).length > WORDS_PER_CHUNK && current.trim()) {
          chunks.push(current.trim());
          current = para;
        } else {
          current = current ? current + "\n\n" + para : para;
        }
      }
      if (current.trim()) chunks.push(current.trim());
    }
  } else {
    // Split by double newlines (paragraphs), then by word count with overlap
    const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 20);
    let current = "";
    for (const para of paragraphs) {
      if ((current + " " + para).split(/\s+/).length > WORDS_PER_CHUNK && current.trim()) {
        chunks.push(current.trim());
        // Build overlap from last N words
        const words = current.split(/\s+/);
        current = words.slice(-OVERLAP_WORDS).join(" ") + "\n\n" + para;
      } else {
        current = current ? current + "\n\n" + para : para;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }

  // Fallback: if nothing was chunked, treat whole text as one chunk
  if (chunks.length === 0 && text.trim().length > 0) {
    chunks.push(text.slice(0, 8000).trim());
  }

  return chunks.map(c => ({ content: c, tokenCount: c.split(/\s+/).length }));
}

// ── Hybrid RRF search ───────────────────────────────────────────
interface SearchResult {
  knowledgeItemId: number;
  title: string;
  chunkIndex: number;
  contentPreview: string;
  score: number;
}

/**
 * Quanto de cada chunk vai para a Sofia no `tool` message.
 *
 * Já foi 200 caracteres, o que entregava o trecho cortado no meio de uma frase — a
 * Sofia respondia a partir de um fragmento e não do conteúdo recuperado.
 */
const RAG_CONTENT_MAX_CHARS = 1_500;

/** Candidatos por query antes da fusão. Fixo por ora (Doc. 14A: validar com dados reais). */
const RAG_CANDIDATES_PER_QUERY = 20;

/** Constante k do Reciprocal Rank Fusion. */
const RRF_K = 60;

/**
 * Corte de relevância para uma única query.
 *
 * Provisório — ajustar com dados reais (Doc. 14A). Com k=60, o score de um chunk no
 * posto N é 1/(60+N); em 0,015 sobram os ~6 primeiros, que é o que se quer de uma
 * busca só. O valor anterior (0,01) ficava abaixo do menor score possível
 * (1/80 ≈ 0,0125), então nenhum resultado era descartado — o filtro era decorativo.
 */
const RAG_MIN_RRF_SCORE = 0.015;

/**
 * Corte de relevância para a fusão multi-query.
 *
 * Provisório — ajustar com dados reais (Doc. 14A). É mais frouxo de propósito: aqui um
 * chunk pode valer pouco em cada query isolada e ainda ser o mais relevante somando as
 * variações. Vale registrar que, com k=60 e 20 candidatos, o menor score possível de um
 * único acerto é 1/80 ≈ 0,0125 — ou seja, hoje este limiar sozinho não descarta nada, e
 * quem corta de fato é o top-5. Ele existe para o dia em que os pesos ou o número de
 * candidatos mudarem, e para não voltarmos a comparar contra um literal solto.
 */
const RAG_MIN_MULTIQUERY_RRF_SCORE = 0.01;

/** Recorta o chunk para o tamanho entregue à Sofia. */
function recortarConteudo(content: string): string {
  return content.length > RAG_CONTENT_MAX_CHARS ? content.slice(0, RAG_CONTENT_MAX_CHARS) : content;
}

export async function searchKnowledge(query: string, userId = "default", limit = 5): Promise<SearchResult[]> {
  // Ramo vetorial: inativo hoje porque o proxy de IA do Replit não expõe o endpoint de
  // embeddings — `generateQueryEmbedding` só devolve vetor com uma OPENAI_API_KEY direta
  // configurada. O schema, o índice HNSW e esta query continuam de pé para que ativar
  // embeddings no futuro seja só popular a coluna, sem migração.
  const queryEmbedding = await generateQueryEmbedding(query);

  if (queryEmbedding) {
    // Full hybrid RRF: vector (cosine) + BM25 (tsvector)
    const embeddingStr = `[${queryEmbedding.join(",")}]`;
    const { rows } = await pool.query<{
      knowledge_item_id: number;
      title: string;
      chunk_index: number;
      content: string;
      rrf_score: number;
    }>(
      `
      WITH vector_ranked AS (
        SELECT id, knowledge_item_id, chunk_index, content,
          ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
        FROM knowledge_chunks
        WHERE user_id = $2 AND embedding IS NOT NULL
        LIMIT 20
      ),
      text_ranked AS (
        SELECT id, knowledge_item_id, chunk_index, content,
          ROW_NUMBER() OVER (
            ORDER BY ts_rank(search_vector, plainto_tsquery('portuguese', $3)) DESC
          ) AS rank
        FROM knowledge_chunks
        WHERE user_id = $2 AND search_vector @@ plainto_tsquery('portuguese', $3)
        LIMIT 20
      ),
      combined AS (
        SELECT
          COALESCE(v.id, t.id) AS id,
          COALESCE(v.knowledge_item_id, t.knowledge_item_id) AS knowledge_item_id,
          COALESCE(v.chunk_index, t.chunk_index) AS chunk_index,
          COALESCE(v.content, t.content) AS content,
          COALESCE(1.0 / (60.0 + v.rank), 0.0) + COALESCE(1.0 / (60.0 + t.rank), 0.0) AS rrf_score
        FROM vector_ranked v
        FULL OUTER JOIN text_ranked t ON v.id = t.id
      )
      SELECT c.knowledge_item_id, ki.title, c.chunk_index, c.content, c.rrf_score
      FROM combined c
      JOIN knowledge_items ki ON ki.id = c.knowledge_item_id
      WHERE c.rrf_score > $5
      ORDER BY c.rrf_score DESC
      LIMIT $4
      `,
      [embeddingStr, userId, query, limit, RAG_MIN_RRF_SCORE]
    );
    return rows.map(r => ({
      knowledgeItemId: r.knowledge_item_id,
      title: r.title,
      chunkIndex: r.chunk_index,
      contentPreview: recortarConteudo(r.content),
      score: Number(r.rrf_score),
    }));
  }

  // Sem vetores: BM25 multi-query. A pergunta é reescrita em algumas formulações
  // alternativas e cada uma roda a sua própria busca; os rankings são fundidos por RRF.
  // É isso que faz "terapia sonora" alcançar chunks que só falam em "banho de som".
  const queries = await expandQuery(query);
  if (queries.length === 0) return [];

  // Todas as variações são ranqueadas numa query só, particionadas por variação. Rodar
  // uma query por variação também funcionaria, mas ocuparia até 5 conexões do pool
  // (padrão: 10) por busca, e duas buscas simultâneas já começariam a enfileirar.
  const { rows } = await pool.query<{
    knowledge_item_id: number;
    title: string;
    chunk_index: number;
    content: string;
    rank: string;
  }>(
    `
    WITH variacoes AS (
      SELECT texto FROM unnest($1::text[]) AS texto
    ),
    ranqueados AS (
      SELECT kc.knowledge_item_id, ki.title, kc.chunk_index, kc.content,
        ROW_NUMBER() OVER (
          PARTITION BY v.texto
          ORDER BY ts_rank(kc.search_vector, plainto_tsquery('portuguese', v.texto)) DESC, kc.id
        ) AS rank
      FROM variacoes v
      JOIN knowledge_chunks kc
        ON kc.user_id = $2
       AND kc.search_vector @@ plainto_tsquery('portuguese', v.texto)
      JOIN knowledge_items ki ON ki.id = kc.knowledge_item_id
    )
    SELECT knowledge_item_id, title, chunk_index, content, rank
    FROM ranqueados
    WHERE rank <= $3
    `,
    [queries, userId, RAG_CANDIDATES_PER_QUERY]
  );

  // Fusão RRF: o mesmo chunk pode vir de várias variações, e cada aparição soma
  // 1/(k + posto). Aparecer em muitas formulações vale mais do que liderar uma só.
  const fundidos = new Map<string, SearchResult>();
  for (const r of rows) {
    // Dedupe por item + índice do chunk, e não por linha: é o par que identifica o
    // trecho na base.
    const chave = `${r.knowledge_item_id}:${r.chunk_index}`;
    const contribuicao = 1 / (RRF_K + Number(r.rank));
    const existente = fundidos.get(chave);
    if (existente) {
      existente.score += contribuicao;
    } else {
      fundidos.set(chave, {
        knowledgeItemId: r.knowledge_item_id,
        title: r.title,
        chunkIndex: r.chunk_index,
        contentPreview: recortarConteudo(r.content),
        score: contribuicao,
      });
    }
  }

  const minScore = queries.length > 1 ? RAG_MIN_MULTIQUERY_RRF_SCORE : RAG_MIN_RRF_SCORE;

  return [...fundidos.values()]
    .filter(r => r.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── Background indexing worker ──────────────────────────────────
async function indexDocument(
  itemId: number,
  buffer: Buffer,
  fileExt: string,
  fileName: string
): Promise<void> {
  try {
    // Parse text content
    let text = "";
    if (fileExt === ".pdf") {
      const parsed = await Promise.race([
        pdfParse(buffer),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("PDF parsing timeout")), 30_000)
        ),
      ]);
      text = parsed.text;
    } else {
      text = buffer.toString("utf-8");
    }

    if (!text.trim()) {
      await db.update(knowledgeItemsTable)
        .set({ indexStatus: "failed", errorMessage: "Arquivo sem conteúdo textual" })
        .where(eq(knowledgeItemsTable.id, itemId));
      return;
    }

    // Chunk the text
    const chunks = chunkText(text, fileExt);
    if (chunks.length === 0) {
      await db.update(knowledgeItemsTable)
        .set({ indexStatus: "failed", errorMessage: "Nenhum chunk gerado" })
        .where(eq(knowledgeItemsTable.id, itemId));
      return;
    }

    // Generate embeddings in batch (null when OPENAI_API_KEY not set — BM25 fallback)
    const batchTexts = chunks.map(c => c.content);
    const embeddings = await generateEmbeddings(batchTexts);

    // Insert all chunks in a single transaction
    await db.transaction(async (tx) => {
      await tx.insert(knowledgeChunksTable).values(
        chunks.map((c, i) => ({
          knowledgeItemId: itemId,
          userId: "default",
          chunkIndex: i,
          content: c.content,
          tokenCount: c.tokenCount,
          embedding: embeddings[i] ?? null,
        }))
      );

      await tx.update(knowledgeItemsTable)
        .set({ indexStatus: "indexed", chunkCount: chunks.length })
        .where(eq(knowledgeItemsTable.id, itemId));
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro desconhecido";
    await db.update(knowledgeItemsTable)
      .set({ indexStatus: "failed", errorMessage: msg })
      .where(eq(knowledgeItemsTable.id, itemId));
  }
}

// ── OpenAI tool definitions ─────────────────────────────────────
const searchKnowledgeBaseTool = {
  type: "function" as const,
  function: {
    name: "searchKnowledgeBase",
    description:
      "Busca na base de conhecimento da Soundfulness (cursos, produtos, datas, políticas). " +
      "Use sempre que a pergunta envolver informação específica da escola e da loja virtual: " +
      "produtos disponíveis, cursos e como funcionam, para que servem os instrumentos, " +
      "fundamentos e conceitos da empresa.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto da busca em português" },
      },
      required: ["query"],
    },
  },
};

const searchStoreProductsTool = {
  type: "function" as const,
  function: {
    name: "searchStoreProducts",
    description:
      "Consulta o catálogo publicado REAL da loja Wix para encontrar produtos por nome, descrição ou SKU. " +
      "Use sempre que a pessoa perguntar sobre produto, preço ou onde comprar. " +
      "Nunca invente preço, disponibilidade, SKU ou URL. Se houver mais de um resultado, peça para a pessoa esclarecer qual deseja.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Nome, SKU ou descrição do produto procurado" },
      },
      required: ["query"],
    },
  },
};

const PESSOA_UPDATABLE_FIELDS = new Set([
  "nome","sobrenome","cpf","dataNascimento","sexo","email","celular",
  "instagram","site","profissao","profissaoCategoria",
  "enderecoRua","cidade","estadoUf","cep",
  "servicoInteresse","comoFicouSabendo","qualAmigoParceiro","preferenciaContato","contatoPara","adicionarContato",
  "aguaPresencial","fogoPresencial","workshopAgua","cacau","ayahuasca","concerto","zapPierre","idAlunoCliente","turma",
  "conectadoProposito","buscaEspiritual","lugarMusicaSom","participouTrabalhoSom","qualTrabalhoSom",
  "midiaInput","midiaInputOutro","terapeuta","formacaoMusicaTerapia",
  "objetivoCurso","cursoProposito","cursoExpectativas","outroCurso","sentidoParticipar",
  "experienciaAyahuasca","psicodelicosDrogas","traumaVida","ansioliticoAntidepressivos",
  "problemaSaude","psicoterapiaPsiquiatria","sensacao","sensacaoPerseguido",
  "covid","comprovanteCovid",
  "perfilPrincipal","objetivosDeclarados","macrojornadaPrincipalId","intencaoPrincipal",
  "temperatura","estiloCognitivo","velocidadeEvolucao","preferredLanguage","consentStatus",
]);

const updatePessoaTool = {
  type: "function" as const,
  function: {
    name: "updatePessoa",
    description:
      "Atualiza campos da ficha de uma pessoa no CRM da Soundfulness. " +
      "Use quando o usuário pedir para atualizar, corrigir ou enriquecer dados de uma pessoa específica. " +
      "Inclua apenas os campos que precisam ser alterados. " +
      "Use tipoEvidencia para sinalizar a qualidade do sinal observado: " +
      "'comportamental' quando a própria pessoa descreve algo que fez, viveu ou está buscando ativamente " +
      "(ex.: 'já fiz o curso X', 'estou procurando ativamente', 'participei de uma cerimônia'); " +
      "'relacional' quando a pessoa menciona quem a indicou ou conectou a este espaço; " +
      "'inferida' (padrão) para leituras contextuais sem afirmação explícita da pessoa.",
    parameters: {
      type: "object",
      properties: {
        pessoaId: { type: "number", description: "ID numérico da pessoa a atualizar" },
        tipoEvidencia: {
          type: "string",
          enum: ["inferida", "comportamental", "relacional"],
          description:
            "Qualidade do sinal que embasa esta atualização. " +
            "'comportamental': a pessoa afirmou ou descreveu algo que fez/viveu/busca (gera nivelConfianca=media, habilita transição para conduta comercial). " +
            "'relacional': a pessoa mencionou quem a indicou (nivelConfianca=media). " +
            "'inferida': leitura contextual sem afirmação explícita (nivelConfianca=baixa, padrão). " +
            "Prefira 'comportamental' ou 'relacional' sempre que houver uma declaração clara — isso acelera a leitura de perfil.",
        },
        campos: {
          type: "object",
          description: "Campos a atualizar com seus novos valores (strings). Passe null para limpar um campo.",
          properties: {
            nome: { type: "string" }, sobrenome: { type: "string" }, cpf: { type: "string" },
            dataNascimento: { type: "string", description: "Formato YYYY-MM-DD" },
            sexo: { type: "string" }, email: { type: "string" }, celular: { type: "string" },
            instagram: { type: "string" }, site: { type: "string" },
            profissao: { type: "string" }, profissaoCategoria: { type: "string" },
            enderecoRua: { type: "string" }, cidade: { type: "string" },
            estadoUf: { type: "string" }, cep: { type: "string" },
            servicoInteresse: { type: "string" }, comoFicouSabendo: { type: "string" },
            qualAmigoParceiro: { type: "string" }, preferenciaContato: { type: "string" },
            contatoPara: { type: "string" }, adicionarContato: { type: "string" },
            aguaPresencial: { type: "string" }, fogoPresencial: { type: "string" },
            workshopAgua: { type: "string" }, cacau: { type: "string" },
            ayahuasca: { type: "string" }, concerto: { type: "string" },
            zapPierre: { type: "string" }, idAlunoCliente: { type: "string" }, turma: { type: "string" },
            conectadoProposito: { type: "string" }, buscaEspiritual: { type: "string" },
            lugarMusicaSom: { type: "string" }, participouTrabalhoSom: { type: "string" },
            qualTrabalhoSom: { type: "string" }, midiaInput: { type: "string" },
            midiaInputOutro: { type: "string" }, terapeuta: { type: "string" },
            formacaoMusicaTerapia: { type: "string" }, objetivoCurso: { type: "string" },
            cursoProposito: { type: "string" }, cursoExpectativas: { type: "string" },
            outroCurso: { type: "string" }, sentidoParticipar: { type: "string" },
            experienciaAyahuasca: { type: "string" }, psicodelicosDrogas: { type: "string" },
            traumaVida: { type: "string" }, ansioliticoAntidepressivos: { type: "string" },
            problemaSaude: { type: "string" }, psicoterapiaPsiquiatria: { type: "string" },
            sensacao: { type: "string" }, sensacaoPerseguido: { type: "string" },
            covid: { type: "string" }, comprovanteCovid: { type: "string" },
            perfilPrincipal: { type: "string", description: "Perfil cognitivo: P1 (Explorador Espiritual), P2 (Profissional de Cura), P3 (Músico em Expansão), P4 (Buscador de Bem-Estar), P5 (Líder Comunitário)" },
            objetivosDeclarados: { type: "array", items: { type: "string" }, maxItems: 3, description: "Objetivos declarados pela pessoa (até 3 itens): array de strings" },
            macrojornadaPrincipalId: { type: "string", description: "Macrojornada principal: MJ01 (Autoconhecimento), MJ02 (Cura), MJ03 (Profissionalização), MJ04 (Expansão Musical), MJ05 (Comunidade), MJ06 (Liderança)" },
            intencaoPrincipal: { type: "string", description: "Intenção principal declarada pela pessoa" },
            temperatura: { type: "string", description: "Temperatura relacional: inativo, latente, frio, morno, quente, muito_quente" },
            estiloCognitivo: { type: "string", description: "Estilo cognitivo: Estruturado, Visionário, Vivencial, Profissional" },
            velocidadeEvolucao: { type: "string", description: "Velocidade de evolução: Contemplativa, Moderada, Acelerada" },
            preferredLanguage: { type: "string", description: "Idioma preferido: pt-BR, fr, en, es" },
            consentStatus: { type: "string", description: "Status de consentimento LGPD: pendente, concedido, revogado" },
          },
          additionalProperties: false,
        },
      },
      required: ["pessoaId", "campos"],
    },
  },
};

const createPessoaTool = {
  type: "function" as const,
  function: {
    name: "createPessoa",
    description:
      "Cria uma nova ficha de pessoa no CRM da Soundfulness com os dados coletados durante a conversa. " +
      "Use quando tiver coletado ao menos o nome e o celular da pessoa. " +
      "Após criar, você receberá o ID da pessoa para poder chamar updatePessoa com mais campos.",
    parameters: {
      type: "object",
      properties: {
        nome: { type: "string", description: "Primeiro nome da pessoa" },
        sobrenome: { type: "string", description: "Sobrenome" },
        celular: { type: "string", description: "Celular com DDD, ex: +55 (11) 99999-9999" },
        email: { type: "string" },
        cidade: { type: "string" },
        estadoUf: { type: "string" },
        profissao: { type: "string" },
        comoFicouSabendo: { type: "string" },
        servicoInteresse: { type: "string" },
        instagram: { type: "string" },
      },
      required: ["nome", "celular"],
    },
  },
};

// ── Knowledge Base ─────────────────────────────────────────────
router.get("/sofia/knowledge", requireAuth, async (_req, res): Promise<void> => {
  const items = await db.select().from(knowledgeItemsTable).orderBy(desc(knowledgeItemsTable.createdAt));
  res.json(items.map(i => ({ ...i, createdAt: i.createdAt.toISOString() })));
});

router.post("/sofia/knowledge", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateKnowledgeItemBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [item] = await db.insert(knowledgeItemsTable).values({
    title: parsed.data.title,
    type: parsed.data.type,
    sourceUrl: parsed.data.sourceUrl ?? null,
    tags: parsed.data.tags ?? "",
    indexStatus: "indexed",
  }).returning();

  res.status(201).json({ ...item, createdAt: item.createdAt.toISOString() });
});

// File upload with async indexing
router.post(
  "/sofia/knowledge/upload",
  requireAuth,
  (req: Request, res: Response, next: NextFunction) => {
    upload.single("file")(req, res, (err) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "Arquivo muito grande. Máximo 20 MB." });
        return;
      }
      if (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Erro no upload" });
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) { res.status(400).json({ error: "Nenhum arquivo enviado" }); return; }

    const ext = "." + (file.originalname.split(".").pop() ?? "").toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      res.status(400).json({ error: "Tipo de arquivo não permitido. Use .md, .txt ou .pdf" });
      return;
    }

    // Validate content via magic bytes / encoding — guards against renamed binaries
    if (ext === ".pdf") {
      const magic = file.buffer.slice(0, 4).toString("ascii");
      if (magic !== "%PDF") {
        res.status(400).json({ error: "Arquivo não é um PDF válido" });
        return;
      }
    } else {
      // .md / .txt: must be valid UTF-8 text and not contain null bytes (binary indicator)
      if (file.buffer.includes(0x00)) {
        res.status(400).json({ error: "Arquivo não é um texto válido (bytes nulos detectados)" });
        return;
      }
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        decoder.decode(file.buffer);
      } catch {
        res.status(400).json({ error: "Arquivo não é texto UTF-8 válido" });
        return;
      }
    }

    // Compute SHA-256 for idempotency
    const hash = createHash("sha256").update(file.buffer).digest("hex");

    // Check for duplicate
    const [existing] = await db.select().from(knowledgeItemsTable)
      .where(eq(knowledgeItemsTable.contentHash, hash))
      .limit(1);

    if (existing) {
      res.status(200).json({ ...existing, createdAt: existing.createdAt.toISOString() });
      return;
    }

    const title = (req.body.title as string | undefined)?.trim()
      || file.originalname.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");

    const typeMap: Record<string, string> = { ".md": "Markdown", ".txt": "Texto", ".pdf": "PDF" };

    const [item] = await db.insert(knowledgeItemsTable).values({
      title,
      type: typeMap[ext] ?? "Documento",
      fileName: file.originalname,
      fileSize: file.size,
      contentHash: hash,
      indexStatus: "processing",
      tags: (req.body.tags as string | undefined) ?? "",
    }).returning();

    // Respond immediately
    res.status(202).json({ ...item, createdAt: item.createdAt.toISOString() });

    // Index in background (non-blocking)
    void indexDocument(item.id, file.buffer, ext, file.originalname);
  }
);

export async function syncUpcomingEventsKnowledge() {
  // All entry points (startup, interval and admin route) honor the same
  // cross-process lock. This prevents select-then-insert races even with more
  // than one API instance.
  const lockClient = await pool.connect();
  await lockClient.query("SELECT pg_advisory_lock(hashtext('soundfulness_event_sync'))");
  try {
    const crawled = await crawlUpcomingEvents();
    const syncedItems = await db.select().from(knowledgeItemsTable)
      .where(eq(knowledgeItemsTable.tags, EVENT_SYNC_TAG));
    const staleRemovalAllowed = hasCompleteEnoughEventSnapshot(
      syncedItems.length,
      crawled.discoveredUrls.length,
      crawled.failures.length,
    );
    const absencePlan = planEventAbsenceConfirmation({
      previousItems: syncedItems,
      discoveredUrls: crawled.discoveredUrls,
      snapshotComplete: staleRemovalAllowed,
      now: new Date(),
    });
    const agenda = await syncOfficialEventAgenda(
      crawled.documents,
      absencePlan.confirmedMissingSourceUrls,
    );
    const updated: Array<{ title: string; sourceUrl: string; status: "created" | "updated" | "unchanged" }> = [];

    for (const document of crawled.documents) {
    const buffer = Buffer.from(document.markdown, "utf-8");
    const hash = createHash("sha256").update(buffer).digest("hex");
    const [existing] = await db.select().from(knowledgeItemsTable)
      .where(and(
        eq(knowledgeItemsTable.sourceUrl, document.sourceUrl),
        eq(knowledgeItemsTable.tags, EVENT_SYNC_TAG),
      ))
      .limit(1);

    if (existing?.contentHash === hash && existing.indexStatus === "indexed") {
      if (existing.errorMessage !== null) {
        await db.update(knowledgeItemsTable)
          .set({ errorMessage: null })
          .where(eq(knowledgeItemsTable.id, existing.id));
      }
      updated.push({ title: document.title, sourceUrl: document.sourceUrl, status: "unchanged" });
      continue;
    }

    const chunks = chunkText(document.markdown, ".md");
    const embeddings = await generateEmbeddings(chunks.map(chunk => chunk.content));
    await db.transaction(async tx => {
      let itemId = existing?.id;
      if (existing) {
        await tx.delete(knowledgeChunksTable).where(eq(knowledgeChunksTable.knowledgeItemId, existing.id));
        await tx.update(knowledgeItemsTable).set({
          title: document.title,
          type: "Evento do site",
          contentHash: hash,
          fileName: null,
          fileSize: buffer.length,
          chunkCount: chunks.length,
          indexStatus: "indexed",
          errorMessage: null,
        }).where(eq(knowledgeItemsTable.id, existing.id));
      } else {
        const [created] = await tx.insert(knowledgeItemsTable).values({
          title: document.title,
          type: "Evento do site",
          sourceUrl: document.sourceUrl,
          tags: EVENT_SYNC_TAG,
          contentHash: hash,
          fileSize: buffer.length,
          chunkCount: chunks.length,
          indexStatus: "indexed",
        }).returning({ id: knowledgeItemsTable.id });
        itemId = created!.id;
      }
      await tx.insert(knowledgeChunksTable).values(chunks.map((chunk, index) => ({
        knowledgeItemId: itemId!,
        userId: "default",
        chunkIndex: index,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        embedding: embeddings[index] ?? null,
      })));
    });
    updated.push({
      title: document.title,
      sourceUrl: document.sourceUrl,
      status: existing ? "updated" : "created",
    });
    }

    let removed = 0;
    if (staleRemovalAllowed) {
      if (absencePlan.firstMissingIds.length > 0) {
        await db.update(knowledgeItemsTable)
          .set({ errorMessage: eventAbsenceErrorMessage(new Date()) })
          .where(inArray(knowledgeItemsTable.id, absencePlan.firstMissingIds));
      }
      if (absencePlan.confirmedMissingIds.length > 0) {
        await db.delete(knowledgeItemsTable)
          .where(inArray(knowledgeItemsTable.id, absencePlan.confirmedMissingIds));
        removed = absencePlan.confirmedMissingIds.length;
      }
    }

    return {
      source: "Soundfulness — Próximos Eventos",
      updated,
      removed,
      failures: crawled.failures,
      staleRemovalSkipped: !staleRemovalAllowed,
      agenda,
    };
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock(hashtext('soundfulness_event_sync'))")
      .catch(() => undefined);
    lockClient.release();
  }
}

router.post("/sofia/knowledge/sync-events", requireAdminRole, async (req, res): Promise<void> => {
  try {
    res.json(await syncUpcomingEventsKnowledge());
  } catch (err) {
    req.log.error({ err }, "event knowledge sync failed");
    res.status(502).json({
      error: err instanceof Error ? err.message : "Falha ao sincronizar eventos.",
    });
  }
});

// Hybrid RRF search endpoint
router.get("/sofia/knowledge/search", requireAuth, async (req, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) { res.status(400).json({ error: "Parâmetro 'q' obrigatório" }); return; }

  const results = await searchKnowledge(q);
  res.json(results);
});

router.delete("/sofia/knowledge/:id", requireAdminRole, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteKnowledgeItemParams.safeParse({ id: rawId });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const [item] = await db.delete(knowledgeItemsTable).where(eq(knowledgeItemsTable.id, params.data.id)).returning();
  if (!item) { res.status(404).json({ error: "Item not found" }); return; }
  res.sendStatus(204);
});

// ── Prompts ────────────────────────────────────────────────────
router.get("/sofia/prompts", requireAuth, async (_req, res): Promise<void> => {
  const prompts = await db.select().from(promptsTable).orderBy(promptsTable.createdAt);
  res.json(prompts.map(p => ({ ...p, createdAt: p.createdAt.toISOString() })));
});

router.post("/sofia/prompts", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreatePromptBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const requestedModel = (parsed.data as { model?: string }).model ?? DEFAULT_SOFIA_MODEL_ID;
  if (!isSupportedSofiaModel(requestedModel)) {
    res.status(400).json({ error: "Modelo da Sofia não suportado." });
    return;
  }

  const existing = await db.select({ count: eq(promptsTable.id, 0) }).from(promptsTable);
  const version = `v${existing.length + 1}.0`;

  const [prompt] = await db.insert(promptsTable).values({
    name: parsed.data.name,
    body: parsed.data.body,
    version,
    model: requestedModel,
    isActive: false,
  }).returning();

  res.status(201).json({ ...prompt, createdAt: prompt.createdAt.toISOString() });
});

router.post("/sofia/prompts/:id/activate", requireAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ActivatePromptParams.safeParse({ id: rawId });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const [candidate] = await db.select().from(promptsTable).where(eq(promptsTable.id, params.data.id)).limit(1);
  if (!candidate) { res.status(404).json({ error: "Prompt not found" }); return; }

  try {
    await assertSofiaModelAvailable(openai, candidate.model ?? DEFAULT_SOFIA_MODEL_ID);
  } catch (err) {
    if (err instanceof SofiaModelUnavailableError) {
      res.status(503).json({ code: err.code, error: err.message });
      return;
    }
    throw err;
  }

  const prompt = await db.transaction(async (tx) => {
    await tx.update(promptsTable).set({ isActive: false });
    const [activated] = await tx.update(promptsTable)
      .set({ isActive: true })
      .where(eq(promptsTable.id, params.data.id))
      .returning();
    return activated;
  });
  if (!prompt) { res.status(404).json({ error: "Prompt not found" }); return; }

  res.json({ ...prompt, createdAt: prompt.createdAt.toISOString() });
});

// ── Conduta (Documento 14/15) ─────────────────────────────────
router.get("/sofia/conduta", requireAdminRole, async (_req, res): Promise<void> => {
  const config = await getCondutaConfig();
  res.json(config);
});

router.put("/sofia/conduta", requireAdminRole, async (req, res): Promise<void> => {
  const parsed = UpdateCondutaConfigBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (parsed.data.fastPathEnabled === true) {
    if (!factualFastPathEnvironmentAllowed()) {
      res.status(403).json({ error: "fast-path factual permitido somente em homologação" });
      return;
    }
    const approved = await db.select().from(sofiaEntityRegistry).where(eq(sofiaEntityRegistry.reviewStatus, "approved"));
    const readiness = evaluateRegistryReadiness(approved);
    if (!readiness.ready) {
      res.status(409).json({ error: "fast-path não está pronto", gaps: readiness.gaps });
      return;
    }
  }

  const config = await saveCondutaConfig(parsed.data);
  res.json(config);
});

router.get("/sofia/entity-registry/readiness", requireAdminRole, async (_req, res): Promise<void> => {
  const rows = await db.select().from(sofiaEntityRegistry).where(eq(sofiaEntityRegistry.reviewStatus, "approved"));
  res.json(evaluateRegistryReadiness(rows));
});

router.get("/sofia/entity-registry", requireAdminRole, async (_req, res): Promise<void> => {
  const rows = await db.select().from(sofiaEntityRegistry);
  res.json(rows);
});

router.patch("/sofia/entity-registry/:id", requireAdminRole, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "id inválido" }); return; }
  const parsed = SofiaEntityUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const patch = parsed.data;
  const [currentEntity] = await db.select().from(sofiaEntityRegistry).where(eq(sofiaEntityRegistry.id, id)).limit(1);
  if (!currentEntity) { res.status(404).json({ error: "entidade não encontrada" }); return; }
  const resultingStatus = patch.reviewStatus ?? currentEntity.reviewStatus;
  const resultingFacts = patch.approvedFacts ?? currentEntity.approvedFacts;
  const resultingRefs = patch.sourceRefs ?? currentEntity.sourceRefs;
  if (resultingStatus === "approved" && (!hasUsableFacts(resultingFacts, currentEntity.entityType) ||
      containsCommercialFacts(resultingFacts) || !validSourceRefs(resultingRefs))) {
    res.status(400).json({ error: "aprovação exige fatos e fonte oficial vigente estruturados" }); return;
  }
  const [row] = await db.update(sofiaEntityRegistry).set({ ...patch, updatedAt: new Date() }).where(eq(sofiaEntityRegistry.id, id)).returning();
  res.json(row);
});

// ── Conversations ──────────────────────────────────────────────
router.get("/sofia/conversations", requireAuth, async (req, res): Promise<void> => {
  const query = ListConversationsQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Filtro inválido." }); return; }
  const convs = await db.select({
    id: conversationsTable.id,
    hidden: conversationsTable.hidden,
    title: conversationsTable.title,
    model: conversationsTable.model,
    createdAt: conversationsTable.createdAt,
    pessoaId: conversationsTable.pessoaId,
    status: conversationsTable.status,
    handoffReason: conversationsTable.handoffReason,
    handoffSummary: conversationsTable.handoffSummary,
    handoffTriggeredAt: conversationsTable.handoffTriggeredAt,
    handoffResolvedAt: conversationsTable.handoffResolvedAt,
    handoffResolvedBy: conversationsTable.handoffResolvedBy,
    canal: conversationsTable.canal,
    canalUsuario: conversationsTable.canalUsuario,
    // "Falhou" se a última resposta falhou ou se qualquer parte dela falhou (mesma regra do aviso do menu).
    ultimoEnvioFalhou: sql<boolean>`${ULTIMO_ENVIO_FALHOU}`,
    ultimoEnvioErro: sql<string | null>`(
      SELECT f.erro FROM canal_envios f
      WHERE f.conversation_id = conversations.id AND f.status = 'falhou'
        AND (f.message_id IS NOT DISTINCT FROM (
          SELECT message_id FROM canal_envios
          WHERE conversation_id = conversations.id
          ORDER BY created_at DESC, id DESC LIMIT 1
        ))
      ORDER BY f.created_at DESC, f.id DESC LIMIT 1
    )`,
    firstMessage: sql<string | null>`(
      SELECT NULLIF(content, '') FROM messages
      WHERE conversation_id = conversations.id AND role = 'user'
      ORDER BY created_at ASC LIMIT 1
    )`,
    primeiraMensagemEhArquivo: sql<boolean>`COALESCE((
      SELECT kind = 'anexo' FROM messages
      WHERE conversation_id = conversations.id AND role = 'user'
      ORDER BY created_at ASC LIMIT 1
    ), false)`,
    // Arquivos recebidos que a equipe ainda não viu (alimentam o aviso "arquivo novo").
    arquivosNaoVistos: sql<number>`(
      SELECT COUNT(*)::int FROM mensagem_anexos a
      WHERE a.conversation_id = conversations.id AND a.direcao = 'recebido' AND a.visto_em IS NULL
    )`,
    primeiroArquivoNaoVistoEm: sql<Date | string | null>`(
      SELECT MIN(a.created_at) FROM mensagem_anexos a
      WHERE a.conversation_id = conversations.id AND a.direcao = 'recebido' AND a.visto_em IS NULL
    )`,
    cartaoAbertoId: sql<number | null>`(
      SELECT o.id FROM commercial_opportunities o
      WHERE o.pessoa_id = conversations.pessoa_id AND o.stage <> 'CLOSED'
      ORDER BY o.id DESC LIMIT 1
    )`,
    pessoaNome: sql<string | null>`(
      SELECT TRIM(CONCAT(p.nome, ' ', COALESCE(p.sobrenome, '')))
      FROM pessoas p WHERE p.id = conversations.pessoa_id
    )`,
  }).from(conversationsTable)
    .where(query.data.includeHidden === "true" ? undefined : eq(conversationsTable.hidden, false))
    .orderBy(desc(conversationsTable.createdAt));

  res.json(convs.map(({ ultimoEnvioErro, primeiroArquivoNaoVistoEm, ...c }) => ({
    ...c,
    primeiroArquivoNaoVistoEm: primeiroArquivoNaoVistoEm ? new Date(primeiroArquivoNaoVistoEm).toISOString() : null,
    // Falhas gravadas antes de um código ganhar tradução ("Falha da Meta, código N.") são traduzidas aqui.
    ultimoEnvioErro: c.ultimoEnvioFalhou ? traduzirErroDeEnvio(ultimoEnvioErro) : null,
    createdAt: c.createdAt.toISOString(),
    handoffTriggeredAt: c.handoffTriggeredAt ? c.handoffTriggeredAt.toISOString() : null,
    handoffResolvedAt: c.handoffResolvedAt ? c.handoffResolvedAt.toISOString() : null,
  })));
});

// Declarada antes de /sofia/conversations/:id para o caminho fixo não ser lido como um id.
router.get("/sofia/conversations/awaiting-staff", requireAuth, async (_req, res): Promise<void> => {
  res.json(await resumirConversasAguardandoEquipe());
});

// ── Handoff: humano assume ou resolve uma conversa ───────────────
router.post("/sofia/conversations/:id/handoff/assume", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ListConversationMessagesParams.safeParse({ id: rawId });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const [conv] = await db.update(conversationsTable)
    .set({ status: "atendimento_humano" })
    .where(and(
      eq(conversationsTable.id, params.data.id),
      eq(conversationsTable.status, "aguardando_humano"),
    ))
    .returning();
  if (!conv) {
    const [existing] = await db.select({ id: conversationsTable.id })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, params.data.id))
      .limit(1);
    res.status(existing ? 409 : 404).json({
      error: existing
        ? "A conversa não está aguardando atendimento humano."
        : "Conversa não encontrada.",
    });
    return;
  }

  res.json({
    ...conv,
    createdAt: conv.createdAt.toISOString(),
    handoffTriggeredAt: conv.handoffTriggeredAt ? conv.handoffTriggeredAt.toISOString() : null,
    handoffResolvedAt: conv.handoffResolvedAt ? conv.handoffResolvedAt.toISOString() : null,
  });
});

router.post("/sofia/conversations/:id/handoff/resolve", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ListConversationMessagesParams.safeParse({ id: rawId });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const resolvedBy = req.authedUser?.name ?? "desconhecido";
  const [conv] = await db.update(conversationsTable)
    .set({ status: "ativa", handoffResolvedAt: new Date(), handoffResolvedBy: resolvedBy })
    .where(and(
      eq(conversationsTable.id, params.data.id),
      inArray(conversationsTable.status, ["aguardando_humano", "atendimento_humano"]),
    ))
    .returning();
  if (!conv) {
    const [existing] = await db.select({ id: conversationsTable.id })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, params.data.id))
      .limit(1);
    res.status(existing ? 409 : 404).json({
      error: existing
        ? "A conversa não possui um handoff ativo para resolver."
        : "Conversa não encontrada.",
    });
    return;
  }

  res.json({
    ...conv,
    createdAt: conv.createdAt.toISOString(),
    handoffTriggeredAt: conv.handoffTriggeredAt ? conv.handoffTriggeredAt.toISOString() : null,
    handoffResolvedAt: conv.handoffResolvedAt ? conv.handoffResolvedAt.toISOString() : null,
  });
});

router.patch("/sofia/conversations/:id/visibility", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateConversationVisibilityParams.safeParse(req.params);
  const body = UpdateConversationVisibilityBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Conversa ou visibilidade inválida." }); return;
  }
  const [updated] = await db.update(conversationsTable)
    .set({ hidden: body.data.hidden })
    .where(eq(conversationsTable.id, params.data.id))
    .returning({ id: conversationsTable.id });
  if (!updated) { res.status(404).json({ error: "Conversa não encontrada." }); return; }
  res.sendStatus(204);
});

router.get("/sofia/conversations/:id", requireAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ListConversationMessagesParams.safeParse({ id: rawId });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const [conv] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, params.data.id)).limit(1);
  if (!conv) { res.status(404).json({ error: "Conversa não encontrada." }); return; }

  res.json({
    ...conv,
    createdAt: conv.createdAt.toISOString(),
    handoffTriggeredAt: conv.handoffTriggeredAt ? conv.handoffTriggeredAt.toISOString() : null,
    handoffResolvedAt: conv.handoffResolvedAt ? conv.handoffResolvedAt.toISOString() : null,
  });
});

router.post("/sofia/conversations", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateConversationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [activePrompt] = await db.select().from(promptsTable).where(eq(promptsTable.isActive, true)).limit(1);
  const model = activePrompt?.model ?? DEFAULT_SOFIA_MODEL_ID;
  const requestedModel = parsed.data.model ?? model;
  if (!isSupportedSofiaModel(requestedModel)) {
    res.status(400).json({ error: "Modelo da Sofia não suportado." });
    return;
  }

  const [conv] = await db.insert(conversationsTable).values({
    title: parsed.data.title,
    model: requestedModel,
  }).returning();

  res.status(201).json({ ...conv, createdAt: conv.createdAt.toISOString(), firstMessage: null });
});

router.get("/sofia/conversations/:id/messages", requireAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ListConversationMessagesParams.safeParse({ id: rawId });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const msgs = await listarMensagensDaConversa(params.data.id);
  res.json(msgs.map(m => ({ ...m, createdAt: m.createdAt.toISOString() })));
});

// A equipe abriu a conversa em Conversas: os arquivos recebidos passam a vistos. Só marca quem tem a área Conversas
// (a área Chat, que só testa a Sofia, não "viu" a conversa de um cliente).
router.post("/sofia/conversations/:id/anexos/vistos", requireAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ListConversationMessagesParams.safeParse({ id: rawId });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const usuario = (req as AuthedRequest).authedUser;
  if (!usuario || !usuario.areas.includes("conversas")) {
    res.status(403).json({ code: "CHAT_FORBIDDEN", error: "Marcar arquivos como vistos exige a área Conversas." });
    return;
  }
  await marcarAnexosComoVistos(params.data.id, usuario.id);
  res.status(204).end();
});

// Teto de decisões devolvidas por conversa. Cada linha carrega um JSONB de
// evidências, então uma conversa muito longa geraria um payload enorme para o
// navegador do atendente. 200 cobre com folga qualquer conversa real.
const DECISION_RUNS_LIMIT = 200;

// Log do motor cognitivo: abre a "caixa-preta" de cada decisão tomada nesta
// conversa (evidências, elegibilidade, oferta-alvo, NBA) para auditoria.
router.get("/sofia/conversations/:id/decision-runs", requireAdminRole, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ListConversationMessagesParams.safeParse({ id: rawId });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  // Buscamos as decisões MAIS RECENTES primeiro para poder limitar o volume
  // (cada linha carrega um JSONB de evidências), e só então invertemos para
  // exibir em ordem cronológica, acompanhando o fluxo da conversa.
  const runs = await db.select().from(decisionRuns)
    .where(eq(decisionRuns.conversationId, params.data.id))
    .orderBy(desc(decisionRuns.createdAt), desc(decisionRuns.id))
    .limit(DECISION_RUNS_LIMIT);

  const conversationMessages = await db.select({
    id: messages.id,
    role: messages.role,
    content: messages.content,
    conduta: messages.conduta,
    createdAt: messages.createdAt,
  }).from(messages)
    .where(eq(messages.conversationId, params.data.id))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const messageById = new Map(conversationMessages.map(message => [message.id, message]));
  const triggerByResponseId = new Map<number, typeof conversationMessages[number]>();
  let latestUserMessage: typeof conversationMessages[number] | null = null;
  for (const message of conversationMessages) {
    if (message.role === "user") {
      latestUserMessage = message;
    } else if (message.role === "assistant" && latestUserMessage) {
      triggerByResponseId.set(message.id, latestUserMessage);
    }
  }
  const serializeMessage = (message: typeof conversationMessages[number] | undefined) =>
    message
      ? { ...message, createdAt: message.createdAt.toISOString() }
      : null;

  runs.reverse();
  res.json(runs.map(run => {
    const linkedMessage = run.messageId == null ? undefined : messageById.get(run.messageId);
    const responseMessage = linkedMessage?.role === "assistant" ? linkedMessage : undefined;
    return {
      ...run,
      triggerMessage: responseMessage
        ? serializeMessage(triggerByResponseId.get(responseMessage.id))
        : null,
      responseMessage: serializeMessage(responseMessage),
      createdAt: run.createdAt.toISOString(),
    };
  }));
});

// ── Videos (catálogo de conteúdo para recomendação) ─────────────
router.get("/sofia/videos", requireAuth, async (_req, res): Promise<void> => {
  const videos = await db.select().from(videosTable).orderBy(asc(videosTable.curso), asc(videosTable.ref));
  res.json(videos.map(v => ({ ...v, createdAt: v.createdAt.toISOString() })));
});

router.get("/sofia/videos/envios", requireAuth, async (req, res): Promise<void> => {
  const query = ListVideoEnviosQueryParams.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.message }); return; }

  const conditions = [];
  if (query.data.videoId !== undefined) conditions.push(eq(videoEnvios.videoId, query.data.videoId));
  if (query.data.pessoaId !== undefined) conditions.push(eq(videoEnvios.pessoaId, query.data.pessoaId));

  const rows = await db.select({
    id: videoEnvios.id,
    conversationId: videoEnvios.conversationId,
    messageId: videoEnvios.messageId,
    pessoaId: videoEnvios.pessoaId,
    pessoaNome: pessoasTable.nome,
    videoId: videoEnvios.videoId,
    codigo: videoEnvios.codigo,
    titulo: videoEnvios.titulo,
    link: videoEnvios.link,
    curso: videoEnvios.curso,
    tipo: videoEnvios.tipo,
    createdAt: videoEnvios.createdAt,
  })
    .from(videoEnvios)
    .leftJoin(pessoasTable, eq(videoEnvios.pessoaId, pessoasTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(videoEnvios.createdAt))
    .limit(query.data.limit);

  res.json(rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })));
});

// Código nunca pode ficar em branco: quando o vídeo é criado/editado sem um
// código explícito, geramos um estável a partir do id (único por construção,
// já que id é serial). Usado tanto no CRUD manual quanto no backfill dos
// vídeos antigos importados antes deste campo existir.
function generateVideoCodigo(id: number): string {
  return `VID-${String(id).padStart(4, "0")}`;
}

router.post("/sofia/videos", requireAuth, async (req, res): Promise<void> => {
  const body = CreateVideoBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  if (!body.data.titulo.trim()) { res.status(400).json({ error: "Título é obrigatório." }); return; }

  const link = body.data.link?.trim() || null;
  const codigoInformado = body.data.codigo?.trim() || null;

  try {
    const [created] = await db.insert(videosTable).values({
      codigo: codigoInformado,
      titulo: body.data.titulo.trim(),
      descricao: body.data.descricao?.trim() || null,
      tipo: body.data.tipo?.trim() || null,
      curso: body.data.curso?.trim() || null,
      duracao: body.data.duracao?.trim() || null,
      link,
      temLinkReal: link ? hasRealLink(link) : false,
    }).returning();

    let video = created;
    if (!video.codigo) {
      [video] = await db.update(videosTable)
        .set({ codigo: generateVideoCodigo(video.id) })
        .where(eq(videosTable.id, video.id))
        .returning();
    }

    res.status(201).json({ ...video, createdAt: video.createdAt.toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("unique") || message.includes("duplicate")) {
      res.status(400).json({ error: "Já existe um vídeo com esse código." });
      return;
    }
    throw err;
  }
});

// ── Import de planilha do catálogo de vídeos ────────────────────
const VIDEO_IMPORT_EXTENSIONS = new Set([".xlsx", ".xls", ".csv"]);
const videoImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter(_req, file, cb) {
    const ext = "." + (file.originalname.split(".").pop() ?? "").toLowerCase();
    if (VIDEO_IMPORT_EXTENSIONS.has(ext)) cb(null, true);
    else cb(new Error("Tipo de arquivo não permitido. Use .xlsx ou .csv"));
  },
});

const VIDEO_TEMPLATE_HEADERS = ["codigo", "titulo", "descricao", "url", "curso", "tipo", "duracao"] as const;
const VIDEO_TEMPLATE_EXAMPLE_ROW = [
  "TK-01",
  "TaKeTiNa Roda - Sem Fala",
  "Vídeo curto mostrando a roda do TaKeTiNa sem fala, usado como prova social no funil.",
  "https://youtu.be/D4tlejPHKdc",
  "TaKeTiNa",
  "Video SFS",
  "2:42",
];

router.get("/sofia/videos/template", requireAuth, async (_req, res): Promise<void> => {
  const worksheet = XLSX.utils.aoa_to_sheet([[...VIDEO_TEMPLATE_HEADERS], VIDEO_TEMPLATE_EXAMPLE_ROW]);
  worksheet["!cols"] = [{ wch: 14 }, { wch: 32 }, { wch: 48 }, { wch: 40 }, { wch: 16 }, { wch: 16 }, { wch: 10 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Catálogo de Vídeos");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=modelo-catalogo-videos.xlsx");
  res.send(buffer);
});

function normalizeHeader(h: unknown): string {
  return String(h ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

// Aceita variações comuns de nome de coluna vindas da planilha original
// (Documento 12) ou de um export manual, além do template oficial.
const HEADER_ALIASES: Record<string, string> = {
  codigo: "codigo",
  "código": "codigo",
  ref: "codigo",
  titulo: "titulo",
  "título": "titulo",
  materiais: "titulo",
  nome: "titulo",
  descricao: "descricao",
  "descrição": "descricao",
  url: "url",
  link: "url",
  "youtube pierre": "url",
  curso: "curso",
  tipo: "tipo",
  duracao: "duracao",
  "duração": "duracao",
};

function isValidVideoUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function hasRealLink(link: string): boolean {
  return link.includes("youtube.com") || link.includes("youtu.be");
}

interface VideoImportRow {
  codigo: string;
  titulo: string;
  descricao: string | null;
  url: string;
  curso: string | null;
  tipo: string | null;
  duracao: string | null;
}

router.post(
  "/sofia/videos/import",
  requireAuth,
  (req: Request, res: Response, next: NextFunction) => {
    videoImportUpload.single("file")(req, res, (err) => {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "Arquivo muito grande. Máximo 10 MB." });
        return;
      }
      if (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Erro no upload" });
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) { res.status(400).json({ error: "Nenhum arquivo enviado" }); return; }

    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, { type: "buffer" });
    } catch {
      res.status(400).json({ error: "Não foi possível ler o arquivo. Verifique se é uma planilha .xlsx ou .csv válida." });
      return;
    }

    const sheet = workbook.Sheets[workbook.SheetNames[0]!];
    if (!sheet) { res.status(400).json({ error: "A planilha não tem nenhuma aba com dados." }); return; }

    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: null });
    if (rows.length < 2) { res.status(400).json({ error: "A planilha precisa de um cabeçalho e ao menos uma linha de dados." }); return; }

    const headerRow = rows[0]!.map(normalizeHeader);
    const colIndex: Record<string, number> = {};
    headerRow.forEach((h, i) => {
      const mapped = HEADER_ALIASES[h];
      if (mapped && !(mapped in colIndex)) colIndex[mapped] = i;
    });

    const REQUIRED_COLS = ["codigo", "titulo", "url"] as const;
    const missing = REQUIRED_COLS.filter((c) => !(c in colIndex));
    if (missing.length > 0) {
      res.status(400).json({
        error: `Colunas obrigatórias ausentes: ${missing.join(", ")}. Baixe o modelo para ver o formato esperado.`,
      });
      return;
    }

    const cell = (row: unknown[], key: string): string | null => {
      const idx = colIndex[key];
      if (idx === undefined) return null;
      const v = row[idx];
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      return s === "" ? null : s;
    };

    const valid: VideoImportRow[] = [];
    const erros: { linha: number; motivo: string }[] = [];
    const seenCodigos = new Set<string>();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]!;
      const linha = i + 1; // 1-based, header is line 1
      const codigo = cell(row, "codigo");
      const titulo = cell(row, "titulo");
      const url = cell(row, "url");
      const descricao = cell(row, "descricao");
      const curso = cell(row, "curso");
      const tipo = cell(row, "tipo");
      const duracao = cell(row, "duracao");

      if (!codigo || !titulo || !url) {
        erros.push({ linha, motivo: "Faltando código, título ou URL" });
        continue;
      }
      if (!isValidVideoUrl(url)) {
        erros.push({ linha, motivo: "URL do vídeo inválida ou incompleta" });
        continue;
      }
      if (seenCodigos.has(codigo)) {
        erros.push({ linha, motivo: `Código "${codigo}" duplicado na planilha` });
        continue;
      }
      seenCodigos.add(codigo);
      valid.push({ codigo, titulo, descricao, url, curso, tipo, duracao });
    }

    let importados = 0;
    let atualizados = 0;

    if (valid.length > 0) {
      const existing = await db.select({ codigo: videosTable.codigo }).from(videosTable);
      const existingCodigos = new Set(existing.map((v) => v.codigo).filter((c): c is string => c !== null));

      await db.transaction(async (tx) => {
        for (const v of valid) {
          const isUpdate = existingCodigos.has(v.codigo);
          const values = {
            codigo: v.codigo,
            titulo: v.titulo,
            descricao: v.descricao,
            link: v.url,
            curso: v.curso,
            tipo: v.tipo,
            duracao: v.duracao,
            temLinkReal: hasRealLink(v.url),
          };
          if (isUpdate) {
            // Preserva aprovadoParaSofia — reimportar a planilha nunca reseta
            // uma aprovação humana já concedida.
            await tx.update(videosTable).set(values).where(eq(videosTable.codigo, v.codigo));
            atualizados++;
          } else {
            await tx.insert(videosTable).values({ ...values, aprovadoParaSofia: false });
            importados++;
          }
        }
      });
    }

    res.json({ importados, atualizados, ignorados: erros.length, erros });
  },
);

router.patch("/sofia/videos/:id", requireAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateVideoParams.safeParse({ id: rawId });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const body = UpdateVideoBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [video] = await db.select().from(videosTable).where(eq(videosTable.id, params.data.id)).limit(1);
  if (!video) { res.status(404).json({ error: "Video not found" }); return; }

  if (body.data.titulo !== undefined && !body.data.titulo.trim()) {
    res.status(400).json({ error: "Título não pode ficar em branco." });
    return;
  }

  const patch: Partial<typeof videosTable.$inferInsert> = {};
  if (body.data.titulo !== undefined) patch.titulo = body.data.titulo.trim();
  if (body.data.descricao !== undefined) patch.descricao = body.data.descricao?.trim() || null;
  if (body.data.tipo !== undefined) patch.tipo = body.data.tipo?.trim() || null;
  if (body.data.curso !== undefined) patch.curso = body.data.curso?.trim() || null;
  if (body.data.duracao !== undefined) patch.duracao = body.data.duracao?.trim() || null;
  // Código nunca pode ficar em branco: um valor explicitamente vazio é
  // tratado como "não alterar" em vez de apagar o código existente.
  if (body.data.codigo !== undefined && body.data.codigo?.trim()) {
    patch.codigo = body.data.codigo.trim();
  }
  if (body.data.link !== undefined) {
    const link = body.data.link?.trim() || null;
    patch.link = link;
    patch.temLinkReal = link ? hasRealLink(link) : false;
  }

  const temLinkRealDepoisDoPatch = patch.temLinkReal ?? video.temLinkReal;
  const aprovadoParaSofia = body.data.aprovadoParaSofia ?? video.aprovadoParaSofia;
  if (aprovadoParaSofia && !temLinkRealDepoisDoPatch) {
    res.status(400).json({ error: "Não é possível aprovar um vídeo sem link real do YouTube." });
    return;
  }
  if (body.data.aprovadoParaSofia !== undefined) patch.aprovadoParaSofia = body.data.aprovadoParaSofia;

  try {
    let updated = video;
    if (Object.keys(patch).length > 0) {
      [updated] = await db.update(videosTable)
        .set(patch)
        .where(eq(videosTable.id, params.data.id))
        .returning();
    }

    if (!updated.codigo) {
      [updated] = await db.update(videosTable)
        .set({ codigo: generateVideoCodigo(updated.id) })
        .where(eq(videosTable.id, updated.id))
        .returning();
    }

    res.json({ ...updated, createdAt: updated.createdAt.toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("unique") || message.includes("duplicate")) {
      res.status(400).json({ error: "Já existe um vídeo com esse código." });
      return;
    }
    throw err;
  }
});

router.delete("/sofia/videos/:id", requireAuth, async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteVideoParams.safeParse({ id: rawId });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const [deleted] = await db.delete(videosTable).where(eq(videosTable.id, params.data.id)).returning();
  if (!deleted) { res.status(404).json({ error: "Video not found" }); return; }

  res.status(204).send();
});

// ── Video recommendation (tool used by Sofia during chat) ───────
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

interface VideoRecommendation {
  id: number;
  codigo: string | null;
  titulo: string;
  link: string;
  curso: string | null;
  tipo: string | null;
}

async function recommendVideos(signals: {
  curso?: string;
  tipoConteudo?: string;
  textoAdicional?: string;
}, options: { strictContext?: boolean } = {}): Promise<VideoRecommendation[]> {
  const approved = await db.select().from(videosTable)
    .where(eq(videosTable.aprovadoParaSofia, true));

  const eligible = approved.filter(v => v.temLinkReal && v.link);
  if (eligible.length === 0) return [];

  const cursoSignal = signals.curso?.trim() ? stripAccents(signals.curso.trim()) : null;
  const tipoSignal = signals.tipoConteudo?.trim() ? stripAccents(signals.tipoConteudo.trim()) : null;
  const textSignal = signals.textoAdicional?.trim() ? stripAccents(signals.textoAdicional.trim()) : null;

  // No signal provided at all → nothing to match against, don't guess.
  if (!cursoSignal && !tipoSignal && !textSignal) return [];

  // Generic words (from a message like "tem algum vídeo de exemplo do curso X?")
  // must not accidentally match unrelated videos via the "tipo"/"titulo" fields
  // (e.g. "vídeo" matching every "Video SFS" item). Only meaningful keywords count.
  const STOPWORDS = new Set([
    "video", "videos", "curso", "cursos", "exemplo", "exemplos", "sobre", "algum", "alguma",
    "compartilhar", "voces", "vcs", "pode", "podem", "tem", "que", "para", "com", "uma", "isso",
    "formacao", "entender", "melhor", "oficial", "quero",
    "programa", "programas", "conhecer", "entendi", "essa", "esse", "qual", "mais",
  ]);
  const latestExplicitCourseIndex = textSignal
    ? Math.max(-1, ...eligible.map(video => {
        const course = video.curso ? stripAccents(video.curso) : "";
        const distinctiveWords = course.split(/\s+/)
          .filter(word => word.length > 3 && !STOPWORDS.has(word));
        return course && distinctiveWords.length > 0 ? textSignal.lastIndexOf(course) : -1;
      }))
    : -1;

  const scored = eligible.map(v => {
    const vCurso = v.curso ? stripAccents(v.curso) : "";
    const vTipo = v.tipo ? stripAccents(v.tipo) : "";
    const vTitulo = v.titulo ? stripAccents(v.titulo) : "";
    const vCodigo = v.codigo ? stripAccents(v.codigo) : "";
    let score = 0;
    let exactCodeMatch = false;
    let contextualCourseMatch = false;
    let titleWordMatches = 0;

    // Um código exato mencionado na conversa (ex.: a pessoa ou um atendente
    // citou "TK-01") identifica o vídeo sem ambiguidade — prioriza sobre
    // qualquer correspondência por texto livre.
    if (textSignal && vCodigo && textSignal.includes(vCodigo)) {
      score += 10;
      exactCodeMatch = true;
    }
    if (cursoSignal && vCurso && (vCurso.includes(cursoSignal) || cursoSignal.includes(vCurso))) score += 3;
    if (tipoSignal && vTipo && (vTipo.includes(tipoSignal) || tipoSignal.includes(vTipo))) score += 2;
    if (textSignal) {
      const words = textSignal.split(/\s+/).filter(w => w.length > 3 && !STOPWORDS.has(w));
      const distinctiveCourseWords = vCurso.split(/\s+/)
        .filter(w => w.length > 3 && !STOPWORDS.has(w));
      if (distinctiveCourseWords.length > 0 && textSignal.includes(vCurso)) {
        score += 3;
        contextualCourseMatch = true;
      }
      for (const word of words) {
        if (vTitulo.includes(word)) {
          score += 1;
          titleWordMatches += 1;
        }
      }
    }
    const contextQualified = exactCodeMatch || contextualCourseMatch || titleWordMatches >= 2;
    const matchesLatestExplicitCourse = latestExplicitCourseIndex < 0 ||
      Boolean(vCurso && textSignal?.lastIndexOf(vCurso) === latestExplicitCourseIndex);
    return { v, score, contextQualified, matchesLatestExplicitCourse };
  });

  scored.sort((a, b) => b.score - a.score);
  const withMatch = scored.filter(s =>
    s.score > 0 &&
    (!options.strictContext || (s.contextQualified && s.matchesLatestExplicitCourse))
  );

  const uniqueRecommendations: VideoRecommendation[] = [];
  const seenLinks = new Set<string>();
  for (const { v } of withMatch) {
    if (!v.link || seenLinks.has(v.link)) continue;
    seenLinks.add(v.link);
    uniqueRecommendations.push({
      id: v.id,
      codigo: v.codigo,
      titulo: v.titulo,
      link: v.link,
      curso: v.curso,
      tipo: v.tipo,
    });
    if (uniqueRecommendations.length === 2) break;
  }
  return uniqueRecommendations;
}

function isExplicitVideoRecommendationRequest(message: string): boolean {
  const text = stripAccents(message);
  return /\bvideos?\b/.test(text) &&
    (/\b(tem|teria|ha|existe|algum|alguma|quero|gostaria|procuro|manda|mande|mandar|envia|envie|enviar|mostra|mostre|mostrar|indica|indique|indicar|compartilha|compartilhe|compartilhar|assistir|ver|entender|conhecer|exemplo)\b/.test(text)
      || /\bvideos?(?:\s+\w+){0,3}\s+(?:de|do|da|dos|das|sobre|para)\s+\S+/.test(text));
}

function videoRecommendationContext(
  currentMessage: string,
  history: Array<{ role: string; content: string }>,
): string {
  const normalized = stripAccents(currentMessage);
  const namedTopic = normalized.match(
    /\bvideos?(?:\s+\w+){0,3}\s+(?:de|do|da|dos|das|sobre|para)\s+(.+)$/,
  )?.[1]?.trim();
  if (namedTopic && !/^(?:(?:esse|essa|este|esta|o|a)\s+)?(?:curso|formacao|programa|modulo|tema)\b|^(?:(?:eu|me|nos)\s+)?(?:entender|conhecer|ver|assistir)\b/.test(namedTopic)) {
    // An explicit topic in the current request is authoritative. Pulling old
    // assistant prose into this lookup can resurrect a module gate or a stale
    // catalog topic from an earlier turn.
    return currentMessage;
  }
  return [...history.slice(-8).map(message => message.content), currentMessage].join("\n");
}

function latestVideoRequestModule(
  currentMessage: string,
  history: Array<{ role: string; content: string }>,
): Modulo | null {
  for (const text of [currentMessage, ...[...history].reverse().map(message => message.content)]) {
    const modulo = resolveOfertaModulo({ outrasFontes: [text] });
    if (modulo) return modulo;
  }
  return null;
}

function priorExplicitTargetForPrerequisite(
  prerequisite: Modulo,
  history: Array<{ role: string; content: string }>,
): Modulo | null {
  for (const message of [...history].reverse()) {
    if (message.role !== "user") continue;
    const modulo = detectModuloComPrerequisito(message.content);
    if (modulo && MODULE_PREREQUISITES[modulo].includes(prerequisite)) return modulo;
  }
  return null;
}

const recommendVideosTool = {
  type: "function" as const,
  function: {
    name: "recommendVideos",
    description:
      "Busca até 2 vídeos aprovados (prova social, depoimentos, demonstrações) do catálogo da Soundfulness " +
      "para compartilhar na conversa. Use quando a pessoa demonstrar interesse em um curso/tema específico, " +
      "pedir um exemplo ou prova social, ou quando a conversa estiver próxima de uma oferta. " +
      "Só cite vídeos retornados por esta tool, exatamente com o título e link informados — nunca invente vídeos. " +
      "Se a tool não retornar nada, não mencione vídeo nenhum.",
    parameters: {
      type: "object",
      properties: {
        curso: { type: "string", description: "Curso/tema de interesse: Fogo, Agua, TaKeTiNa, Terra, Retiro, Cacau, etc." },
        tipoConteudo: { type: "string", description: "Tipo de conteúdo desejado, ex: Depoimentos, Video SFS, Aula" },
        textoAdicional: { type: "string", description: "Palavras-chave adicionais extraídas da mensagem atual da pessoa" },
      },
      required: [],
    },
  },
};

const factualTool = (name: string, description: string) => ({
  type: "function" as const,
  function: {
    name, description,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
});
const getOfferInfoTool = factualTool("getOfferInfo", "Retorna apenas fatos não comerciais aprovados de uma oferta.");
const getInstrumentFamilyInfoTool = factualTool("getInstrumentFamilyInfo", "Retorna fatos da família do instrumento, nunca SKU ou produto.");
const getEventInfoTool = factualTool("getEventInfo", "Retorna apenas fatos não comerciais aprovados de um evento.");
const sendContentAssetTool = factualTool("sendContentAsset", "Envia somente material editorial aprovado.");

const escalateToHumanTool = {
  type: "function" as const,
  function: {
    name: "escalateToHuman",
    description:
      "Encaminha a conversa para um humano da equipe AGORA, em vez de responder você mesma. " +
      "Use apenas em modo comercial, quando: (a) a pessoa não tem elegibilidade/pré-requisito para o que deseja " +
      "(ex.: quer uma formação avançada sem ter feito o básico), ou (b) há sinais contraditórios que você não " +
      "consegue resolver sozinha (ex.: a pessoa diz coisas incompatíveis sobre o que busca). " +
      "Não use para pedidos de preço/desconto/checkout (isso é tratado automaticamente) nem para temas sensíveis.",
    parameters: {
      type: "object",
      properties: {
        motivo: {
          type: "string",
          enum: ["elegibilidade_insuficiente", "sinais_contraditorios"],
          description: "elegibilidade_insuficiente: falta pré-requisito para o que a pessoa quer. sinais_contraditorios: informações incompatíveis na conversa.",
        },
        resumo: { type: "string", description: "Resumo em 1-2 frases do porquê está encaminhando." },
      },
      required: ["motivo", "resumo"],
    },
  },
};

/**
 * Único ponto de escrita que a Sofia usa para criar OU atualizar uma pessoa a
 * partir de um celular. Nunca grava nome/celular/qualquer campo diretamente:
 * cria (se necessário) apenas uma linha de identidade vazia (codigo + nome
 * placeholder, exigido por NOT NULL) e then passa TODOS os campos — incluindo
 * nome e celular — por `filtrarAtualizacaoSofia`, então cada um vira evidência
 * "inferida" antes de qualquer valor oficial ser escrito. Tudo roda numa única
 * transação: se a gravação de evidência falhar, a criação da linha também é
 * revertida (nunca fica uma pessoa "órfã" sem evidência para seus campos).
 */
async function upsertPessoaViaSofia(
  celular: string,
  campos: Record<string, unknown>,
): Promise<{ id: number; nome: string; codigo: string; isNew: boolean }> {
  return db.transaction(async (tx) => {
    // Mesma chave do trigger (remove o 55): "+55 11 9..." casa com "11 9..." já gravado.
    const normalizado = normalizeBrazilianPhone(celular).key;
    let pessoaId: number | undefined;
    let isNew = false;

    if (normalizado) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pessoa-phone:${normalizado}`}, 0))`);
      const found = await tx.execute(sql`SELECT id, nome FROM pessoas WHERE celular_normalizado = ${normalizado} FOR UPDATE`);
      if (found.rows.length === 1) {
        const matched = found.rows[0] as { id: number; nome: string | null };
        if (!namesLikelySame(matched.nome, campos.nome)) {
          throw new Error("O nome informado não corresponde à única ficha deste celular; solicite outro identificador.");
        }
        pessoaId = matched.id;
      }
      if (found.rows.length > 1) {
        throw new Error("Celular compartilhado por mais de uma ficha; informe um identificador adicional.");
      }
    }

    if (pessoaId === undefined) {
      // `nome` is NOT NULL: a bare identity row needs *some* value at INSERT
      // time. This placeholder is never a real name — it is recorded as an
      // explicit "sistema" evidence row (audited, origem system-owned, not a
      // guess about the person) in the same statement that writes it, so the
      // row's `nome` column is never in an un-audited state even for the
      // instant before the real evidence-gated update below overwrites it.
      const PLACEHOLDER_NOME = "(ficha em criação)";
      const MAX_CODIGO_ATTEMPTS = 5;
      for (let attempt = 0; attempt < MAX_CODIGO_ATTEMPTS; attempt++) {
        const codigo = `PS-${Math.floor(100000 + Math.random() * 900000)}`;
        try {
          const [row] = await tx.insert(pessoasTable).values({ codigo, nome: PLACEHOLDER_NOME }).returning({ id: pessoasTable.id });
          pessoaId = row!.id;
          isNew = true;
          await registrarEvidencia({
            pessoaId, campo: "nome", valor: PLACEHOLDER_NOME,
            tipoEvidencia: "inferida", origem: "sistema:placeholder-criacao", aplicada: true,
          }, tx);
          break;
        } catch (err: unknown) {
          if (isPgUniqueViolation(err, "codigo") && attempt < MAX_CODIGO_ATTEMPTS - 1) {
            continue;
          }
          throw err;
        }
      }
      if (pessoaId === undefined) throw new Error("Não foi possível gerar um código único para a nova ficha.");
    }

    const camposCompletos: Record<string, unknown> = { ...campos, celular };
    const { aplicaveis } = await filtrarAtualizacaoSofia(pessoaId, camposCompletos, tx);
    if (Object.keys(aplicaveis).length > 0) {
      await tx.update(pessoasTable).set({ ...aplicaveis, updatedAt: new Date() }).where(eq(pessoasTable.id, pessoaId));
    }

    const [pessoa] = await tx.select({ id: pessoasTable.id, nome: pessoasTable.nome, codigo: pessoasTable.codigo })
      .from(pessoasTable).where(eq(pessoasTable.id, pessoaId)).limit(1);
    return { id: pessoa!.id, nome: pessoa!.nome, codigo: pessoa!.codigo, isNew };
  });
}

// ── Chat (streaming SSE + tool calling) ────────────────────────
router.post("/sofia/chat", requireAuth, async (req, res): Promise<void> => {
  const parsed = SofiaChatBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const userMessage = parsed.data.message;
  let conversationId = parsed.data.conversationId ?? undefined;
  if (conversationId) {
    try {
      await lockConversationUntilResponseEnds(conversationId, res);
    } catch (error) {
      req.log.error({ error, conversationId }, "failed to lock Sofia conversation");
      if (!res.headersSent && !res.destroyed) {
        res.status(503).json({ error: "Conversa temporariamente indisponível. Tente novamente." });
      }
      return;
    }
  }

  const [activePrompt] = await db.select().from(promptsTable).where(eq(promptsTable.isActive, true)).limit(1);

  const systemPrompt = activePrompt?.body ?? `Você é Sofia, assistente da Soundfulness — escola brasileira de Sound Healing com sinos e tigelas tibetanas.

Você apoia a equipe interna no atendimento de leads e alunos, respondendo dúvidas sobre cursos e produtos, e enriquecendo o perfil de cada pessoa no sistema.

Durante conversas de atendimento:
— Seja acolhedora sem alongar a resposta.
— Se a pessoa fizer uma pergunta direta sobre evento, curso ou produto, responda imediatamente e somente ao que foi perguntado, de preferência em uma a três linhas.
— Em respostas factuais suficientes, não cumprimente, não mostre fonte, documento, ferramenta ou regra interna, não retome triagem e não termine com pergunta de continuidade.
— Se um dado pedido não estiver disponível, diga isso em uma frase curta e não substitua por outros detalhes.
— Diferencie informação de recomendação: explicar data, local, formato, conteúdo, preço oficial ou link não é recomendar uma oferta.
— Quando uma orientação personalizada realmente exigir contexto, faça UMA pergunta por vez.
— Não ofereça listas de opções sem necessidade — deixe a pessoa responder com as próprias palavras.
— Quando alguém compartilhar informações pessoais (nome, profissão, cidade, interesses, motivações, contato), registre discretamente e continue a conversa de forma natural.
— Nunca mencione ferramentas, processos do sistema, regras internas ou que está "salvando" dados.

Para perguntas da equipe interna: seja direta, clara e precisa. Use a base de conhecimento internamente, sem expor citações técnicas na resposta.

Responda em português brasileiro, salvo se a pessoa escrever em outro idioma — nesse caso, acompanhe o idioma dela.`;

  const model = activePrompt?.model ?? DEFAULT_SOFIA_MODEL_ID;

  // ── Pessoa upsert (best-effort) ──────────────────────────────
  // Only attempt to create/link a pessoa when a real phone number is supplied.
  // Without a real celular the unique-index deduplication cannot work: a
  // placeholder would either silently merge unrelated anonymous users into one
  // record or, if the placeholder doesn't trigger the conflict clause, produce
  // unbounded duplicates. Skipping pessoa creation is the safe default.
  // Sem nome real não existe nome padrão: placeholder ("Nathalia") criava ou
  // reconhecia fichas com identidade inventada.
  const rawNome = (typeof req.body.pessoaNome === "string" && req.body.pessoaNome.trim())
    ? req.body.pessoaNome.trim() : null;
  const rawCelular = (typeof req.body.pessoaCelular === "string" && req.body.pessoaCelular.trim())
    ? req.body.pessoaCelular.trim() : null;
  let directPessoaId = (typeof parsed.data.pessoaId === "number") ? parsed.data.pessoaId : null;

  // Data-integrity guard: once a conversation is linked to a pessoa, that link
  // is the source of truth for which record Sofia's tool calls may write
  // evidence to. Without this, a client could resume someone else's ongoing
  // conversation while passing a different `pessoaId`, causing Sofia to
  // attribute AI-inferred data (via createPessoa/updatePessoa) to an unrelated
  // person's ficha based on a conversation that was never about them. The
  // conversation's own linked pessoa always wins over a client-supplied one.
  if (parsed.data.conversationId) {
    const [existingConv] = await db.select({ pessoaId: conversationsTable.pessoaId, status: conversationsTable.status })
      .from(conversationsTable).where(eq(conversationsTable.id, parsed.data.conversationId)).limit(1);
    if (!existingConv) { res.status(404).json({ error: "Conversa não encontrada." }); return; }
    if (existingConv.pessoaId !== null) {
      if (directPessoaId !== null && directPessoaId !== existingConv.pessoaId) {
        req.log.warn({ conversationId: parsed.data.conversationId, suppliedPessoaId: directPessoaId, actualPessoaId: existingConv.pessoaId }, "ignoring mismatched pessoaId on existing conversation");
      }
      directPessoaId = existingConv.pessoaId;
    }

    // Uma conversa em handoff (aguardando humano ou já assumida) fica congelada
    // para a Sofia: ela não gera mais respostas automáticas ali até um humano
    // liberar de volta (POST .../handoff/resolve). Isso evita que a Sofia
    // continue tentando recomendar/fechar/avançar sozinha depois de sinalizar
    // que precisa de um humano.
    if (existingConv.status !== "ativa") {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      await db.insert(messages).values([
        { conversationId: parsed.data.conversationId, role: "user", content: userMessage },
      ]);
      res.write(`data: ${JSON.stringify({ content: HANDOFF_ALREADY_ACTIVE_MESSAGE })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true, conversationId: parsed.data.conversationId, handoffActive: true, handoffStatus: existingConv.status })}\n\n`);
      res.end();
      return;
    }
  }

  // ── Modo simples (feature flag resolvida a cada requisição) ──
  // Depois de validar o body, travar a conversa e checar o status; o caminho
  // legado abaixo não roda.
  if (await resolveSofiaMode() === "simple") {
    const [{ count: simpleIndexedCount }] = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text as count FROM knowledge_items WHERE index_status = 'indexed'"
    ).then(r => r.rows);
    await handleSimpleSofiaChat({
      req, res, userMessage,
      conversationId,
      directPessoaId,
      rawNome,
      rawCelular,
      activePrompt: activePrompt ? { id: activePrompt.id, body: activePrompt.body, model: activePrompt.model } : null,
      model,
      hasKnowledge: parseInt(simpleIndexedCount, 10) > 0,
      searchKnowledge: query => searchKnowledge(query),
    });
    return;
  }

  let pessoaId: number | undefined = directPessoaId ?? undefined;
  if (rawCelular !== null && !directPessoaId) {
    // Best-effort find-or-create: every field (including nome/celular on a
    // brand-new pessoa) is routed through the evidence service inside
    // upsertPessoaViaSofia, in one transaction — no official value is ever
    // written before its evidence row. Any failure here (phone race, codigo
    // collision, evidence error) just means the chat proceeds without a
    // linked pessoa rather than failing the request.
    // Sem nome real não cria nem reconhece ficha: a conversa segue anônima.
    if (rawNome === null) {
      req.log.info({ conversationId: conversationId ?? null, status: "nome_ausente" }, "sofia: identificação sem nome, conversa anônima");
    } else {
      try {
        const { id } = await upsertPessoaViaSofia(rawCelular, { nome: rawNome });
        pessoaId = id;
      } catch (err) {
        // Estado explícito: sem ficha (pessoaId indefinido) — a Sofia não recebe
        // contexto de ficha nem a instrução de registrar dados.
        pessoaId = undefined;
        req.log.warn({ err, conversationId: conversationId ?? null, status: "erro_identificacao" }, "sofia: identificação falhou, conversa anônima");
      }
    }
  }

  let isFirstExchange = false;
  if (!conversationId) {
    const title = userMessage.slice(0, 60).trim();
    const [newConv] = await db.insert(conversationsTable).values({ title, model, pessoaId }).returning();
    conversationId = newConv.id;
    isFirstExchange = true;
  } else if (pessoaId) {
    await pool.query(
      `UPDATE conversations SET pessoa_id = $1 WHERE id = $2 AND pessoa_id IS NULL`,
      [pessoaId, conversationId]
    );
  }

  const historyNewestFirst = await db.select().from(messages)
    // Mensagens da equipe (role "staff") não entram no contexto da Sofia.
    .where(and(eq(messages.conversationId, conversationId), inArray(messages.role, ["user", "assistant"])))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(50);
  const history = historyNewestFirst.reverse();

  const historyMessages: { role: "user" | "assistant"; content: string }[] = history.map(m => ({
    role: m.role as "user" | "assistant",
    // Arquivo vira só uma nota neutra: a Sofia não vê imagens, vídeos, áudios nem documentos.
    content: conteudoParaASofia(m),
  }));

  // Carrega a ficha pelo pessoaId resolvido — inclusive quando a pessoa acabou
  // de ser criada/reconhecida pelo celular (antes só carregava com directPessoaId).
  let resolvedNome = rawNome ?? "";
  let pessoaContextExtra = "";
  let intencaoPrincipal: string | null = null;
  let perfilPrincipal: string | null = null;
  let temperaturaPessoa: string | null = null;
  if (pessoaId) {
    try {
      const { rows: pessoaRows } = await pool.query<{
        nome: string; sobrenome: string | null; email: string | null;
        cidade: string | null; profissao: string | null;
        perfil_principal: string | null; temperatura: string | null;
        macrojornada_principal_id: string | null; intencao_principal: string | null;
        estilo_cognitivo: string | null; velocidade_evolucao: string | null;
        preferred_language: string | null; consent_status: string | null;
        objetivos_declarados: string[] | null; servico_interesse: string | null;
      }>(
        `SELECT nome, sobrenome, email, cidade, profissao,
                perfil_principal, temperatura, macrojornada_principal_id, intencao_principal,
                estilo_cognitivo, velocidade_evolucao, preferred_language, consent_status, objetivos_declarados,
                servico_interesse
         FROM pessoas WHERE id = $1 LIMIT 1`,
        [pessoaId]
      );
      if (pessoaRows[0]) {
        const p = pessoaRows[0];
        resolvedNome = [p.nome, p.sobrenome].filter(Boolean).join(" ");
        const details: string[] = [];
        if (p.email) details.push(`Email: ${p.email}`);
        if (p.cidade) details.push(`Cidade: ${p.cidade}`);
        if (p.profissao) details.push(`Profissão: ${p.profissao}`);
        if (p.servico_interesse) details.push(`Serviço de interesse: ${p.servico_interesse}`);
        perfilPrincipal = p.perfil_principal;
        if (p.perfil_principal) details.push(`Perfil: ${p.perfil_principal}`);
        temperaturaPessoa = p.temperatura;
        if (p.temperatura) details.push(`Temperatura: ${p.temperatura}`);
        if (p.macrojornada_principal_id) details.push(`Macrojornada: ${p.macrojornada_principal_id}`);
        intencaoPrincipal = p.intencao_principal;
        if (p.intencao_principal) details.push(`Intenção: ${p.intencao_principal}`);
        if (p.estilo_cognitivo) details.push(`Estilo cognitivo: ${p.estilo_cognitivo}`);
        if (p.velocidade_evolucao) details.push(`Velocidade: ${p.velocidade_evolucao}`);
        if (p.preferred_language) details.push(`Idioma preferido: ${p.preferred_language}`);
        if (p.consent_status) details.push(`Consentimento: ${p.consent_status}`);
        if (p.objetivos_declarados && p.objetivos_declarados.length > 0) details.push(`Objetivos: ${p.objetivos_declarados.join("; ")}`);
        if (details.length > 0) {
          pessoaContextExtra = "\n" + details.map(d => `  · ${d}`).join("\n");
        }
      }
    } catch {
      // best-effort — fall back to rawNome
    }
  }

  // Conduta ativa (Documento 14/15): triagem enquanto a Sofia ainda está
  // entendendo a pessoa, comercial a partir do momento em que há perfil,
  // intenção, temperatura favorável e confiança suficientes na ficha.
  const activeConduta: Conduta = await determineConduta({
    pessoaId: pessoaId ?? null,
    perfilPrincipal,
    intencaoPrincipal,
    temperatura: temperaturaPessoa,
  });
  const directInformationalQuestion = isDirectInformationalQuestion(userMessage);
  const declaredNonCompletion = detectDeclaredModuleNonCompletion(userMessage);
  const blockedTargetFromHistory = declaredNonCompletion
    ? priorExplicitTargetForPrerequisite(declaredNonCompletion, historyMessages)
    : null;
  const safetyPreTrigger = detectPreTrigger(
    userMessage,
    historyMessages.filter(message => message.role === "user").map(message => message.content),
  );
  const condutaConfig = await getCondutaConfig();
  const intentClassification = classifySofiaIntent(userMessage);
  const offeringIntent = detectFactualOfferingIntent(userMessage, historyMessages);
  let structuredOfferingAnswer: {
    message: string;
    result: "success" | "not_found" | "lookup_error";
    source: Record<string, unknown> | null;
    candidateSet: Array<Record<string, unknown>>;
  } | null = null;
  if (offeringIntent.factual) {
    try {
      const offeringResult = await listUpcomingOfferings({
        kind: offeringIntent.kind,
        query: offeringIntent.lookupQuery ?? userMessage,
        requireNameMatch: offeringIntent.specific === true,
        modality: offeringIntent.modality,
        location: offeringIntent.location,
      });
      let offeringMessage = formatUpcomingOfferings(offeringResult, offeringIntent.fields);
      if (offeringIntent.fields?.includes("price") && offeringResult.items.length > 0) {
        // Preço de evento nunca é informado: quem pergunta recebe o link de interesse e o time abre o cartão no CRM.
        try {
          const interesse = await interesseDoPedidoDeValor({
            mensagem: offeringIntent.lookupQuery ?? userMessage,
            pessoaId: pessoaId ?? null,
            conversationId: conversationId ?? null,
            mensagensDaPessoa: [userMessage, ...historyMessages.filter(message => message.role === "user").map(message => message.content)],
          });
          if (interesse) offeringMessage = `${offeringMessage}\n\n${interesse}`;
        } catch (error) {
          req.log.warn({ error, conversationId: conversationId ?? null }, "fluxo de interesse da consulta de preço falhou");
        }
      }
      structuredOfferingAnswer = {
        message: offeringMessage,
        result: offeringResult.items.length > 0 ? "success" : "not_found",
        source: { ...offeringResult.source },
        candidateSet: offeringResult.items.map(item => ({
          eventId: item.eventId ?? null,
          classId: item.classId,
          courseId: item.courseId,
          courseName: item.courseName,
          startDate: item.startDate,
          location: item.location,
          modality: item.modality,
          requestedFields: offeringIntent.fields ?? [],
        })),
      };
    } catch (error) {
      req.log.warn({ error, offeringIntent }, "structured upcoming offering lookup failed");
      structuredOfferingAnswer = {
        message: "Não consegui consultar cursos e eventos agora. Prefiro não inventar uma data.",
        result: "lookup_error",
        source: null,
        candidateSet: [],
      };
    }
  }
  const fastPathEligible = factualFastPathEnvironmentAllowed() &&
    condutaConfig.fastPathEnabled && intentClassification.kind === "factual";
  const fastPathStartedAt = fastPathEligible ? Date.now() : null;
  const resolvedCandidates = fastPathEligible && intentClassification.factKind
    ? await resolveEntityCandidates(intentClassification.factKind, userMessage) : [];
  const resolvedEntity = resolvedCandidates.length === 1 ? resolvedCandidates[0] : null;
  const factualCommercialBoundary = resolvedEntity
    ? await checkFactualCommercialBoundary(
        resolvedEntity.entityType as "offer" | "event" | "instrument_family",
        resolvedEntity.stableKey,
      )
    : { passed: false, gates: [] };
  // decision_runs requires pessoa_id; without a linked person the request
  // stays on the advisory path rather than producing an unaudited fact.
  const deterministicFactReady = Boolean(pessoaId) &&
    resolvedEntity?.sensitive === false &&
    factualCommercialBoundary.passed &&
    shouldExposeFactualTools(condutaConfig.fastPathEnabled, resolvedCandidates.length, intentClassification);
  const commercialCapability = requestedCommercialCapability(userMessage);
  let commercialGateResult: { allowed: boolean; reason: string } | null = null;
  let commercialResolvedEntity: { sensitive?: boolean } | null = null;
  if (commercialCapability) {
    const commercialCandidates = (await Promise.all(
      (["offer", "event", "instrument_family"] as const).map(domain => resolveEntityCandidates(domain, userMessage)),
    )).flat();
    if (commercialCandidates.length === 1) {
      commercialResolvedEntity = commercialCandidates[0];
      commercialGateResult = await checkCommercialGate(
        commercialCandidates[0].entityType as "offer" | "event" | "instrument_family",
        commercialCandidates[0].stableKey,
        commercialCapability,
      );
    } else {
      commercialGateResult = { allowed: false, reason: commercialCandidates.length === 0 ? "entity_not_found" : "entity_ambiguous" };
    }
  }
  const sensitiveAdvancement = /\b(participar|inscrever|recomenda|indica|melhor para mim|condi[çc][ãa]o|fechar|comprar)\b/i.test(userMessage);
  if (!commercialResolvedEntity && sensitiveAdvancement) {
    const sensitiveCandidates = (await Promise.all(
      (["offer", "event", "instrument_family"] as const).map(domain => resolveEntityCandidates(domain, userMessage)),
    )).flat();
    if (sensitiveCandidates.length === 1) commercialResolvedEntity = sensitiveCandidates[0];
  }
  const governanceDecision = decidePreGenerationGovernance({
    commercialCapability, commercialGate: commercialGateResult,
    sensitive: Boolean((resolvedEntity ?? commercialResolvedEntity)?.sensitive), advancement: sensitiveAdvancement,
  });

  // ── Elegibilidade de módulo (pré-geração) ────────────────────────
  // Detecta se a própria mensagem da pessoa já nomeia um módulo com
  // pré-requisito conhecido (Fogo/Ar/Terra) ANTES de qualquer geração de
  // resposta. Se bloqueado, isso vira uma instrução obrigatória no prompt
  // desta rodada e já preenche o decision_run — em vez de depender só do
  // tool call recommendVideos (que a Sofia pode nunca chegar a acionar se
  // resolver tudo em texto livre).
  let pregenModuleGate: { modulo: Modulo; elegibilidade: EligibilityCheck } | null = null;
  const moduloMencionado = directInformationalQuestion || declaredNonCompletion
    ? null
    : detectModuloComPrerequisito(userMessage);
  if (moduloMencionado && pessoaId) {
    const concluidosPreGeracao = await getModulosConcluidos(pessoaId);
    const elegibilidadePreGeracao = checkModuleEligibility(moduloMencionado, concluidosPreGeracao);
    if (elegibilidadePreGeracao.status === "bloqueado") {
      pregenModuleGate = { modulo: moduloMencionado, elegibilidade: elegibilidadePreGeracao };
    }
  }

  // Append pessoa context so Sofia knows who she is talking to and can call updatePessoa
  let effectiveSystemPrompt = systemPrompt;
  if (pessoaId) {
    effectiveSystemPrompt +=
      `\n\n---\nCONTEXTO:\n` +
      `- Atendendo: ${resolvedNome} (pessoaId: ${pessoaId})${pessoaContextExtra}\n` +
      `- Registre informações compartilhadas (nome completo, email, cidade, profissão, interesses, ` +
      `perfil, objetivos, idioma) atualizando a ficha imediatamente, sem avisar que está fazendo isso.`;
  }
  effectiveSystemPrompt += await condutaPromptBlock(activeConduta, deterministicFactReady);
  if (directInformationalQuestion && deterministicFactReady && !resolvedEntity) {
    const directKnowledge = await searchKnowledge(userMessage, "default", 5);
    effectiveSystemPrompt +=
      `\n\n---\nPRIORIDADE DESTA RESPOSTA — PERGUNTA INFORMACIONAL DIRETA:\n` +
      `Responda somente ao que foi perguntado, de preferência em uma a três linhas. Não cumprimente, não cite fontes, ` +
      `documentos ou ferramentas, não faça triagem, não peça dados pessoais, não tente preencher lacunas da ficha ` +
      `e não encerre com uma pergunta de qualificação ou continuidade. ` +
      `Se faltar apenas a identificação exata do item, faça no máximo uma pergunta curta de esclarecimento. ` +
      `Preço de produto pode ser informado somente quando estiver no catálogo Wix. Preço de evento, ciclo ou curso ` +
      `nunca é informado: diga que o time interno passa valores e condições e ofereça o cadastro de interesse. ` +
      `Desconto, cupom, parcelamento, vaga e checkout continuam proibidos.`;
    if (directKnowledge.length > 0) {
      effectiveSystemPrompt += `\n\nCONTEÚDO OFICIAL RECUPERADO:\n` +
        directKnowledge.map(result =>
          `[${result.title}, chunk #${result.chunkIndex}]\n${ocultarValoresEmReais(result.contentPreview)}`,
        ).join("\n\n");
    }
  }
  effectiveSystemPrompt +=
    `\n\n---\nEXCEÇÃO AUTORIZADA — CATÁLOGO WIX: para produtos físicos publicados na loja, a tool ` +
    `searchStoreProducts é a fonte comercial oficial e atual. Você PODE informar o preço e a URL individual ` +
    `exatamente como retornados por ela. Nunca informe desconto, cupom, parcelamento ou estoque quantitativo; ` +
    `esses temas continuam exigindo atendimento humano. Se houver vários resultados, peça esclarecimento sem enviar link.`;
  effectiveSystemPrompt +=
    `\n\n---\nVÍDEOS: quando fizer sentido (interesse em curso/tema, pedido de exemplo/prova social, ` +
    `ou perto de uma oferta), use a tool recommendVideos. Cite APENAS título e link exatamente como a tool ` +
    `retornou — nunca invente vídeo, link ou título. Se a tool não retornar nada, não mencione vídeo.`;
  if (pregenModuleGate) {
    effectiveSystemPrompt +=
      `\n\n---\nREGRA OBRIGATÓRIA DE ELEGIBILIDADE (prioridade absoluta sobre qualquer outra instrução, Documento 14A): ` +
      `a pessoa mencionou o módulo "${MODULO_LABEL[pregenModuleGate.modulo]}" nesta mensagem, mas ${pregenModuleGate.elegibilidade.motivo} ` +
      `Nesta resposta você NÃO PODE recomendar, oferecer, prometer, descrever conteúdo de, nem chamar recommendVideos para ` +
      `"${MODULO_LABEL[pregenModuleGate.modulo]}" — explique com empatia que o caminho preparatório vem primeiro e pergunte sobre esse pré-requisito.`;
  }

  const chatMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: effectiveSystemPrompt },
    ...historyMessages,
    { role: "user", content: userMessage },
  ];

  // Check if knowledge base has indexed content
  const [{ count: indexedCount }] = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text as count FROM knowledge_items WHERE index_status = 'indexed'"
  ).then(r => r.rows);
  const hasKnowledge = parseInt(indexedCount, 10) > 0;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const persistAndSendStructuredFact = async (
    answer: string,
    metadata: Record<string, unknown>,
    primaryOffer: string | null,
  ) => {
    await persistFactualExchangeAfterAudit({
      persistUserMessage: async () => {
        await db.insert(messages).values({
          conversationId, role: "user", content: userMessage, conduta: activeConduta,
        });
      },
      persistDecisionRun: async () => recordDecisionRun({
        pessoaId: pessoaId ?? null, conversationId, messageId: null,
        conduta: activeConduta, promptId: activePrompt?.id ?? null, model,
        elegibilidadeStatus: "nao_avaliada", elegibilidadeMotivo: null,
        ofertaPrincipal: primaryOffer, ofertaAlternativa: null,
        nbaCategoria: "explorar",
        nbaJustificativa: "Pedido factual respondido antes da triagem com dados de fonte oficial.",
        nivelConfianca: metadata["result"] === "success" ? "alta" : "baixa",
        metadata,
      }),
      persistAssistantMessage: async () => {
        const [message] = await db.insert(messages).values({
          conversationId, role: "assistant", content: answer, conduta: activeConduta,
        }).returning({ id: messages.id });
        if (!message) throw new Error("structured factual assistant message insert returned no row");
        return message;
      },
      linkDecisionToAssistant: async (decisionRunId, assistantMessage) => {
        await db.update(decisionRuns)
          .set({ messageId: assistantMessage.id })
          .where(eq(decisionRuns.id, decisionRunId));
      },
    });
    res.write(`data: ${JSON.stringify({ content: answer })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true, conversationId })}\n\n`);
    res.end();
  };

  const factualSensitiveOfferException =
    structuredOfferingAnswer !== null &&
    safetyPreTrigger?.reason === "oferta_sensivel" &&
    !needsHumanCommercialData(userMessage) &&
    !isTransactionAdvancementRequest(userMessage);
  const preferCanonicalDescription =
    deterministicFactReady &&
    resolvedEntity !== null &&
    offeringIntent.fields?.length !== 0 &&
    offeringIntent.fields?.every(field => field === "name" || field === "description") === true;
  if (
    structuredOfferingAnswer &&
    !preferCanonicalDescription &&
    (!safetyPreTrigger || factualSensitiveOfferException)
  ) {
    await persistAndSendStructuredFact(
      structuredOfferingAnswer.message,
      {
        nba_code: structuredOfferingAnswer.result === "success"
          ? "ANSWER_FACT"
          : structuredOfferingAnswer.result === "lookup_error"
            ? "FACT_LOOKUP_ERROR"
            : "FACT_NOT_FOUND",
        result: structuredOfferingAnswer.result,
        intent: "upcoming_offering",
        repeated_request: offeringIntent.repeated,
        offering_kind: offeringIntent.kind ?? null,
        filters: {
          modality: offeringIntent.modality ?? null,
          location: offeringIntent.location ?? null,
        },
        sources: structuredOfferingAnswer.source ? [structuredOfferingAnswer.source] : [],
        candidate_set: structuredOfferingAnswer.candidateSet,
        omitted_fields: ["class_capacity", "inventory_quantity"],
      },
      structuredOfferingAnswer.candidateSet[0]?.["courseName"] as string | undefined ?? null,
    );
    return;
  }

  // Safety/handoff pre-triggers keep precedence over this conversational
  // acknowledgement; a denial combined with a sensitive request must still
  // reach the existing handoff path below.
  if (
    declaredNonCompletion &&
    !safetyPreTrigger &&
    !directInformationalQuestion &&
    !isCatalogProductFactRequest(userMessage) &&
    !isPotentialCatalogProductFactRequest(userMessage)
  ) {
    const recordedCompleted = pessoaId
      ? await getModulosConcluidos(pessoaId)
      : new Set<Modulo>();
    const firstUnmet = MODULE_PREREQUISITES[declaredNonCompletion]
      .find(module => !recordedCompleted.has(module))
      ?? declaredNonCompletion;
    const conflictsWithVerifiedCompletion = recordedCompleted.has(declaredNonCompletion);
    const prerequisiteLabel = MODULO_LABEL[firstUnmet];
    const targetLabel = blockedTargetFromHistory ? MODULO_LABEL[blockedTargetFromHistory] : null;
    const guidanceTarget = targetLabel
      ?? (firstUnmet !== declaredNonCompletion ? MODULO_LABEL[declaredNonCompletion] : null);
    const asksFirstStep = /\b(?:o que|qual|como).{0,35}\b(?:primeiro|come[çc]ar|iniciar)\b/i.test(userMessage);
    const deterministicMessage = conflictsWithVerifiedCompletion
      ? `Na sua ficha, ${MODULO_LABEL[declaredNonCompletion]} consta como concluído, mas agora você informou que não concluiu. Para não alterar um registro verificado com base apenas na conversa, preciso que essa divergência seja confirmada antes de orientar o próximo passo.`
      : asksFirstStep
        ? `O primeiro passo é fazer o módulo ${prerequisiteLabel}. Depois que essa conclusão estiver registrada, posso orientar você${guidanceTarget ? ` sobre ${guidanceTarget}` : ""}; a conversa não conta como conclusão de módulo.`
        : guidanceTarget
          ? `Entendi — ${prerequisiteLabel} ainda não foi concluído. Por isso, ${guidanceTarget} continua bloqueado e o caminho começa pelo módulo ${prerequisiteLabel}; a conversa não conta como conclusão de módulo.`
          : `Entendi — ${prerequisiteLabel} ainda não foi concluído. O caminho começa pelo módulo ${prerequisiteLabel}; a conversa não conta como conclusão de módulo.`;

    const shouldRecordIntent = !conflictsWithVerifiedCompletion && Boolean(guidanceTarget || asksFirstStep);
    if (pessoaId && shouldRecordIntent) {
      try {
        await registrarEvidencia({
          pessoaId,
          campo: "intencaoPrincipal",
          valor: guidanceTarget
            ? `Preparar-se pelo módulo ${prerequisiteLabel} antes de ${guidanceTarget}`
            : `Iniciar o módulo ${prerequisiteLabel}`,
          tipoEvidencia: "inferida",
          origem: "sofia-eligibilidade",
          aplicada: false,
        });
      } catch (error) {
        req.log.warn({ error, pessoaId }, "eligibility intent evidence write failed");
      }
    }

    const [, assistantMessage] = await db.insert(messages).values([
      { conversationId, role: "user", content: userMessage, conduta: activeConduta },
      { conversationId, role: "assistant", content: deterministicMessage, conduta: activeConduta },
    ]).returning({ id: messages.id });
    if (pessoaId) {
      await safeRecordDecisionRun({
        pessoaId, conversationId, messageId: assistantMessage?.id ?? null,
        conduta: activeConduta, promptId: activePrompt?.id ?? null, model,
        elegibilidadeStatus: conflictsWithVerifiedCompletion
          ? "nao_avaliada"
          : guidanceTarget ? "bloqueado" : "nao_avaliada",
        elegibilidadeMotivo: conflictsWithVerifiedCompletion
          ? `Declaração contradiz conclusão verificada de ${MODULO_LABEL[declaredNonCompletion]}; nenhuma alteração aplicada.`
          : `${MODULO_LABEL[declaredNonCompletion]} declarado como ainda não concluído; primeiro passo estrutural ainda não registrado: ${prerequisiteLabel}. Declaração em chat não concede conclusão.`,
        ofertaPrincipal: conflictsWithVerifiedCompletion ? null : guidanceTarget,
        ofertaAlternativa: conflictsWithVerifiedCompletion ? null : prerequisiteLabel,
        nbaCategoria: conflictsWithVerifiedCompletion ? "conversar" : "aprender",
        nbaJustificativa: conflictsWithVerifiedCompletion
          ? "Divergência entre declaração atual e conclusão verificada exige confirmação antes de orientar."
          : `Negativa de conclusão reconhecida; primeiro passo ${prerequisiteLabel} explicado sem conceder elegibilidade.`,
        nivelConfianca: conflictsWithVerifiedCompletion ? "baixa" : "alta",
        metadata: {
          declared_non_completion: declaredNonCompletion,
          first_unmet_module: firstUnmet,
          target_module: blockedTargetFromHistory,
          verified_completion_conflict: conflictsWithVerifiedCompletion,
        },
      }, req.log);
    }
    res.write(`data: ${JSON.stringify({ content: deterministicMessage })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true, conversationId })}\n\n`);
    res.end();
    return;
  }

  if (isGeneralStoreCatalogQuestion(userMessage) && !safetyPreTrigger) {
    await persistAndSendStructuredFact(
      GENERAL_STORE_CATALOG_ANSWER,
      {
        nba_code: "ANSWER_FACT",
        result: "success",
        intent: "product_catalog_summary",
        sources: [{ type: "approved_institutional_product_summary" }],
        candidate_set: [],
        omitted_fields: ["individual_products", "price", "availability", "inventory_quantity"],
      },
      null,
    );
    return;
  }

  // ── Gatilho de handoff (pré-resposta) ──────────────────────────
  // Checado sobre a mensagem da pessoa ANTES de acionar a Sofia: se disparar,
  // a Sofia nunca chega a gerar uma resposta autônoma nesta rodada — ela só
  // entrega a mensagem de transição transparente e suspende ações automáticas
  // nesta conversa até um humano assumir/liberar.
  // Pedido de fechamento (preço/desconto/checkout/vaga) é um gatilho de
  // handoff em QUALQUER modo, inclusive na primeira mensagem da conversa —
  // Documento 15 proíbe a Sofia de inventar/tratar esse dado independente
  // de já haver ficha ou confiança suficiente para modo comercial.
  type ProductGate =
    | { kind: "none" }
    | { kind: "error" }
    | { kind: "empty" }
    | { kind: "ambiguous"; products: CatalogProduct[] }
    | { kind: "single"; product: CatalogProduct };

  let catalogProductFactIntent = isCatalogProductFactRequest(userMessage);
  const potentialCatalogProductFactIntent = isPotentialCatalogProductFactRequest(userMessage);
  catalogProductFactIntent ||= potentialCatalogProductFactIntent;
  const bareCatalogAvailabilityProbe = isBareCatalogAvailabilityProbe(userMessage);
  let ambiguousBareAvailability = false;
  let productGate: ProductGate = { kind: "none" };
  try {
    if (catalogProductFactIntent || potentialCatalogProductFactIntent || bareCatalogAvailabilityProbe) {
      const literalMatches = await findMentionedPublishedProducts(userMessage);
      catalogProductFactIntent ||= literalMatches.length > 0;
      ambiguousBareAvailability =
        bareCatalogAvailabilityProbe &&
        literalMatches.length === 0 &&
        !catalogProductFactIntent;
      if (catalogProductFactIntent) {
        const products = literalMatches.length > 0
          ? literalMatches.slice(0, 5)
          : await searchPublishedProducts(userMessage, 5);
        productGate = products.length === 0
          ? { kind: "empty" }
          : products.length === 1
            ? { kind: "single", product: products[0]! }
            : { kind: "ambiguous", products };
        effectiveSystemPrompt +=
          `\n\nA consulta preventiva ao catálogo Wix para esta mensagem retornou: ` +
          (productGate.kind === "single"
            ? JSON.stringify({
                nome: productGate.product.name,
                sku: productGate.product.sku,
                preco: productGate.product.price,
                precoMaximo: productGate.product.priceMax,
                moeda: productGate.product.currency,
                urlCompra: productGate.product.url,
              })
            : productGate.kind === "ambiguous"
              ? JSON.stringify(productGate.products.map(product => ({
                  nome: product.name, sku: product.sku, preco: product.price, moeda: product.currency,
                })))
              : productGate.kind === "empty"
                ? "nenhum resultado"
                : "indisponível") +
          `. O servidor aplicará uma validação final determinística; não acrescente nenhum outro produto ou URL.`;
      }
    }
  } catch (err) {
    if (catalogProductFactIntent) {
      productGate = { kind: "error" };
    } else if (bareCatalogAvailabilityProbe) {
      ambiguousBareAvailability = true;
    }
    req.log.warn({ err }, "Wix catalog preventive lookup failed");
  }

  if (ambiguousBareAvailability && !safetyPreTrigger) {
    await persistAndSendStructuredFact(
      "Não entendi se você está procurando uma pessoa ou um produto. Pode esclarecer?",
      {
        nba_code: "FACT_AMBIGUOUS",
        result: "ambiguous",
        intent: "ambiguous_availability",
        sources: [],
        candidate_set: [],
      },
      null,
    );
    return;
  }

  if (catalogProductFactIntent && !safetyPreTrigger) {
    let productAnswer: string;
    let productResult: "success" | "ambiguous" | "not_found" | "lookup_error";
    let productSource: Record<string, unknown> | null = null;
    let productCandidates: Array<Record<string, unknown>> = [];
    let primaryProduct: string | null = null;
    if (productGate.kind === "single") {
      const publicFacts = getPublicProductFacts(productGate.product);
      productAnswer = formatPublicProductFacts(publicFacts, userMessage);
      productResult = "success";
      primaryProduct = publicFacts.name;
      productSource = {
        type: "official_product_catalog",
        catalog: "wix",
        inventory: publicFacts.availabilitySource,
        fetchedAt: new Date().toISOString(),
        productId: publicFacts.id,
        sku: publicFacts.sku,
        inventoryUpdatedAt: publicFacts.availabilityUpdatedAt,
      };
      productCandidates = [{ ...publicFacts }];
    } else if (productGate.kind === "ambiguous") {
      const publicFacts = productGate.products.map(getPublicProductFacts);
      productAnswer = `Encontrei mais de um produto compatível: ${publicFacts.map(product => product.name).join(", ")}. Qual deles você quer consultar?`;
      productResult = "ambiguous";
      productCandidates = publicFacts.map(product => ({ ...product }));
    } else if (productGate.kind === "empty") {
      productAnswer = "Esse produto não existe no catálogo publicado.";
      productResult = "not_found";
    } else {
      productAnswer = "Não consegui consultar os produtos e o estoque agora. Prefiro não inventar preço, link ou disponibilidade.";
      productResult = "lookup_error";
    }
    await persistAndSendStructuredFact(
      productAnswer,
      {
        nba_code: productResult === "success"
          ? "ANSWER_FACT"
          : productResult === "ambiguous"
            ? "FACT_AMBIGUOUS"
            : productResult === "lookup_error"
              ? "FACT_LOOKUP_ERROR"
              : "FACT_NOT_FOUND",
        result: productResult,
        intent: "product_fact",
        sources: productSource ? [productSource] : [],
        candidate_set: productCandidates,
        omitted_fields: ["inventory_quantity", "physical_quantity", "reserved_quantity", "pending_quantity"],
      },
      primaryProduct,
    );
    return;
  }
  chatMessages[0]!.content = effectiveSystemPrompt;

  const isClosingRequest = detectClosingRequest(userMessage);
  const requiresHumanCommercialData = needsHumanCommercialData(userMessage);
  const hasSelfServeProductMatch =
    !requiresHumanCommercialData && (
      (productGate.kind === "single" && Boolean(productGate.product.url))
      || productGate.kind === "ambiguous"
    );
  const factualPriceQuestion = directInformationalQuestion && !requiresHumanCommercialData;
  const prioritySafetyPreTrigger =
    safetyPreTrigger?.emergencyGuidance === true ||
    safetyPreTrigger?.reason === "pedido_explicito"
      ? safetyPreTrigger
      : null;
  const preTrigger = prioritySafetyPreTrigger
    ?? (governanceDecision
      ? { reason: governanceDecision.reason, sensitiveContext: governanceDecision.gateReason, emergencyGuidance: false }
      : null)
    ?? safetyPreTrigger
    ?? (isClosingRequest && !hasSelfServeProductMatch && !factualPriceQuestion
      ? { reason: "fechamento_comercial" as const, sensitiveContext: null, emergencyGuidance: false }
      : null);
  if (preTrigger) {
    const summary = await buildHandoffSummary({
      reason: preTrigger.reason,
      userMessage,
      pessoaId: pessoaId ?? null,
      pessoaNome: pessoaId ? resolvedNome : null,
      intencaoPrincipal,
      sensitiveContext: preTrigger.sensitiveContext,
      conversationMessages: historyMessages,
    });
    const transitionMessage = handoffTransitionMessage(
      preTrigger.reason,
      preTrigger.emergencyGuidance === true,
    );
    await handoffRouteTestHooks.beforePersistPreTrigger?.();

    const preTriggerAssistantMsg = await db.transaction(async tx => {
      const [updatedConversation] = await tx.update(conversationsTable)
        .set({
          status: "aguardando_humano",
          handoffReason: preTrigger.reason,
          handoffSummary: JSON.stringify(summary),
          handoffTriggeredAt: new Date(),
          handoffResolvedAt: null,
          handoffResolvedBy: null,
        })
        .where(eq(conversationsTable.id, conversationId))
        .returning({ id: conversationsTable.id });
      if (!updatedConversation) throw new Error("Conversa não encontrada ao persistir handoff.");

      const [, assistantMessage] = await tx.insert(messages).values([
        { conversationId, role: "user", content: userMessage, conduta: activeConduta },
        { conversationId, role: "assistant", content: transitionMessage, conduta: activeConduta },
      ]).returning({ id: messages.id });
      if (!assistantMessage) throw new Error("Mensagem de handoff não foi persistida.");
      return assistantMessage;
    });
    if (pessoaId && (!directInformationalQuestion || governanceDecision)) {
      await safeRecordDecisionRun({
        pessoaId, conversationId, messageId: preTriggerAssistantMsg?.id ?? null,
        conduta: activeConduta, promptId: activePrompt?.id ?? null, model,
        elegibilidadeStatus: "nao_avaliada",
        elegibilidadeMotivo: null,
        ofertaPrincipal: null, ofertaAlternativa: null,
        nbaCategoria: "conversar",
        nbaJustificativa: `Handoff automático (${preTrigger.reason}) antes de qualquer recomendação — Sofia não avança sozinha.`,
        nivelConfianca: "media",
         metadata: {
           outcome: "handoff",
           handoffReason: preTrigger.reason,
           gateReason: governanceDecision?.gateReason ?? null,
           entity: resolvedEntity ?? commercialResolvedEntity ?? null,
         },
      }, req.log);
    }

    res.write(`data: ${JSON.stringify({ content: transitionMessage })}\n\n`);
    res.write(`data: ${JSON.stringify({
      done: true, conversationId,
      handoffTriggered: true, handoffReason: preTrigger.reason, handoffSummary: summary,
    })}\n\n`);
    res.end();
    return;
  }

  // Deterministic factual fast-path: never expose RAG/model prose for an
  // identified canonical entity. The response is built only from approved,
  // sanitized registry facts.
  if (deterministicFactReady && resolvedEntity) {
    const factualResult = resolvedEntity;
    const deterministicMessage = buildDeterministicFactualResponse(factualResult);
    await persistFactualExchangeAfterAudit({
      persistUserMessage: async () => {
        await db.insert(messages).values({
          conversationId, role: "user", content: userMessage, conduta: activeConduta,
        });
      },
      persistDecisionRun: async () => {
        if (process.env.NODE_ENV === "test") await factualRouteTestHooks.beforeDecisionRun?.();
        return recordDecisionRun({
          pessoaId: pessoaId!, conversationId, messageId: null,
          conduta: activeConduta, promptId: activePrompt?.id ?? null, model,
          elegibilidadeStatus: "nao_avaliada", elegibilidadeMotivo: null,
          ofertaPrincipal: null, ofertaAlternativa: null, nbaCategoria: "conversar",
          nbaJustificativa: "Resposta factual determinística baseada na entidade canônica aprovada.",
          nivelConfianca: "alta",
          metadata: {
            nba_code: "ANSWER_FACT", candidate_set: [{ id: factualResult.id, stableKey: factualResult.stableKey }],
            entity: { id: factualResult.id, type: factualResult.entityType, stableKey: factualResult.stableKey },
            sources: factualResult.sourceRefs,
            gates: {
              identity: "PASS",
              factualConfidence: "HIGH",
              commercial: factualCommercialBoundary.gates,
              sensitivity: factualResult.sensitive ? "REVIEWED" : "NOT_SENSITIVE",
            },
            confidence: "high",
            tools: ["registry_lookup"],
            result: "success", latency_ms: fastPathStartedAt === null ? null : Date.now() - fastPathStartedAt,
          },
        });
      },
      persistAssistantMessage: async () => {
        const [message] = await db.insert(messages).values({
          conversationId, role: "assistant", content: deterministicMessage, conduta: activeConduta,
        }).returning({ id: messages.id });
        if (!message) throw new Error("factual assistant message insert returned no row");
        return message;
      },
      linkDecisionToAssistant: async (decisionRunId, assistantMessage) => {
        await db.update(decisionRuns)
          .set({ messageId: assistantMessage.id })
          .where(eq(decisionRuns.id, decisionRunId));
      },
    });
    res.write(`data: ${JSON.stringify({ content: deterministicMessage })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true, conversationId })}\n\n`);
    res.end();
    return;
  }

  // ── Elegibilidade bloqueada, checada ANTES de qualquer geração ────────
  // Prioridade absoluta (Documento 14A): quando a própria mensagem da pessoa
  // já nomeia um módulo bloqueado, a resposta é determinística — a Sofia
  // NUNCA chega a gerar texto livre nesta rodada, então não há como o modelo
  // "escapar" da instrução e oferecer/prometer o módulo de qualquer jeito.
  // O gate por tool call (recommendVideos) continua existindo como segunda
  // camada para os casos em que o módulo só aparece depois, no meio da
  // conversa (ex.: sugestão espontânea da própria Sofia).
  if (pregenModuleGate) {
    const { modulo, elegibilidade } = pregenModuleGate;
    const deterministicMessage = deterministicBlockedMessage(modulo, elegibilidade);

    const [, blockedAssistantMsg] = await db.insert(messages).values([
      { conversationId, role: "user", content: userMessage, conduta: activeConduta },
      { conversationId, role: "assistant", content: deterministicMessage, conduta: activeConduta },
    ]).returning({ id: messages.id });

    if (pessoaId) {
      await safeRecordDecisionRun({
        pessoaId, conversationId, messageId: blockedAssistantMsg?.id ?? null,
        conduta: activeConduta, promptId: activePrompt?.id ?? null, model,
        elegibilidadeStatus: "bloqueado",
        elegibilidadeMotivo: elegibilidade.motivo,
        ofertaPrincipal: MODULO_LABEL[modulo],
        ofertaAlternativa: elegibilidade.faltando[0] ? MODULO_LABEL[elegibilidade.faltando[0]] : null,
        nbaCategoria: "aprender",
        nbaJustificativa: `Pessoa mencionou "${MODULO_LABEL[modulo]}" na própria mensagem — resposta determinística de pré-requisito, sem geração de texto livre, pois faltam os pré-requisitos.`,
        nivelConfianca: "alta",
      }, req.log);
    }

    res.write(`data: ${JSON.stringify({ content: deterministicMessage })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true, conversationId })}\n\n`);
    res.end();
    return;
  }

  let fullResponse = "";
  let finalHandoffSummary: Awaited<ReturnType<typeof buildHandoffSummary>> | null = null;

  // Decisão desta rodada, a ser gravada em decision_run depois que a mensagem
  // do assistente for persistida (para termos o messageId real). Preenchida
  // por uma tool relevante (ex.: recommendVideos) quando ela decide por si;
  // se nada preencher, uma classificação genérica cobre a rodada mesmo
  // quando a Sofia decidiu tudo em texto livre (ver mais abaixo).
  let pendingDecision: Omit<Parameters<typeof recordDecisionRun>[0], "pessoaId" | "conversationId" | "messageId"> | null = null;

  // Candidatos que a tool recommendVideos devolveu nesta rodada. A tool pode
  // retornar até 2, mas só contam como "enviados de fato" (ver tarefa "See
  // which videos Sofia actually sends to leads") os que sobrevivem a todos os
  // gates de elegibilidade e realmente aparecem no texto final — checado logo
  // antes de persistir, quando fullResponse já está definitivo.
  let recommendedVideoCandidates: VideoRecommendation[] = [];
  let pendingContentAsset: {
    id: number;
    ref: string | null;
    title: string;
    url: string;
    course: string | null;
    type: string | null;
  } | null = null;
  let recommendedProductCandidate: CatalogProduct | null =
    productGate.kind === "single" && productGate.product.url ? productGate.product : null;

  try {
    // Phase 1: stream with tool support
    const activeTools = [
      updatePessoaTool,
      ...(pessoaId ? [] : [createPessoaTool]),
      ...(hasKnowledge ? [searchKnowledgeBaseTool] : []),
      searchStoreProductsTool,
      recommendVideosTool,
      ...(deterministicFactReady ? [
        ...(intentClassification.factKind === "offer" ? [getOfferInfoTool] : []),
        ...(intentClassification.factKind === "instrument_family" ? [getInstrumentFamilyInfoTool] : []),
        ...(intentClassification.factKind === "event" ? [getEventInfoTool] : []),
        sendContentAssetTool,
      ] : []),
      ...(activeConduta === "comercial" ? [escalateToHumanTool] : []),
    ];
    const firstRound = await runSofiaToolRound({
      client: openai,
      model,
      messages: chatMessages,
      tools: activeTools,
    });
    const toolCallsAccum = firstRound.toolCalls;
    const finishedWithToolCall = toolCallsAccum.length > 0;
    fullResponse += firstRound.text;

    // Escalonamento comercial (Documento 15): a Sofia mesma reconheceu que
    // não deve continuar sozinha (elegibilidade insuficiente ou sinais
    // contraditórios que ela não consegue resolver). Igual ao pré-gatilho:
    // nenhuma resposta autônoma adicional é gerada, só a mensagem de
    // transição, e a conversa fica congelada até um humano assumir/liberar.
    const escalateCall = toolCallsAccum.find(tc => tc?.function.name === "escalateToHuman");
    if (finishedWithToolCall && escalateCall) {
      const args = JSON.parse(escalateCall.function.arguments || "{}") as {
        motivo?: "elegibilidade_insuficiente" | "sinais_contraditorios"; resumo?: string;
      };
      const reason = args.motivo === "sinais_contraditorios" ? "sinais_contraditorios" : "elegibilidade_insuficiente";
      const summary = await buildHandoffSummary({
        reason,
        userMessage: args.resumo ?? userMessage,
        pessoaId: pessoaId ?? null,
        pessoaNome: pessoaId ? resolvedNome : null,
        intencaoPrincipal,
        sensitiveContext: null,
      });
      const transitionMessage = handoffTransitionMessage(reason);

      await db.update(conversationsTable)
        .set({
          status: "aguardando_humano",
          handoffReason: reason,
          handoffSummary: JSON.stringify(summary),
          handoffTriggeredAt: new Date(),
        })
        .where(eq(conversationsTable.id, conversationId));
      const [, escalateAssistantMsg] = await db.insert(messages).values([
        { conversationId, role: "user", content: userMessage, conduta: activeConduta },
        { conversationId, role: "assistant", content: transitionMessage, conduta: activeConduta },
      ]).returning({ id: messages.id });

      if (pessoaId) {
        await safeRecordDecisionRun({
          pessoaId, conversationId, messageId: escalateAssistantMsg?.id ?? null,
          conduta: activeConduta, promptId: activePrompt?.id ?? null, model,
          elegibilidadeStatus: reason === "elegibilidade_insuficiente" ? "bloqueado" : "nao_avaliada",
          elegibilidadeMotivo: args.resumo ?? null,
          ofertaPrincipal: null, ofertaAlternativa: null,
          nbaCategoria: "conversar",
          nbaJustificativa: args.resumo ?? `Escalonamento comercial (${reason}) — Sofia reconheceu que não deve decidir sozinha.`,
          nivelConfianca: "baixa",
        }, req.log);
      }

      res.write(`data: ${JSON.stringify({ content: transitionMessage })}\n\n`);
      res.write(`data: ${JSON.stringify({
        done: true, conversationId,
        handoffTriggered: true, handoffReason: reason, handoffSummary: summary,
      })}\n\n`);
      res.end();
      return;
    }

    // Phase 2: if tool was called, execute it and stream the final answer
    if (finishedWithToolCall && toolCallsAccum.length > 0) {
      const toolCall = toolCallsAccum[0]!;
      let toolResultContent: string = JSON.stringify({ resultado: "Tool não reconhecida" });

      if (toolCall.function.name === "searchStoreProducts") {
        if (!catalogProductFactIntent) {
          // A model tool call cannot turn an ambiguous person/name query into a
          // product-not-found claim. Only classifier intent or a literal known
          // catalog match authorizes the catalog result path.
          toolResultContent = JSON.stringify({
            produtos: [],
            resultado: "A mensagem não identifica com segurança uma consulta de produto. Não afirme ausência no catálogo.",
          });
        } else try {
          // The model may not replace the person's unknown product with a
          // different, searchable item. The original request is authoritative.
          const products = await searchPublishedProducts(userMessage, 5);
          if (products.length === 0) {
            productGate = { kind: "empty" };
            toolResultContent = JSON.stringify({
              produtos: [],
              resultado: "Nenhum produto publicado compatível foi encontrado. Não invente produto, preço ou link.",
            });
          } else if (products.length > 1) {
            productGate = { kind: "ambiguous", products };
            toolResultContent = JSON.stringify({
              produtos: products.map(product => ({
                sku: product.sku,
                nome: product.name,
                preco: product.price,
                precoMaximo: product.priceMax,
                moeda: product.currency,
              })),
              resultado: "Há mais de um produto possível. Peça para a pessoa esclarecer qual deseja e não envie link ainda.",
            });
          } else {
            const product = products[0]!;
            productGate = { kind: "single", product };
            if (!product.url) {
              toolResultContent = JSON.stringify({
                produtos: [{ sku: product.sku, nome: product.name, preco: product.price, moeda: product.currency }],
                resultado: "O produto existe, mas não tem URL individual válida. Não invente nem envie link.",
              });
            } else {
              recommendedProductCandidate = product;
              toolResultContent = JSON.stringify({
                produto: {
                  sku: product.sku,
                  nome: product.name,
                  // Descrições geradas por IA/pesquisa servem apenas ao catálogo
                  // interno até validação humana; a Sofia comercial recebe somente
                  // o texto oficial publicado na Wix.
                  descricao: product.descriptionSource === "wix" ? product.description : null,
                  preco: product.price,
                  precoMaximo: product.priceMax,
                  moeda: product.currency,
                  urlCompra: product.url,
                  // Mesma regra qualitativa do modo simples: estoque Omie, nunca quantidade.
                  disponibilidade: getPublicProductFacts(product).availability,
                },
                resultado: "Use somente estes dados e envie exatamente a URL de compra retornada.",
              });
            }
          }
        } catch (err) {
          productGate = { kind: "error" };
          req.log.warn({ err }, "searchStoreProducts tool failed");
          toolResultContent = JSON.stringify({
            produtos: [],
            resultado: "O catálogo Wix está indisponível no momento. Não invente produto, preço ou link.",
          });
        }
      } else if (toolCall.function.name === "searchKnowledgeBase") {
        const args = JSON.parse(toolCall.function.arguments) as { query: string };
        const results = await searchKnowledge(args.query);

        if (results.length === 0) {
          toolResultContent = JSON.stringify({
            resultado: "Nenhuma informação encontrada na base de conhecimento sobre este assunto.",
          });
        } else {
          toolResultContent = JSON.stringify({
            chunks: results.map(r => ({
              fonte: `${r.title}, chunk #${r.chunkIndex}`,
              conteudo: ocultarValoresEmReais(r.contentPreview),
              relevancia: r.score.toFixed(4),
            })),
          });
        }
      } else if (toolCall.function.name === "createPessoa") {
        const args = JSON.parse(toolCall.function.arguments) as {
          nome: string; sobrenome?: string; celular: string;
          email?: string; cidade?: string; estadoUf?: string;
          profissao?: string; comoFicouSabendo?: string;
          servicoInteresse?: string; instagram?: string;
        };
        try {
          // Todos os campos coletados pelo modelo — incluindo nome/celular — passam
          // por upsertPessoaViaSofia, que só cria uma linha de identidade vazia e
          // então grava tudo através de filtrarAtualizacaoSofia (evidência antes do
          // valor oficial, campos já confirmados por humano ficam bloqueados).
          const campos: Record<string, unknown> = {};
          if (args.sobrenome) campos.sobrenome = args.sobrenome;
          if (args.email) campos.email = args.email;
          if (args.cidade) campos.cidade = args.cidade;
          if (args.estadoUf) campos.estadoUf = args.estadoUf;
          if (args.profissao) campos.profissao = args.profissao;
          if (args.comoFicouSabendo) campos.comoFicouSabendo = args.comoFicouSabendo;
          if (args.servicoInteresse) campos.servicoInteresse = args.servicoInteresse;
          if (args.instagram) campos.instagram = args.instagram;

          const { id: newPessoaId, nome: newPessoaNome, codigo: newPessoaCodigo } =
            await upsertPessoaViaSofia(args.celular, { nome: args.nome, ...campos });

          // Also link conversation to this new pessoa
          if (conversationId) {
            await pool.query(
              `UPDATE conversations SET pessoa_id = $1 WHERE id = $2 AND pessoa_id IS NULL`,
              [newPessoaId, conversationId]
            );
          }
          toolResultContent = JSON.stringify({
            sucesso: true,
            pessoaId: newPessoaId,
            mensagem: `Ficha de ${newPessoaNome} (${newPessoaCodigo}) criada com sucesso. Use updatePessoa com pessoaId=${newPessoaId} para adicionar mais informações.`,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Erro desconhecido";
          req.log.warn({ err }, "createPessoa tool failed");
          toolResultContent = JSON.stringify({ erro: `Falha ao criar ficha: ${msg}` });
        }
      } else if (toolCall.function.name === "updatePessoa") {
        const args = JSON.parse(toolCall.function.arguments) as { pessoaId: number; campos: Record<string, string | null>; tipoEvidencia?: string };
        const { campos } = args;
        // O pessoaId é sempre o da conversa; o enviado pelo modelo é ignorado
        // (evita gravar evidência na ficha de outra pessoa).
        const pid = pessoaId;
        if (args.pessoaId !== undefined && args.pessoaId !== pid) {
          req.log.warn({ conversationId, status: "pessoa_id_do_modelo_ignorado" }, "updatePessoa: pessoaId do modelo ignorado");
        }

        // Whitelist tipoEvidencia to values Sofia is allowed to emit.
        // Anything outside this set falls back to "inferida" (baixa confiança).
        const ALLOWED_TIPOS: ReadonlySet<TipoEvidenciaSofia> = new Set(["inferida", "comportamental", "relacional"]);
        const tipoEvidencia: TipoEvidenciaSofia =
          args.tipoEvidencia && ALLOWED_TIPOS.has(args.tipoEvidencia as TipoEvidenciaSofia)
            ? (args.tipoEvidencia as TipoEvidenciaSofia)
            : "inferida";

        // Whitelist: only allow safe, known fields
        const safeEntries = Object.entries(campos).filter(([k]) => PESSOA_UPDATABLE_FIELDS.has(k));

        if (!pid) {
          toolResultContent = JSON.stringify({ erro: "Esta conversa não tem ficha vinculada. Não diga que anotou nada." });
        } else if (safeEntries.length === 0) {
          toolResultContent = JSON.stringify({ erro: "Nenhum campo válido fornecido para atualizar." });
        } else {
          try {
            // Toda tentativa de escrita da Sofia passa pelo mecanismo de evidências.
            // O tipoEvidencia controla o nivelConfianca registrado: "comportamental"
            // e "relacional" valem media — suficiente para o critério primário de
            // determineConduta (media/alta → comercial). "inferida" (padrão) vale baixa
            // e depende da convergência mínima de 3× para acionar a transição.
            // Campos já confirmados por humano ficam bloqueados em qualquer caso.
            // Checagem de campos confirmados + evidência + UPDATE oficial rodam na
            // mesma transação com lock de linha (withPessoaLock), serializando contra
            // uma edição humana concorrente sobre a mesma pessoa.
            const { aplicaveis, bloqueados, pessoa } = await withPessoaLock(pid, async (tx) => {
              const { aplicaveis, bloqueados } = await filtrarAtualizacaoSofia(
                pid,
                Object.fromEntries(safeEntries),
                tx,
                tipoEvidencia,
              );
              if (Object.keys(aplicaveis).length === 0) {
                return { aplicaveis, bloqueados, pessoa: undefined };
              }
              const [updated] = await tx
                .update(pessoasTable)
                .set({ ...aplicaveis, updatedAt: new Date() })
                .where(eq(pessoasTable.id, pid))
                .returning({ id: pessoasTable.id, nome: pessoasTable.nome, codigo: pessoasTable.codigo });
              return { aplicaveis, bloqueados, pessoa: updated };
            });
            const aplicaveisEntries = Object.entries(aplicaveis);

            if (aplicaveisEntries.length === 0) {
              toolResultContent = JSON.stringify({
                sucesso: false,
                resultado: "Todos os campos informados já foram confirmados por um humano e não podem ser sobrescritos pela Sofia.",
                camposBloqueados: bloqueados,
              });
            } else if (!pessoa) {
              toolResultContent = JSON.stringify({ erro: `Pessoa com ID ${pid} não encontrada.` });
            } else {
              toolResultContent = JSON.stringify({
                sucesso: true,
                mensagem: `Ficha de ${pessoa.nome} (${pessoa.codigo}) atualizada com sucesso.`,
                camposAtualizados: aplicaveisEntries.map(([k]) => k),
                ...(bloqueados.length > 0 ? { camposBloqueados: bloqueados } : {}),
              });
            }
          } catch (err) {
            if (err instanceof PessoaNotFoundError) {
              toolResultContent = JSON.stringify({ erro: `Pessoa com ID ${pid} não encontrada.` });
            } else {
              const msg = err instanceof Error ? err.message : "Erro desconhecido";
              req.log.warn({ err }, "updatePessoa tool failed");
              toolResultContent = JSON.stringify({ erro: `Falha ao atualizar: ${msg}` });
            }
          }
        }
      } else if (["getOfferInfo", "getInstrumentFamilyInfo", "getEventInfo", "sendContentAsset"].includes(toolCall.function.name)) {
        const args = JSON.parse(toolCall.function.arguments || "{}") as { id?: string };
        try {
          if (!args.id) throw new Error("id obrigatório");
          if (toolCall.function.name !== "sendContentAsset" &&
              (!resolvedEntity || args.id !== resolvedEntity.stableKey)) {
            throw new Error("entidade não corresponde ao candidato canônico resolvido");
          }
          const result = toolCall.function.name === "getOfferInfo"
            ? await getOfferInfo(args.id)
            : toolCall.function.name === "getInstrumentFamilyInfo"
              ? await getInstrumentFamilyInfo(args.id)
              : toolCall.function.name === "getEventInfo"
                ? await getEventInfo(args.id)
                : await sendContentAsset(args.id);
          toolResultContent = JSON.stringify(result);
          if (result.status === "pending") pendingContentAsset = result.asset;
          const decisionShape = factualDecisionShape(result.status, result);
          pendingDecision = {
            conduta: activeConduta, promptId: activePrompt?.id ?? null, model,
            elegibilidadeStatus: "nao_avaliada", elegibilidadeMotivo: null,
            ofertaPrincipal: null, ofertaAlternativa: null, nbaCategoria: "conversar",
            nbaJustificativa: decisionShape.justification, nivelConfianca: decisionShape.confidence === "high" ? "alta" : "baixa",
            metadata: { nba_code: factualToolNbaCode(toolCall.function.name, result.status, decisionShape), candidate_set: resolvedEntity ? [{ id: resolvedEntity.id, stableKey: resolvedEntity.stableKey }] : [{ attempted: args.id }], entity: resolvedEntity
              ? { type: resolvedEntity.entityType, id: resolvedEntity.id, stableKey: resolvedEntity.stableKey } : null,
              sources: result, gates: { commercialCapability }, tools: toolCallsAccum.map(call => call.function.name),
              confidence: decisionShape.confidence, result: decisionShape.result, detail: decisionShape.detail, latency_ms: fastPathStartedAt === null ? null : Date.now() - fastPathStartedAt },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Falha ao consultar fato";
          const decisionShape = factualDecisionShape("pending", { status: "lookup_error", message }, message);
          toolResultContent = JSON.stringify({ status: "not_found", message });
          pendingDecision = {
            conduta: activeConduta, promptId: activePrompt?.id ?? null, model,
            elegibilidadeStatus: "nao_avaliada", elegibilidadeMotivo: null,
            ofertaPrincipal: null, ofertaAlternativa: null, nbaCategoria: "conversar",
            nbaJustificativa: decisionShape.justification, nivelConfianca: decisionShape.confidence === "high" ? "alta" : "baixa",
            metadata: { nba_code: decisionShape.nbaCode, candidate_set: [{ attempted: args.id ?? null }], entity: resolvedEntity ?? null,
              sources: [], gates: { commercialCapability }, tools: toolCallsAccum.map(call => call.function.name),
              confidence: decisionShape.confidence, result: decisionShape.result, detail: decisionShape.detail,
              latency_ms: fastPathStartedAt === null ? null : Date.now() - fastPathStartedAt },
          };
        }
      } else if (toolCall.function.name === "recommendVideos") {
        const args = JSON.parse(toolCall.function.arguments || "{}") as {
          curso?: string; tipoConteudo?: string; textoAdicional?: string;
        };
        try {
          // Elegibilidade tem prioridade absoluta (Documento 14A): se o curso
          // pedido tem pré-requisito de módulo conhecido e a pessoa ainda não
          // o cumpriu, a Sofia não recomenda — explica o caminho preparatório.
          const moduloAlvo = resolveOfertaModulo({ curso: args.curso, outrasFontes: [args.tipoConteudo, args.textoAdicional] });
          let elegibilidade: Awaited<ReturnType<typeof checkModuleEligibility>> | null = null;
          if (moduloAlvo && pessoaId) {
            const concluidos = await getModulosConcluidos(pessoaId);
            elegibilidade = checkModuleEligibility(moduloAlvo, concluidos);
          }

          if (elegibilidade?.status === "bloqueado") {
            toolResultContent = JSON.stringify({
              videos: [],
              resultado: `Elegibilidade insuficiente: ${elegibilidade.motivo} Explique isso para a pessoa com empatia, sem recomendar vídeos deste módulo.`,
            });
            pendingDecision = {
              conduta: activeConduta, promptId: activePrompt?.id ?? null, model,
              elegibilidadeStatus: "bloqueado",
              elegibilidadeMotivo: elegibilidade.motivo,
              ofertaPrincipal: args.curso ?? null,
              ofertaAlternativa: elegibilidade.faltando[0] ?? null,
              nbaCategoria: "aprender",
              nbaJustificativa: `Pessoa pediu ${args.curso}, mas falta pré-requisito de módulo — caminho preparatório indicado em vez da oferta pedida.`,
              nivelConfianca: "alta",
            };
          } else {
            const recs = await recommendVideos(args);
            recommendedVideoCandidates = recs;
            toolResultContent = recs.length > 0
              ? JSON.stringify({ videos: recs })
              : JSON.stringify({ videos: [], resultado: "Nenhum vídeo aprovado compatível encontrado. Não mencione vídeo." });
            pendingDecision = {
              conduta: activeConduta, promptId: activePrompt?.id ?? null, model,
              elegibilidadeStatus: moduloAlvo ? "elegivel" : "nao_avaliada",
              elegibilidadeMotivo: elegibilidade?.motivo ?? null,
              ofertaPrincipal: args.curso ?? null,
              ofertaAlternativa: null,
              nbaCategoria: recs.length > 0 ? "consumir_conteudo" : "pausar",
              nbaJustificativa: recs.length > 0
                ? `Vídeos compatíveis com "${args.curso ?? args.tipoConteudo ?? "interesse declarado"}" encontrados e compartilhados.`
                : `Nenhum conteúdo aprovado compatível com "${args.curso ?? args.tipoConteudo ?? "interesse declarado"}" — sem recomendação nesta rodada.`,
              nivelConfianca: recs.length > 0 ? "media" : "baixa",
            };
          }
        } catch (err) {
          req.log.warn({ err }, "recommendVideos tool failed");
          toolResultContent = JSON.stringify({ videos: [], resultado: "Erro ao buscar vídeos. Não mencione vídeo." });
        }
      } else {
        toolResultContent = JSON.stringify({ resultado: "Tool não reconhecida" });
      }

      fullResponse += await runSofiaFinalRound({
        client: openai,
        model,
        messages: chatMessages,
        firstRound,
        toolCall,
        toolOutput: toolResultContent,
      });
    }

    // Pedido explícito de vídeo não pode depender de o modelo decidir chamar
    // a tool. Se ele responder apenas com uma promessa, resolvemos o catálogo
    // de forma determinística usando também o contexto recente da formação.
    if (isExplicitVideoRecommendationRequest(userMessage)) {
      const recommendationContext = videoRecommendationContext(userMessage, historyMessages);
      const contextModule = latestVideoRequestModule(userMessage, historyMessages);
      // Nunca aceite a escolha do modelo (recommendVideos/sendContentAsset)
      // como prova de compatibilidade. Refaça a seleção com o contexto real.
      pendingContentAsset = null;
      recommendedVideoCandidates = await recommendVideos({
        textoAdicional: recommendationContext,
      }, { strictContext: true });
      recommendedVideoCandidates = [...new Map(
        recommendedVideoCandidates.map(video => [video.link, video]),
      ).values()].slice(0, 2);

      const candidateModules = recommendedVideoCandidates
        .map(video => resolveOfertaModulo({
          curso: video.curso,
          outrasFontes: [video.titulo],
        }))
        .filter((modulo): modulo is Modulo => modulo !== null);
      // Um pedido explícito por material informativo não é uma recomendação de
      // percurso. A compatibilidade com o tema continua obrigatória, mas os
      // pré-requisitos de matrícula não podem substituir o vídeo solicitado.
      const modulesToCheck = directInformationalQuestion
        ? []
        : [...new Set([
            ...(contextModule ? [contextModule] : []),
            ...candidateModules,
          ])];
      const concluidos: Set<Modulo> = pessoaId && modulesToCheck.length > 0
        ? await getModulosConcluidos(pessoaId)
        : new Set<Modulo>();
      const eligibilityChecks = modulesToCheck.map(modulo => ({
        modulo,
        eligibility: checkModuleEligibility(modulo, concluidos),
      }));
      const blocked = eligibilityChecks.find(check => check.eligibility.status === "bloqueado");
      const primaryCheck = blocked ?? eligibilityChecks[0] ?? null;

      if (blocked) {
        recommendedVideoCandidates = [];
        fullResponse = deterministicBlockedMessage(blocked.modulo, blocked.eligibility);
        pendingDecision = {
          conduta: activeConduta, promptId: activePrompt?.id ?? null, model,
          elegibilidadeStatus: "bloqueado",
          elegibilidadeMotivo: blocked.eligibility.motivo,
          ofertaPrincipal: MODULO_LABEL[blocked.modulo],
          ofertaAlternativa: blocked.eligibility.faltando[0]
            ? MODULO_LABEL[blocked.eligibility.faltando[0]]
            : null,
          nbaCategoria: "aprender",
          nbaJustificativa: "Pedido de vídeo bloqueado por pré-requisito antes de consultar ou enviar conteúdo.",
          nivelConfianca: "alta",
        };
      } else {
        if (recommendedVideoCandidates.length > 0) {
          fullResponse = [
            "Encontrei estes vídeos aprovados para você entender melhor:",
            ...recommendedVideoCandidates.map(video => `\n📹 *${video.titulo}*\n${video.link}`),
          ].join("\n");
          pendingDecision = {
            conduta: activeConduta, promptId: activePrompt?.id ?? null, model,
            elegibilidadeStatus: primaryCheck ? "elegivel" : "nao_avaliada",
            elegibilidadeMotivo: primaryCheck?.eligibility.motivo ?? null,
            ofertaPrincipal: primaryCheck ? MODULO_LABEL[primaryCheck.modulo] : null,
            ofertaAlternativa: null,
            nbaCategoria: "consumir_conteudo",
            nbaJustificativa: "Pedido explícito atendido com vídeos aprovados e compatíveis do catálogo.",
            nivelConfianca: "media",
          };
        } else {
          fullResponse = "Não encontrei um vídeo aprovado e compatível com essa formação no catálogo agora.";
          pendingDecision = {
            conduta: activeConduta, promptId: activePrompt?.id ?? null, model,
            elegibilidadeStatus: primaryCheck ? "elegivel" : "nao_avaliada",
            elegibilidadeMotivo: primaryCheck?.eligibility.motivo ?? null,
            ofertaPrincipal: primaryCheck ? MODULO_LABEL[primaryCheck.modulo] : null,
            ofertaAlternativa: null,
            nbaCategoria: "pausar",
            nbaJustificativa: "Nenhum vídeo aprovado compatível foi encontrado; resposta transparente sem promessa futura.",
            nivelConfianca: "baixa",
          };
        }
      }
    }

    // ── Gate de elegibilidade PÓS-geração ──────────────────────────
    // Prioridade absoluta (Documento 14A), segunda e última camada: mesmo
    // que a pessoa não tenha nomeado o módulo (gate de pré-geração não
    // disparou) e nenhuma tool tenha sido chamada, a Sofia pode ter
    // mencionado/oferecido um módulo bloqueado por conta própria no texto
    // livre gerado. Isso é checado ANTES de qualquer byte da resposta ser
    // enviado ao cliente (nada foi escrito em `res` até aqui nesta rodada) —
    // se a resposta viola a elegibilidade estrutural, ela é substituída pela
    // mensagem determinística antes de sair do servidor. O modelo não tem
    // como "escapar" descrevendo o módulo de outro jeito: seu texto nunca
    // chega ao cliente quando este gate bloqueia.
    let eligibilityGateBlocked = false;
    if (pessoaId && !directInformationalQuestion) {
      // Checa TODOS os módulos citados na resposta, não só o primeiro — uma
      // frase pode citar vários juntos (ex.: "a sequência é Água → Fogo →
      // Ar → Terra") e só o primeiro (Água, nunca bloqueado) não pode
      // mascarar uma menção/oferta indevida de um módulo mais adiante.
      const modulosNaResposta = detectTodosModulosSemAncora(fullResponse);
      if (modulosNaResposta.length > 0) {
        const concluidos = await getModulosConcluidos(pessoaId);
        for (const modulo of modulosNaResposta) {
          const elegibilidade = checkModuleEligibility(modulo, concluidos);
          if (elegibilidade.status === "bloqueado") {
            fullResponse = deterministicBlockedMessage(modulo, elegibilidade);
            eligibilityGateBlocked = true;
            pendingDecision = {
              conduta: activeConduta, promptId: activePrompt?.id ?? null, model,
              elegibilidadeStatus: "bloqueado",
              elegibilidadeMotivo: elegibilidade.motivo,
              ofertaPrincipal: MODULO_LABEL[modulo],
              ofertaAlternativa: elegibilidade.faltando[0] ? MODULO_LABEL[elegibilidade.faltando[0]] : null,
              nbaCategoria: "aprender",
              nbaJustificativa: `A resposta gerada mencionava/ofertava "${MODULO_LABEL[modulo]}" sem que a pessoa tivesse pedido — bloqueada e substituída deterministicamente antes de sair do servidor, pois faltam os pré-requisitos.`,
              nivelConfianca: "alta",
            };
            break; // a resposta inteira já foi substituída — não há mais nada a checar nela.
          }
        }
      }
    }

    // ── Gate determinístico do catálogo Wix ───────────────────────────
    // O modelo nunca decide sozinho se há correspondência ou qual URL pode
    // sair. Zero/múltiplos/erro produzem texto controlado sem links. Para uma
    // correspondência única, toda URL diferente da URL Wix validada é removida.
    if (!eligibilityGateBlocked) {
      if (productGate.kind === "error") {
        fullResponse = "Não consegui consultar o catálogo da loja agora. Para não te passar um produto ou link incorreto, tente novamente em alguns instantes.";
        recommendedProductCandidate = null;
      } else if (productGate.kind === "empty") {
        fullResponse = "Esse produto não existe no catálogo publicado.";
        recommendedProductCandidate = null;
      } else if (productGate.kind === "ambiguous") {
        const options = productGate.products
          .map(product => `• ${product.name}${product.sku ? ` (SKU ${product.sku})` : ""}`)
          .join("\n");
        fullResponse = `Encontrei mais de um produto possível:\n\n${options}\n\nQual deles você quer ver?`;
        recommendedProductCandidate = null;
      } else if (productGate.kind === "single") {
        const product = productGate.product;
        if (!product.url) {
          fullResponse = `Encontrei o produto “${productGate.product.name}”, mas ele não tem uma página individual válida publicada na Wix. Para não te passar um link incorreto, não vou inventar um.`;
          recommendedProductCandidate = null;
        } else {
          const formatter = new Intl.NumberFormat("pt-BR", {
            style: "currency",
            currency: product.currency || "BRL",
          });
          const price = product.price == null
            ? null
            : product.priceMax != null && product.priceMax !== product.price
              ? `${formatter.format(product.price)} a ${formatter.format(product.priceMax)}`
              : formatter.format(product.price);
          fullResponse = [
            `Encontrei *${product.name}*.`,
            product.sku ? `SKU: ${product.sku}` : null,
            price ? `Preço na loja: ${price}` : null,
            getPublicProductFacts(product).availability === "indisponivel"
              ? "No momento, ele aparece como indisponível."
              : null,
            `Página do produto: ${product.url}`,
          ].filter(Boolean).join("\n");
          recommendedProductCandidate = product;
        }
      }
    }

    // ── Garantia determinística de entrega dos links de vídeo ─────────
    // Quando a tool recommendVideos retornou candidatos aprovados e o gate
    // de elegibilidade NÃO substituiu a resposta (ou seja, a resposta do
    // modelo é válida), verificamos se cada link aparece literalmente no
    // texto. Se algum estiver ausente (o modelo parafraseou, omitiu ou
    // só mencionou o título), injetamos os links que faltam ao final da
    // resposta de forma determinística, antes de qualquer byte sair do
    // servidor. Assim o registro em video_envios sempre reflete a
    // realidade: se a tool aprovou o vídeo, o link chega ao lead.
    if (recommendedVideoCandidates.length > 0 && !eligibilityGateBlocked) {
      const faltando = recommendedVideoCandidates.filter(v => !fullResponse.includes(v.link));
      if (faltando.length > 0) {
        const appendix = faltando
          .map(v => `\n\n📹 *${v.titulo}*\n${v.link}`)
          .join("");
        fullResponse += appendix;
        req.log.info(
          { videos: faltando.map(v => v.codigo) },
          "Links de vídeo injetados deterministicamente (modelo não os incluiu na geração)"
        );
      }
    }

    if (recommendedProductCandidate?.url && !eligibilityGateBlocked && !fullResponse.includes(recommendedProductCandidate.url)) {
      const price = recommendedProductCandidate.price == null
        ? ""
        : new Intl.NumberFormat("pt-BR", {
            style: "currency",
            currency: recommendedProductCandidate.currency || "BRL",
          }).format(recommendedProductCandidate.price);
      fullResponse += `\n\n🛍️ *${recommendedProductCandidate.name}*${price ? ` — ${price}` : ""}\n${recommendedProductCandidate.url}`;
      req.log.info(
        { productId: recommendedProductCandidate.id },
        "Link de produto Wix injetado deterministicamente"
      );
    }

    // Last-mile governance: model text is untrusted even when no commercial
    // tool was called. Never stream restricted commercial claims.
    const validatedWixOutput = Boolean(
      recommendedProductCandidate?.url && fullResponse.includes(recommendedProductCandidate.url),
    );
    if (shouldReplaceCommercialLeakage(hasCommercialLeakage(fullResponse), validatedWixOutput)) {
      fullResponse = "Essa informação comercial precisa ser confirmada pela nossa equipe. Vou te conectar com alguém para orientar com segurança.";
      finalHandoffSummary = await buildHandoffSummary({
        reason: "informacao_comercial_bloqueada", userMessage, pessoaId: pessoaId ?? null,
        pessoaNome: pessoaId ? resolvedNome : null, intencaoPrincipal, sensitiveContext: "final_text_commercial_leakage",
      });
      await db.update(conversationsTable).set({
        status: "aguardando_humano", handoffReason: "informacao_comercial_bloqueada",
        handoffSummary: JSON.stringify(finalHandoffSummary), handoffTriggeredAt: new Date(),
      }).where(eq(conversationsTable.id, conversationId));
      if (pendingDecision?.metadata) {
        pendingDecision.metadata = {
          ...pendingDecision.metadata,
          nba_code: "HANDOFF",
          result: "final_text_commercial_leakage",
          confidence: "low",
        };
      }
    }

    // A resposta (original, com links injetados, ou substituída pelo gate
    // acima) só é enviada ao cliente agora — nunca em tempo real durante a
    // geração — para que o gate de elegibilidade sempre rode antes de
    // qualquer byte sair do servidor. Reenviamos em pedaços pequenos só
    // para manter o efeito visual de streaming no cliente; o conteúdo já
    // está fixo e validado.
    for (let i = 0; i < fullResponse.length; i += 40) {
      res.write(`data: ${JSON.stringify({ content: fullResponse.slice(i, i + 40) })}\n\n`);
    }

    // Persist messages
    const [, assistantMsg] = await db.insert(messages).values([
      { conversationId, role: "user", content: userMessage, conduta: activeConduta },
      { conversationId, role: "assistant", content: fullResponse, conduta: activeConduta },
    ]).returning({ id: messages.id });

    if (pendingContentAsset) {
      await finalizeContentAsset(pendingContentAsset, {
        conversationId, messageId: assistantMsg?.id ?? null, pessoaId: pessoaId ?? null, finalText: fullResponse,
      });
    }

    // Registra os vídeos realmente enviados (ver tarefa "See which videos
    // Sofia actually sends to leads"): a tool pode ter retornado candidatos,
    // mas só valem os que sobreviveram aos gates de elegibilidade e aparecem
    // de fato no texto final — nunca confiamos apenas no retorno da tool,
    // pois a resposta pode ter sido substituída/bloqueada depois dela rodar.
    if (recommendedVideoCandidates.length > 0) {
      const respostaSemAcento = stripAccents(fullResponse);
      const enviados = recommendedVideoCandidates.filter(v =>
        fullResponse.includes(v.link) || respostaSemAcento.includes(stripAccents(v.titulo))
      );
      if (enviados.length > 0) {
        try {
          await db.insert(videoEnvios).values(enviados.map(v => ({
            conversationId,
            messageId: assistantMsg?.id ?? null,
            pessoaId: pessoaId ?? null,
            videoId: v.id,
            codigo: v.codigo,
            titulo: v.titulo,
            link: v.link,
            curso: v.curso,
            tipo: v.tipo,
          })));
        } catch (err) {
          req.log.warn({ err }, "Falha ao registrar envio de vídeo (video_envios)");
        }
      }
    }

    // decision_run desta rodada: se um gate estrutural (tool ou pós-geração)
    // já decidiu (pendingDecision), usamos isso — nunca a classificação do
    // modelo. Só quando NENHUM módulo com pré-requisito foi identificado
    // estruturalmente (nem por tool, nem na resposta) é que classificamos a
    // rodada com LLM, e mesmo assim a elegibilidade nunca vem do modelo:
    // sem sinal estrutural, ela é sempre "nao_avaliada" — o classificador só
    // preenche categoria/justificativa descritivas do NBA, nunca decide se a
    // pessoa é elegível para algo.
    if (pessoaId) {
      const decision = pendingDecision ?? {
        conduta: activeConduta, promptId: activePrompt?.id ?? null, model,
        ...(await classifyDecision({
          userMessage, assistantResponse: fullResponse, conduta: activeConduta, model: "gpt-5.4-mini",
        })),
        // Elegibilidade nunca é confiada ao classificador de texto livre —
        // só a checagem estrutural (getModulosConcluidos/checkModuleEligibility)
        // pode afirmar "elegivel"/"bloqueado". Sem sinal estrutural, fica
        // sempre "nao_avaliada" (Documento 14A: nunca decidir por afirmação
        // conversacional).
        elegibilidadeStatus: "nao_avaliada" as const,
      };
      await safeRecordDecisionRun({
        pessoaId, conversationId, messageId: assistantMsg?.id ?? null,
        ...decision,
      }, req.log);
    }

    // ── Gatilho de handoff (pós-resposta) ────────────────────────
    // Checado depois que a Sofia já respondeu: dispara por confiança baixa
    // persistente (o mesmo padrão de "não sei" já apareceu antes nesta
    // conversa). A resposta desta rodada já foi entregue normalmente — o
    // handoff só passa a valer a partir de agora, suspendendo rodadas futuras.
    const priorAssistantMessages = historyMessages.filter(m => m.role === "assistant").map(m => m.content);
    const postReason = detectPostTrigger(fullResponse, priorAssistantMessages);
    let postHandoffSummary: Awaited<ReturnType<typeof buildHandoffSummary>> | null = null;
    if (postReason) {
      postHandoffSummary = await buildHandoffSummary({
        reason: postReason,
        userMessage,
        pessoaId: pessoaId ?? null,
        pessoaNome: pessoaId ? resolvedNome : null,
        intencaoPrincipal,
        sensitiveContext: null,
      });
      const transitionMessage = handoffTransitionMessage(postReason);
      await db.update(conversationsTable)
        .set({
          status: "aguardando_humano",
          handoffReason: postReason,
          handoffSummary: JSON.stringify(postHandoffSummary),
          handoffTriggeredAt: new Date(),
        })
        .where(eq(conversationsTable.id, conversationId));
      const [postTriggerMsg] = await db.insert(messages)
        .values([{ conversationId, role: "assistant", content: transitionMessage, conduta: activeConduta }])
        .returning({ id: messages.id });
      res.write(`data: ${JSON.stringify({ content: "\n\n" + transitionMessage })}\n\n`);

      if (pessoaId) {
        await safeRecordDecisionRun({
          pessoaId, conversationId, messageId: postTriggerMsg?.id ?? null,
          conduta: activeConduta, promptId: activePrompt?.id ?? null, model,
          elegibilidadeStatus: "nao_avaliada",
          elegibilidadeMotivo: null,
          ofertaPrincipal: null, ofertaAlternativa: null,
          nbaCategoria: "conversar",
          nbaJustificativa: `Handoff pós-resposta (${postReason}) — padrão de baixa confiança detectado depois que a Sofia já respondeu; rodadas futuras ficam suspensas até um humano assumir.`,
          nivelConfianca: "media",
        }, req.log);
      }
    }

    res.write(`data: ${JSON.stringify({
      done: true, conversationId,
      ...(postReason ? { handoffTriggered: true, handoffReason: postReason, handoffSummary: postHandoffSummary } : {}),
      ...(finalHandoffSummary ? { handoffTriggered: true, handoffReason: "informacao_comercial_bloqueada", handoffSummary: finalHandoffSummary } : {}),
    })}\n\n`);

    // Background title generation on first exchange
    if (isFirstExchange) {
      const convIdForTitle = conversationId;
      void (async () => {
        try {
          const titleCompletion = await openai.chat.completions.create({
            model: "gpt-5.4-mini",
            max_completion_tokens: 30,
            messages: [
              {
                role: "system",
                content: "Você é um assistente que gera títulos curtos e descritivos. Responda APENAS com o título, sem pontuação final, sem aspas, sem explicação.",
              },
              {
                role: "user",
                content: `Crie um título de no máximo 8 palavras que descreva o assunto desta conversa.\n\nPergunta do usuário: ${userMessage}\n\nResposta do assistente: ${fullResponse.slice(0, 300)}`,
              },
            ],
          });
          const generatedTitle = titleCompletion.choices[0]?.message?.content?.trim();
          if (generatedTitle) {
            await db.update(conversationsTable)
              .set({ title: generatedTitle })
              .where(eq(conversationsTable.id, convIdForTitle));
          }
        } catch {
          // Title generation is best-effort
        }
      })();
    }
  } catch (err) {
    req.log.error({ err, model }, "Sofia chat completion failed");
    res.write(`data: ${JSON.stringify({
      error: "Não consegui gerar a resposta agora. Tente novamente em alguns instantes.",
      code: "SOFIA_COMPLETION_FAILED",
    })}\n\n`);
  }

  res.end();
});

export default router;
