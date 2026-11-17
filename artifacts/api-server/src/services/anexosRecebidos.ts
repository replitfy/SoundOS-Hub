import { createHash } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { and, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { db, mensagemAnexos, messages, type AnexoCopia, type AnexoTipo } from "@workspace/db";
import { logger } from "../lib/logger";
import { armazenamentoDeAnexos, novaChaveDeAnexo, type ArmazenamentoDeAnexos } from "./anexosArmazenamento";
import {
  BYTES_PARA_RECONHECER, LIMITE_DE_RECEBIMENTO, mimeAceitoParaOTipo, mimeBase, nomeSeguroDoArquivo, reconhecerConteudo,
  type MotivoDeIndisponibilidade, type MotivoDeRecusa,
} from "./anexosConteudo";

// Arquivos que a pessoa manda pelo WhatsApp. A notificação traz uma URL permanente do arquivo (a Astenir
// já copiou do provedor da Meta para o próprio armazenamento); aqui ela é tratada como não confiável:
// só endereço https de um host do provedor, sem redirecionar para fora, com limite de tempo e de tamanho,
// e o conteúdo é conferido pelos primeiros bytes. Qualquer dúvida recusa o arquivo (nunca o exibe).
// Nada neste módulo escreve telefone, nome de arquivo, legenda, endereço ou mensagem de erro do provedor no log.

export const FRASE_DA_SOFIA_PARA_ARQUIVO =
  "Recebi seu arquivo, mas não consigo ver imagens, vídeos, áudios nem documentos. Já avisei a equipe, que vai olhar. Se puder, escreva aqui o que você precisa.";
/** No máximo um aviso destes por conversa nesta janela, para não repetir a cada foto. */
export const JANELA_DO_AVISO_DE_ARQUIVO_MS = 30 * 60 * 1000;
/** Uma cópia "pendente" há mais tempo que isto foi interrompida (reinício do servidor): conta como indisponível. */
export const COPIA_PENDENTE_EXPIRA_MS = 10 * 60 * 1000;
const TEMPO_DA_COPIA_MS = 60_000;
const MAXIMO_DE_REDIRECIONAMENTOS = 3;

export interface AnexoDoCanal {
  tipo: AnexoTipo;
  mimeDeclarado: string | null;
  sha256: string | null;
  url: string | null;
  nome: string | null;
  metaId: string | null;
}

export interface DepsDeCopia {
  fetch?: typeof fetch;
  armazenamento?: ArmazenamentoDeAnexos;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class FalhaDeAnexo extends Error {
  constructor(
    public readonly estado: "recusado" | "indisponivel",
    public readonly motivo: MotivoDeRecusa | MotivoDeIndisponibilidade,
  ) {
    super(`anexo ${estado}: ${motivo}`);
    this.name = "FalhaDeAnexo";
  }
}

// ── Endereço do provedor ─────────────────────────────────────────────────────

const HOSTS_DO_PROVEDOR = ["storage.googleapis.com", "storage.cloud.google.com", "cdn.astenir.com"];
const SUFIXOS_DO_PROVEDOR = [".storage.googleapis.com", ".astenir.com", ".astenir.io"];

/** Só https, sem usuário/senha, porta padrão e um host do provedor (ou listado em HABLLA_MIDIA_HOSTS). */
export function enderecoDoProvedor(bruto: string, env: NodeJS.ProcessEnv = process.env): URL | null {
  let url: URL;
  try { url = new URL(bruto); } catch { return null; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || (url.port !== "" && url.port !== "443")) return null;
  const host = url.hostname.toLowerCase();
  const extras = (env.HABLLA_MIDIA_HOSTS ?? "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
  const permitido = HOSTS_DO_PROVEDOR.includes(host) || extras.includes(host)
    || SUFIXOS_DO_PROVEDOR.some(sufixo => host.endsWith(sufixo));
  return permitido ? url : null;
}

// ── Registro da mensagem com anexo ───────────────────────────────────────────

const EXTENSAO_PELO_MIME: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/3gpp": "3gp",
  "audio/aac": "aac", "audio/amr": "amr", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg",
  "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv",
};

export interface AvaliacaoDoAnexo {
  copia: Extract<AnexoCopia, "pendente" | "recusado" | "indisponivel">;
  motivo: MotivoDeRecusa | MotivoDeIndisponibilidade | null;
}

/** Confere o que dá para conferir antes de baixar: formato declarado e endereço. */
export function avaliarAnexoRecebido(anexo: AnexoDoCanal, env: NodeJS.ProcessEnv = process.env): AvaliacaoDoAnexo {
  if (!mimeAceitoParaOTipo(anexo.tipo, mimeBase(anexo.mimeDeclarado))) return { copia: "recusado", motivo: "tipo_nao_permitido" };
  if (anexo.url === null) return { copia: "indisponivel", motivo: "sem_endereco" };
  if (enderecoDoProvedor(anexo.url, env) === null) return { copia: "recusado", motivo: "endereco_nao_confiavel" };
  return { copia: "pendente", motivo: null };
}

export type RegistroDeAnexoRecebido =
  | { duplicado: true }
  | { duplicado: false; messageId: number; anexoId: number; copia: AnexoCopia };

function erroDeChaveDuplicada(erro: unknown): boolean {
  const e = erro as { code?: string; cause?: { code?: string } } | null;
  return (e?.cause?.code ?? e?.code) === "23505";
}

/**
 * Grava a mensagem da pessoa (role "user", kind "anexo", legenda no content) e o registro do arquivo na
 * mesma transação. A mesma notificação duas vezes não duplica nada.
 */
export async function registrarMensagemComAnexo(input: {
  conversationId: number;
  legenda: string;
  anexo: AnexoDoCanal;
  env?: NodeJS.ProcessEnv;
}): Promise<RegistroDeAnexoRecebido> {
  const avaliacao = avaliarAnexoRecebido(input.anexo, input.env);
  const { anexo } = input;
  if (anexo.metaId !== null) {
    const [existente] = await db.select({ id: mensagemAnexos.id }).from(mensagemAnexos)
      .where(and(eq(mensagemAnexos.direcao, "recebido"), eq(mensagemAnexos.externoId, anexo.metaId))).limit(1);
    if (existente) return { duplicado: true };
  }
  const mimeDeclarado = mimeBase(anexo.mimeDeclarado);
  const nome = anexo.tipo === "document" && anexo.nome !== null
    ? nomeSeguroDoArquivo(anexo.nome, "document", EXTENSAO_PELO_MIME[mimeDeclarado ?? ""] ?? "bin")
    : null;
  try {
    return await db.transaction(async tx => {
      const [mensagem] = await tx.insert(messages).values({
        conversationId: input.conversationId, role: "user", content: input.legenda, kind: "anexo",
      }).returning({ id: messages.id });
      const [registro] = await tx.insert(mensagemAnexos).values({
        messageId: mensagem!.id,
        conversationId: input.conversationId,
        direcao: "recebido",
        tipo: anexo.tipo,
        nome,
        mimeType: mimeDeclarado,
        sha256: anexo.sha256,
        copia: avaliacao.copia,
        motivo: avaliacao.motivo,
        // O endereço só fica guardado enquanto a cópia ainda pode ser tentada.
        urlOrigem: avaliacao.copia === "recusado" ? null : anexo.url,
        externoId: anexo.metaId,
      }).returning({ id: mensagemAnexos.id });
      return { duplicado: false as const, messageId: mensagem!.id, anexoId: registro!.id, copia: avaliacao.copia };
    });
  } catch (erro) {
    if (erroDeChaveDuplicada(erro)) return { duplicado: true };
    throw erro;
  }
}

// ── Cópia para o armazenamento ───────────────────────────────────────────────

/** Conta bytes, calcula o hash e guarda o começo do arquivo; interrompe ao passar do limite. */
class Medidor extends Transform {
  bytes = 0;
  private readonly hash = createHash("sha256");
  private readonly partesDoInicio: Buffer[] = [];
  private tamanhoDoInicio = 0;

  constructor(private readonly limite: number) { super(); }

  override _transform(pedaco: Buffer, _codificacao: BufferEncoding, proximo: TransformCallback): void {
    this.bytes += pedaco.length;
    if (this.bytes > this.limite) { proximo(new FalhaDeAnexo("recusado", "tamanho_excedido")); return; }
    this.hash.update(pedaco);
    if (this.tamanhoDoInicio < BYTES_PARA_RECONHECER) {
      const parte = pedaco.subarray(0, BYTES_PARA_RECONHECER - this.tamanhoDoInicio);
      this.partesDoInicio.push(parte);
      this.tamanhoDoInicio += parte.length;
    }
    proximo(null, pedaco);
  }

  get inicio(): Buffer { return Buffer.concat(this.partesDoInicio); }
  get sha256(): string { return this.hash.copy().digest("hex"); }
}

async function abrirOrigem(inicial: URL, deps: Required<Pick<DepsDeCopia, "fetch" | "env">>, sinal: AbortSignal): Promise<Response> {
  let url = inicial;
  for (let salto = 0; salto <= MAXIMO_DE_REDIRECIONAMENTOS; salto += 1) {
    let resposta: Response;
    try {
      resposta = await deps.fetch(url.toString(), { method: "GET", redirect: "manual", signal: sinal, headers: { accept: "*/*" } });
    } catch {
      throw new FalhaDeAnexo("indisponivel", sinal.aborted ? "tempo_esgotado" : "download_falhou");
    }
    if (resposta.status >= 300 && resposta.status < 400) {
      const destino = resposta.headers.get("location");
      await resposta.body?.cancel().catch(() => undefined);
      const proximo = destino ? enderecoDoProvedor(new URL(destino, url).toString(), deps.env) : null;
      if (proximo === null) throw new FalhaDeAnexo("recusado", "endereco_nao_confiavel");
      url = proximo;
      continue;
    }
    if (!resposta.ok || !resposta.body) {
      await resposta.body?.cancel().catch(() => undefined);
      throw new FalhaDeAnexo("indisponivel", "provedor_recusou");
    }
    return resposta;
  }
  throw new FalhaDeAnexo("recusado", "endereco_nao_confiavel");
}

async function baixarEGuardar(
  anexo: { id: number; conversationId: number; tipo: AnexoTipo; urlOrigem: string | null; sha256: string | null; nome: string | null },
  deps: DepsDeCopia,
): Promise<{ chave: string; bytes: number; mime: string; nome: string }> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? fetch;
  const armazenamento = deps.armazenamento ?? armazenamentoDeAnexos();
  if (anexo.urlOrigem === null) throw new FalhaDeAnexo("indisponivel", "sem_endereco");
  const origem = enderecoDoProvedor(anexo.urlOrigem, env);
  if (origem === null) throw new FalhaDeAnexo("recusado", "endereco_nao_confiavel");
  const limite = LIMITE_DE_RECEBIMENTO[anexo.tipo];

  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), deps.timeoutMs ?? TEMPO_DA_COPIA_MS);
  const chave = novaChaveDeAnexo(anexo.conversationId);
  let gravou = false;
  try {
    const resposta = await abrirOrigem(origem, { fetch: doFetch, env }, controle.signal);
    const declarado = Number(resposta.headers.get("content-length"));
    if (Number.isFinite(declarado) && declarado > limite) throw new FalhaDeAnexo("recusado", "tamanho_excedido");

    const fonte = Readable.fromWeb(resposta.body as never);
    let falhouNaFonte = false;
    fonte.once("error", () => { falhouNaFonte = true; });
    const medidor = new Medidor(limite);
    fonte.pipe(medidor);
    fonte.once("error", erro => medidor.destroy(erro));
    try {
      await armazenamento.gravar(chave, medidor, "application/octet-stream");
      gravou = true;
    } catch (erro) {
      if (erro instanceof FalhaDeAnexo) throw erro;
      if (controle.signal.aborted) throw new FalhaDeAnexo("indisponivel", "tempo_esgotado");
      throw new FalhaDeAnexo("indisponivel", falhouNaFonte ? "download_falhou" : "armazenamento_falhou");
    }

    if (medidor.bytes === 0) throw new FalhaDeAnexo("recusado", "arquivo_vazio");
    const conteudo = reconhecerConteudo(medidor.inicio, anexo.nome);
    if (conteudo === null || conteudo.tipo !== anexo.tipo || !mimeAceitoParaOTipo(conteudo.tipo, conteudo.mime)) {
      throw new FalhaDeAnexo("recusado", "conteudo_nao_confere");
    }
    if (anexo.sha256 !== null && anexo.sha256 !== medidor.sha256) throw new FalhaDeAnexo("recusado", "hash_diferente");
    return {
      chave,
      bytes: medidor.bytes,
      mime: conteudo.mime,
      nome: nomeSeguroDoArquivo(anexo.nome, anexo.tipo, conteudo.extensao),
    };
  } catch (erro) {
    if (gravou) await armazenamento.apagar(chave).catch(() => undefined);
    throw erro instanceof FalhaDeAnexo ? erro : new FalhaDeAnexo("indisponivel", "download_falhou");
  } finally {
    clearTimeout(timer);
    controle.abort();
  }
}

