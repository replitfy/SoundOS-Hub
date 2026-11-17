import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  db, pool, promptsTable, conversations, messages, canalContatos, canalEnvios, habllaEventos,
  type CanalEnvioStatus, type CanalExterno, type HabllaEventoStatus,
} from "@workspace/db";
import { DEFAULT_SOFIA_MODEL_ID } from "@workspace/sofia-models";
import type { Logger } from "pino";
import { logger } from "../lib/logger";
import { handleSimpleSofiaChat, type SimpleChatParams } from "./sofiaSimpleChat";
import { criarRespostaColetora } from "./sofiaRespostaColetora";
import { lerConfigHablla, type HabllaConfigEstado } from "./habllaConfig";
import { comTravaDaConversa } from "./conversationLock";
import { resolveSofiaMode } from "./conduta";
import {
  avisoDeArquivoJaEnviado, copiarAnexoRecebido, FRASE_DA_SOFIA_PARA_ARQUIVO, registrarMensagemComAnexo, type AnexoDoCanal,
} from "./anexosRecebidos";

// Pipeline comum dos canais externos da Sofia (Instagram e WhatsApp, ambos pelo Hablla): evento
// gravado → decide se responde → mesma Sofia do modo simples → resposta de volta pelo Hablla.
// Cada canal só entrega um adaptador (como ler o evento, como formatar o texto, qual chave liga a
// resposta). Fila por conversa, handoff, eco, auditoria e falhas visíveis são os mesmos para todos.
// Todo evento termina em respondido, ignorado (com motivo) ou falhou (com motivo).

export interface RespostaDaSofia {
  texto: string;
  erro: string | null;
  handoffAcionado: boolean;
}

export interface ProcessarEventoDeps {
  rodarSofia: (p: {
    conversationId: number;
    pessoaId: number | null;
    texto: string;
    /** A mensagem da pessoa já está gravada (arquivo com legenda): a Sofia usa esta em vez de gravar outra. */
    mensagemJaGravadaId?: number;
  }) => Promise<RespostaDaSofia>;
  enviar: (p: { para: string; texto: string }) => Promise<{ externoId: string | null }>;
  /**
   * Antes de a Sofia responder: prepara a ficha e o cartão da conversa (WhatsApp). Devolve a ficha que a conversa
   * deve usar, ou `null` para seguir como estava. Uma falha aqui nunca impede a resposta.
   */
  prepararConversa?: (p: { conversationId: number; texto: string; perfil: string | null }) => Promise<number | null>;
  lerConfig?: () => Promise<Partial<HabllaConfigEstado>>;
  modoSofia?: () => Promise<string>;
  log?: Logger;
  esperaTravaMs?: number;
  /** Copia o arquivo recebido para o armazenamento. Por padrão baixa do provedor; os testes trocam. */
  copiarAnexo?: (anexoId: number) => Promise<unknown>;
  agora?: () => Date;
}

export interface DesfechoEvento {
  status: Exclude<HabllaEventoStatus, "recebido">;
  motivo: string | null;
  conversationId: number | null;
}

/** Uma mensagem de cliente já interpretada pelo adaptador do canal. */
export interface MensagemDoCanal {
  /** Chave estável do contato no canal: uma conversa por chave (IGSID; telefone sem o 55). */
  contatoId: string;
  /** Para onde a resposta é enviada (no WhatsApp, o telefone com código do país). */
  destinatario: string;
  /** Texto da mensagem; num arquivo, a legenda (vazia quando não há). */
  texto: string;
  /** Arquivo recebido (WhatsApp). A Sofia não o interpreta: só a equipe vê. */
  anexo?: AnexoDoCanal;
  /** @usuário (Instagram) ou nome de perfil (WhatsApp); só exibição, nunca um nome confirmado. */
  usuario: string | null;
  titulo: string;
  canalUsuario: string | null;
}

export type DecisaoDoEvento =
  | { acao: "ignorar"; motivo: string }
  | { acao: "mensagem"; mensagem: MensagemDoCanal };