/**
 * Copia o arquivo recebido para o armazenamento do projeto e atualiza o registro: copiado, recusado (nunca
 * será baixado) ou indisponível (dá para a equipe pedir nova tentativa). Nunca lança: o resultado fica no registro.
 */
export async function copiarAnexoRecebido(anexoId: number, deps: DepsDeCopia = {}): Promise<AnexoCopia> {
  const [anexo] = await db.select().from(mensagemAnexos)
    .where(and(eq(mensagemAnexos.id, anexoId), eq(mensagemAnexos.direcao, "recebido"), eq(mensagemAnexos.copia, "pendente"))).limit(1);
  if (!anexo) return "recusado";
  try {
    const guardado = await baixarEGuardar(anexo, deps);
    const [atualizado] = await db.update(mensagemAnexos).set({
      copia: "copiado", motivo: null, storageKey: guardado.chave, tamanhoBytes: guardado.bytes, mimeType: guardado.mime,
      nome: guardado.nome, urlOrigem: null, updatedAt: new Date(),
    }).where(and(eq(mensagemAnexos.id, anexoId), eq(mensagemAnexos.copia, "pendente"))).returning({ id: mensagemAnexos.id });
    if (!atualizado) await (deps.armazenamento ?? armazenamentoDeAnexos()).apagar(guardado.chave).catch(() => undefined);
    return "copiado";
  } catch (erro) {
    const falha = erro instanceof FalhaDeAnexo ? erro : new FalhaDeAnexo("indisponivel", "download_falhou");
    logger.warn({ anexoId, estado: falha.estado, motivo: falha.motivo }, "anexo recebido: cópia não concluída");
    await db.update(mensagemAnexos).set({
      copia: falha.estado,
      motivo: falha.motivo,
      urlOrigem: falha.estado === "recusado" ? null : anexo.urlOrigem,
      updatedAt: new Date(),
    }).where(and(eq(mensagemAnexos.id, anexoId), eq(mensagemAnexos.copia, "pendente")));
    return falha.estado;
  }
}

/**
 * A equipe pede nova tentativa de cópia de um arquivo indisponível (ou de uma cópia interrompida). Só um
 * pedido vence: a linha vira "pendente" de forma atômica. Não envia nada à pessoa.
 */
export async function reivindicarNovaCopia(anexoId: number, conversationId: number, agora: Date = new Date()): Promise<boolean> {
  const limite = new Date(agora.getTime() - COPIA_PENDENTE_EXPIRA_MS);
  const [linha] = await db.update(mensagemAnexos).set({ copia: "pendente", motivo: null, updatedAt: agora })
    .where(and(
      eq(mensagemAnexos.id, anexoId),
      eq(mensagemAnexos.conversationId, conversationId),
      eq(mensagemAnexos.direcao, "recebido"),
      sql`${mensagemAnexos.urlOrigem} IS NOT NULL`,
      or(eq(mensagemAnexos.copia, "indisponivel"), and(eq(mensagemAnexos.copia, "pendente"), lt(mensagemAnexos.updatedAt, limite))),
    )).returning({ id: mensagemAnexos.id });
  return linha !== undefined;
}

/** A frase fixa da Sofia já foi usada nesta conversa há menos de 30 minutos? (Conta toda tentativa, inclusive a que falhou.) */
export async function avisoDeArquivoJaEnviado(conversationId: number, agora: Date): Promise<boolean> {
  const desde = new Date(agora.getTime() - JANELA_DO_AVISO_DE_ARQUIVO_MS);
  const [linha] = await db.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.kind, "aviso_anexo"), gt(messages.createdAt, desde)))
    .orderBy(desc(messages.id)).limit(1);
  return linha !== undefined;
}