export interface AdaptadorDeCanal {
  canal: CanalExterno;
  /** Prefixo das mensagens de log. */
  rotulo: string;
  respondeLigado(config: Partial<HabllaConfigEstado>): boolean;
  interpretar(payload: unknown): Promise<DecisaoDoEvento> | DecisaoDoEvento;
  dividir(texto: string): string[];
  /** Estado do envio logo após o aceite do Hablla. */
  estadoAoEnviar: CanalEnvioStatus;
  /** Motivo curto e específico para um erro de envio (ex.: janela de 24h); `null` usa o texto do erro. */
  motivoDaFalhaDeEnvio?(erro: unknown): string | null;
  /**
   * O log recebe só o tipo e o código dos erros, nunca a mensagem: erros de banco e da API do Hablla
   * podem repetir o telefone ou o texto do cliente. A mensagem completa continua no registro de envio.
   */
  logSemDetalhesDoErro?: boolean;
  /**
   * Chamado depois de gravar cada envio. Os avisos de entrega podem chegar antes dessa gravação; aqui o
   * canal reaplica os que ficaram sem envio. Uma falha aqui nunca desfaz nem repete o envio.
   */
  aoRegistrarEnvio?(filaId: string): Promise<void>;
}

const JANELA_ECO_MS = 10 * 60 * 1000;
/** Qualquer envio que não falhou: a mensagem que volta igual é o nosso próprio eco. */
const ESTADOS_DE_ENVIO_FEITO: CanalEnvioStatus[] = ["aceito", "enviado", "entregue", "lido"];

function normalizarParaComparar(texto: string): string {
  return texto.replace(/\s+/g, " ").trim().toLowerCase();
}

async function modeloAtivo(): Promise<string> {
  const [ativo] = await db.select({ model: promptsTable.model }).from(promptsTable).where(eq(promptsTable.isActive, true)).limit(1);
  return ativo?.model ?? DEFAULT_SOFIA_MODEL_ID;
}

/** Uma conversa por contato do canal, mesmo com eventos simultâneos. */
export async function obterOuCriarConversa(canal: CanalExterno, mensagem: MensagemDoCanal): Promise<number> {
  const model = await modeloAtivo();
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`canal-contato:${canal}:${mensagem.contatoId}`}, 0))`);
    const [existente] = await tx.select({ id: canalContatos.id, conversationId: canalContatos.conversationId, usuario: canalContatos.usuario })
      .from(canalContatos)
      .where(and(eq(canalContatos.canal, canal), eq(canalContatos.contatoExternoId, mensagem.contatoId)))
      .limit(1);
    if (existente) {
      if (mensagem.usuario && mensagem.usuario !== existente.usuario) {
        await tx.update(canalContatos).set({ usuario: mensagem.usuario }).where(eq(canalContatos.id, existente.id));
        await tx.update(conversations).set({ canalUsuario: mensagem.canalUsuario, title: mensagem.titulo })
          .where(eq(conversations.id, existente.conversationId));
      }
      return existente.conversationId;
    }
    const [conversa] = await tx.insert(conversations).values({
      title: mensagem.titulo,
      model,
      canal,
      canalUsuario: mensagem.canalUsuario,
    }).returning({ id: conversations.id });
    await tx.insert(canalContatos).values({
      canal, contatoExternoId: mensagem.contatoId, usuario: mensagem.usuario, conversationId: conversa!.id,
    });
    return conversa!.id;
  });
}

async function conversaDoContato(canal: CanalExterno, contatoId: string): Promise<number | null> {
  const [linha] = await db.select({ conversationId: canalContatos.conversationId }).from(canalContatos)
    .where(and(eq(canalContatos.canal, canal), eq(canalContatos.contatoExternoId, contatoId))).limit(1);
  return linha?.conversationId ?? null;
}

function paraLog(adaptador: AdaptadorDeCanal, erro: unknown): Record<string, unknown> {
  if (!adaptador.logSemDetalhesDoErro) return { err: erro };
  const e = erro as { name?: unknown; codigo?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  return { erroTipo: e?.name, erroCodigo: e?.codigo ?? e?.code ?? e?.cause?.code };
}

/** A mensagem recebida repete uma resposta que acabamos de enviar? Então é eco, não cliente. */
async function ehEcoDeEnvioRecente(conversationId: number, texto: string): Promise<boolean> {
  const desde = new Date(Date.now() - JANELA_ECO_MS);
  const envios = await db.select({ texto: canalEnvios.texto }).from(canalEnvios)
    .where(and(
      eq(canalEnvios.conversationId, conversationId),
      inArray(canalEnvios.status, ESTADOS_DE_ENVIO_FEITO),
      gt(canalEnvios.createdAt, desde),
    ))
    .orderBy(desc(canalEnvios.createdAt)).limit(20);
  const alvo = normalizarParaComparar(texto);
  return envios.some(e => e.texto !== null && normalizarParaComparar(e.texto) === alvo);
}

async function registrarFalhaDeEntrega(
  canal: CanalExterno, conversationId: number, messageId: number | null, texto: string | null, erro: string,
): Promise<void> {
  await db.insert(canalEnvios).values({ conversationId, messageId, canal, texto, status: "falhou", erro: erro.slice(0, 500) });
}

export async function processarEventoDoCanal(
  eventoId: number, adaptador: AdaptadorDeCanal, deps: ProcessarEventoDeps,
): Promise<DesfechoEvento | null> {
  const { canal } = adaptador;
  const log = (deps.log ?? logger).child({ eventoId, canal });
  const lerConfig = deps.lerConfig ?? lerConfigHablla;
  const modoSofia = deps.modoSofia ?? resolveSofiaMode;

  const [evento] = await db.select().from(habllaEventos).where(eq(habllaEventos.id, eventoId)).limit(1);
  if (!evento || evento.status !== "recebido") return null;

  let conversationId: number | null = null;
  const concluir = async (
    status: DesfechoEvento["status"], motivo: string | null,
  ): Promise<DesfechoEvento> => {
    await db.update(habllaEventos)
      .set({ status, motivo, conversationId, processadoEm: new Date() })
      .where(and(eq(habllaEventos.id, eventoId), eq(habllaEventos.status, "recebido")));
    // O motivo pode trazer a mensagem de um erro depois dos dois pontos; nos canais sem detalhes no log, só o código.
    const motivoNoLog = adaptador.logSemDetalhesDoErro ? motivo?.split(":")[0] : motivo;
    log.info({ status, motivo: motivoNoLog, conversationId }, `${adaptador.rotulo}: evento concluído`);
    return { status, motivo, conversationId };
  };

  try {
    const decisao = await adaptador.interpretar(evento.payload);
    if (decisao.acao === "ignorar") return await concluir("ignorado", decisao.motivo);
    const recebida = decisao.mensagem;

    // Sofia desligada (chave ou modo): ela não responde, mas o que a pessoa envia a uma conversa que já existe
    // continua sendo registrado (texto e arquivo) para a equipe ver. Contato novo não cria conversa nenhuma.
    const config = await lerConfig();
    const semSofia: string | null = !adaptador.respondeLigado(config)
      ? "resposta_automatica_desligada"
      : (await modoSofia()) !== "simple" ? "modo_sofia_nao_suportado" : null;

    const existente = await conversaDoContato(canal, recebida.contatoId);
    if (semSofia !== null && existente === null) return await concluir("ignorado", semSofia);
    if (existente !== null) {
      conversationId = existente;
      if (recebida.texto !== "" && await ehEcoDeEnvioRecente(existente, recebida.texto)) return await concluir("ignorado", "eco_de_resposta_enviada");
    }

    conversationId = await obterOuCriarConversa(canal, recebida);
    const conversaId = conversationId;

    const copiarAnexo = deps.copiarAnexo ?? ((anexoId: number) => copiarAnexoRecebido(anexoId));
    const agora = deps.agora ?? (() => new Date());
    let copiaEmAndamento: Promise<unknown> = Promise.resolve();

    const desfecho = await comTravaDaConversa(conversaId, async () => {
      const [conversa] = await db.select({ status: conversations.status, pessoaId: conversations.pessoaId })
        .from(conversations).where(eq(conversations.id, conversaId)).limit(1);
      if (!conversa) return concluir("falhou", "conversa_nao_encontrada");

      // Arquivo: a mensagem (com a legenda) e o registro do anexo entram no mesmo fluxo de conversa dos textos.
      // O estado da conversa não muda e o arquivo nunca vai para a Sofia nem passa a conversa para a equipe.
      let mensagemDoArquivoId: number | null = null;
      if (recebida.anexo) {
        const registro = await registrarMensagemComAnexo({ conversationId: conversaId, legenda: recebida.texto, anexo: recebida.anexo });
        if (registro.duplicado) return concluir("ignorado", "anexo_duplicado");
        mensagemDoArquivoId = registro.messageId;
        if (registro.copia === "pendente") {
          copiaEmAndamento = Promise.resolve().then(() => copiarAnexo(registro.anexoId)).catch(erro => {
            log.warn(paraLog(adaptador, erro), `${adaptador.rotulo}: cópia do arquivo falhou`);
          });
        }
      }

      // Conversa com a equipe: a mensagem fica registrada e a Sofia não responde.
      if (conversa.status !== "ativa") {
        if (!recebida.anexo) await db.insert(messages).values({ conversationId: conversaId, role: "user", content: recebida.texto });
        const motivoDaEquipe = conversa.status === "aguardando_humano" ? "aguardando_equipe" : "atendimento_pela_equipe";
        return concluir("ignorado", recebida.anexo ? `anexo_${motivoDaEquipe}` : motivoDaEquipe);
      }

      // Conversa com a Sofia, mas a Sofia está desligada: fica registrado e nada é respondido nem enviado.
      if (semSofia !== null) {
        if (!recebida.anexo) await db.insert(messages).values({ conversationId: conversaId, role: "user", content: recebida.texto });
        return concluir("ignorado", semSofia);
      }

      // Conversa com a Sofia: ela avisa, com uma frase fixa (sem IA), que não vê arquivos. Uma tentativa, no
      // máximo uma a cada 30 minutos por conversa; falhou, a equipe vê o estado em Conversas e nada se repete.
      let avisoFalhou = false;
      let avisoEnviado = false;
      if (recebida.anexo) {
        if (!(await avisoDeArquivoJaEnviado(conversaId, agora()))) {
          const [aviso] = await db.insert(messages).values({
            conversationId: conversaId, role: "assistant", content: FRASE_DA_SOFIA_PARA_ARQUIVO, kind: "aviso_anexo",
          }).returning({ id: messages.id });
          try {
            const enviado = await deps.enviar({ para: recebida.destinatario, texto: FRASE_DA_SOFIA_PARA_ARQUIVO });
            await db.insert(canalEnvios).values({
              conversationId: conversaId, messageId: aviso!.id, canal, texto: FRASE_DA_SOFIA_PARA_ARQUIVO, status: adaptador.estadoAoEnviar,
              externoId: enviado.externoId, filaId: enviado.externoId,
            });
            avisoEnviado = true;
            if (enviado.externoId && adaptador.aoRegistrarEnvio) {
              await adaptador.aoRegistrarEnvio(enviado.externoId).catch(erroDaReconciliacao => {
                log.warn(paraLog(adaptador, erroDaReconciliacao), `${adaptador.rotulo}: não consegui reaplicar avisos de entrega pendentes`);
              });
            }
          } catch (error) {
            avisoFalhou = true;
            const detalhe = error instanceof Error ? error.message : String(error);
            log.warn({ ...paraLog(adaptador, error), conversationId: conversaId }, `${adaptador.rotulo}: aviso de arquivo não enviado`);
            await registrarFalhaDeEntrega(canal, conversaId, aviso!.id, FRASE_DA_SOFIA_PARA_ARQUIVO, detalhe);
          }
        }
        // Sem legenda não há nada para a Sofia responder.
        if (recebida.texto === "") {
          if (avisoFalhou) return concluir("falhou", "aviso_de_arquivo_falhou");
          return concluir(avisoEnviado ? "respondido" : "ignorado", avisoEnviado ? "anexo_aviso_enviado" : "anexo_recebido");
        }
      }

      let pessoaDaConversa = conversa.pessoaId;
      if (deps.prepararConversa) {
        try {
          pessoaDaConversa = (await deps.prepararConversa({ conversationId: conversaId, texto: recebida.texto, perfil: recebida.usuario })) ?? pessoaDaConversa;
        } catch (erro) {
          log.warn(paraLog(adaptador, erro), `${adaptador.rotulo}: preparo da conversa falhou`);
        }
      }

      const sofia = await deps.rodarSofia({
        conversationId: conversaId, pessoaId: pessoaDaConversa, texto: recebida.texto,
        ...(mensagemDoArquivoId !== null ? { mensagemJaGravadaId: mensagemDoArquivoId } : {}),
      });
      if (sofia.erro || !sofia.texto) {
        await registrarFalhaDeEntrega(canal, conversaId, null, null, "A Sofia não conseguiu gerar a resposta.");
        return concluir("falhou", `sofia_falhou: ${sofia.erro ?? "resposta vazia"}`.slice(0, 300));
      }

      const [ultimaDaSofia] = await db.select({ id: messages.id }).from(messages)
        .where(and(eq(messages.conversationId, conversaId), eq(messages.role, "assistant")))
        .orderBy(desc(messages.id)).limit(1);
      const messageId = ultimaDaSofia?.id ?? null;

      for (const parte of adaptador.dividir(sofia.texto)) {
        try {
          const enviado = await deps.enviar({ para: recebida.destinatario, texto: parte });
          await db.insert(canalEnvios).values({
            conversationId: conversaId, messageId, canal, texto: parte, status: adaptador.estadoAoEnviar,
            externoId: enviado.externoId, filaId: enviado.externoId,
          });
          if (enviado.externoId && adaptador.aoRegistrarEnvio) {
            await adaptador.aoRegistrarEnvio(enviado.externoId).catch(erroDaReconciliacao => {
              log.warn(paraLog(adaptador, erroDaReconciliacao), `${adaptador.rotulo}: não consegui reaplicar avisos de entrega pendentes`);
            });
          }
        } catch (error) {
          const detalhe = error instanceof Error ? error.message : String(error);
          log.warn({ ...paraLog(adaptador, error), conversationId: conversaId }, `${adaptador.rotulo}: envio falhou`);
          await registrarFalhaDeEntrega(canal, conversaId, messageId, parte, detalhe);
          const motivo = adaptador.motivoDaFalhaDeEnvio?.(error);
          return concluir("falhou", (motivo ?? `envio_falhou: ${detalhe}`).slice(0, 300));
        }
      }
      return concluir("respondido", sofia.handoffAcionado ? "passou_para_equipe" : null);
    }, deps.esperaTravaMs);
    // A cópia do arquivo roda em segundo plano, fora da trava da conversa; o desfecho do evento não espera por ela.
    await copiaEmAndamento;
    return desfecho;
  } catch (error) {
    log.error(paraLog(adaptador, error), `${adaptador.rotulo}: erro ao processar evento`);
    const detalhe = error instanceof Error ? error.message : String(error);
    // A conversa ficou sem resposta: a equipe precisa ver isso na lista de Conversas.
    if (conversationId !== null) {
      await registrarFalhaDeEntrega(canal, conversationId, null, null, "A Sofia não respondeu (erro interno).").catch(() => undefined);
    }
    return concluir("falhou", `erro_interno: ${detalhe}`.slice(0, 300));
  }
}

/** Roda a Sofia do modo simples (mesmo motor do chat) e devolve só o texto final. */
export function criarRodarSofiaSimples(
  buscarConhecimento: SimpleChatParams["searchKnowledge"],
  canal: CanalExterno = "instagram",
): ProcessarEventoDeps["rodarSofia"] {
  return async ({ conversationId, pessoaId, texto, mensagemJaGravadaId }) => {
    const [promptAtivo] = await db.select().from(promptsTable).where(eq(promptsTable.isActive, true)).limit(1);
    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM knowledge_items WHERE index_status = 'indexed'",
    );
    const coletora = criarRespostaColetora(logger.child({ canal, conversationId }));
    await handleSimpleSofiaChat({
      req: coletora.req,
      res: coletora.res,
      userMessage: texto,
      ...(mensagemJaGravadaId !== undefined ? { mensagemJaGravadaId } : {}),
      conversationId,
      directPessoaId: pessoaId,
      rawNome: null,
      rawCelular: null,
      // O Instagram segue sem aviso de canal: só o WhatsApp precisa de regras de formatação.
      canal: canal === "whatsapp" ? "whatsapp" : undefined,
      activePrompt: promptAtivo ? { id: promptAtivo.id, body: promptAtivo.body, model: promptAtivo.model } : null,
      model: promptAtivo?.model ?? DEFAULT_SOFIA_MODEL_ID,
      hasKnowledge: Number.parseInt(rows[0]?.count ?? "0", 10) > 0,
      searchKnowledge: buscarConhecimento,
    });
    const resultado = coletora.resultado();
    return {
      texto: resultado.texto,
      erro: resultado.erro ? resultado.erro.mensagem : (resultado.concluida ? null : "resposta incompleta"),
      handoffAcionado: resultado.handoffAcionado,
    };
  };
}
