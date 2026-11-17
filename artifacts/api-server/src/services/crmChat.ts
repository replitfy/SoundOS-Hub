import { and, desc, eq, inArray } from "drizzle-orm";
import { db, commercialOpportunities, conversations, messages, canalEnvios, usersTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { enviarMensagemWhatsapp, HabllaErro, type HabllaClientDeps } from "./habllaClient";
import { OpportunityRuleError, type OpportunityActor } from "./commercialOpportunities";
import { comTravaDaConversa, ConversaOcupadaErro } from "./conversationLock";
import { carregarEstadoDeContato, comTravaDeContato, pessoaTemCartaoSemContato, type EstadoDeContato } from "./contatoAutorizacao";
import {
  carregarPessoaDeContato, confirmarVinculoDaConversa, listarFichasAtivasComTelefone, localizarConversaWhatsapp,
  type FichaComMesmoTelefone, type VinculoDaConversa,
} from "./conversaWhatsappDaPessoa";
import { celularInformadoNaoGravado } from "./identidadeConferencia";
import { listarMensagensDaConversa } from "./conversaMensagens";
import { exigirHumano, registrarAcao, textoObrigatorio, travarOportunidadeAberta } from "./crmAtendimento";
import { reconciliarEntrega } from "./entregaWhatsapp";
import { esperadoDoAmbiente } from "./sofiaCanalWhatsapp";

// Conversa de WhatsApp dentro do cartão do CRM. Texto livre só dentro da janela de 24h (contada da última
// mensagem da pessoa), só com o atendimento assumido pela equipe (a Sofia fica em silêncio) e nunca para
// quem pediu para não receber. Uma tentativa de envio por mensagem: falhou, a equipe vê e decide.

export const JANELA_24H_MS = 24 * 60 * 60 * 1000;
export const LIMITE_MENSAGEM_DA_EQUIPE = 4_000;
export const ESPERA_TRAVA_CONVERSA_MS = 15_000;

export type BloqueioDeTexto =
  | "sem_conversa" | "vinculo_a_confirmar" | "conversa_bloqueada" | "atendimento_nao_assumido"
  | "janela_fechada" | "nao_quer_receber" | "cartao_encerrado";

export interface ChatDoCartao {
  pessoaId: number;
  vinculo: VinculoDaConversa;
  /** Só quando o vínculo está bloqueado por telefone repetido: as fichas ativas com o número, para unir ou escolher. */
  fichasComMesmoTelefone: FichaComMesmoTelefone[];
  /** Só com a ficha sem telefone: o formulário informou um celular que não foi gravado por pertencer a outras fichas. */
  celularInformadoNaoGravado: boolean;
  conversa: { id: number; status: string } | null;
  mensagens: Awaited<ReturnType<typeof listarMensagensDaConversa>>;
  /** Fim da janela de 24h; `null` se a pessoa nunca escreveu. Já passou = janela fechada. */
  janelaAte: Date | null;
  janelaAberta: boolean;
  contato: Pick<EstadoDeContato, "autorizado" | "naoQuerReceber">;
  podeEnviarTexto: boolean;
  bloqueiosDeTexto: BloqueioDeTexto[];
}

async function cartao(opportunityId: number) {
  const [linha] = await db.select({
    id: commercialOpportunities.id, pessoaId: commercialOpportunities.pessoaId, stage: commercialOpportunities.stage,
  }).from(commercialOpportunities).where(eq(commercialOpportunities.id, opportunityId)).limit(1);
  if (!linha) throw new OpportunityRuleError("Oportunidade não encontrada.", "NOT_FOUND", 404);
  return linha;
}

/** Última mensagem da pessoa na conversa (role "user"): é dela que se conta a janela. */
async function ultimaMensagemDaPessoa(conversationId: number): Promise<Date | null> {
  const [linha] = await db.select({ createdAt: messages.createdAt }).from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user")))
    .orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
  return linha?.createdAt ?? null;
}

export async function carregarChat(opportunityId: number, agora: Date = new Date()): Promise<ChatDoCartao> {
  const card = await cartao(opportunityId);
  const pessoa = await carregarPessoaDeContato(card.pessoaId);
  if (!pessoa) throw new OpportunityRuleError("Pessoa não encontrada.", "PERSON_NOT_FOUND", 404);
  const vinculo = await localizarConversaWhatsapp(pessoa);
  const fichasComMesmoTelefone = vinculo.tipo === "bloqueada" && vinculo.motivo === "telefone_em_varias_fichas"
    ? await listarFichasAtivasComTelefone(pessoa.celular)
    : [];
  const celularNaoGravado = vinculo.tipo === "bloqueada" && vinculo.motivo === "sem_telefone"
    ? await celularInformadoNaoGravado(card.pessoaId)
    : false;
  const contato = await carregarEstadoDeContato(card.pessoaId);
  const cartaoSemContato = await pessoaTemCartaoSemContato(card.pessoaId);

  let conversa: ChatDoCartao["conversa"] = null;
  let mensagens: ChatDoCartao["mensagens"] = [];
  let ultimaDaPessoa: Date | null = null;
  // Conversa "a confirmar" ainda não é desta ficha: o conteúdo só aparece depois da confirmação.
  if (vinculo.tipo === "vinculada") {
    const [c] = await db.select({ id: conversations.id, status: conversations.status }).from(conversations)
      .where(eq(conversations.id, vinculo.conversationId)).limit(1);
    if (c) {
      conversa = c;
      mensagens = await listarMensagensDaConversa(c.id);
      ultimaDaPessoa = await ultimaMensagemDaPessoa(c.id);
    }
  }
  const janelaAte = ultimaDaPessoa ? new Date(ultimaDaPessoa.getTime() + JANELA_24H_MS) : null;
  const janelaAberta = janelaAte !== null && janelaAte.getTime() > agora.getTime();

  const bloqueios: BloqueioDeTexto[] = [];
  if (card.stage === "CLOSED") bloqueios.push("cartao_encerrado");
  if (vinculo.tipo === "nenhuma") bloqueios.push("sem_conversa");
  else if (vinculo.tipo === "a_confirmar") bloqueios.push("vinculo_a_confirmar");
  else if (vinculo.tipo === "bloqueada") bloqueios.push("conversa_bloqueada");
  else {
    if (conversa && conversa.status !== "atendimento_humano") bloqueios.push("atendimento_nao_assumido");
    if (!janelaAberta) bloqueios.push("janela_fechada");
  }
  if (contato.naoQuerReceber || cartaoSemContato) bloqueios.push("nao_quer_receber");

  return {
    pessoaId: card.pessoaId,
    vinculo,
    fichasComMesmoTelefone,
    celularInformadoNaoGravado: celularNaoGravado,
    conversa,
    mensagens,
    janelaAte,
    janelaAberta,
    contato: { autorizado: contato.autorizado, naoQuerReceber: contato.naoQuerReceber },
    podeEnviarTexto: bloqueios.length === 0,
    bloqueiosDeTexto: bloqueios,
  };
}

export interface ConversaDaPessoa {
  pessoaId: number;
  vinculo: VinculoDaConversa;
  conversa: { id: number; status: string } | null;
  mensagens: Awaited<ReturnType<typeof listarMensagensDaConversa>>;
}

/** Conversa de WhatsApp da pessoa, só para leitura (ficha). Conversa "a confirmar" ainda não é desta ficha: sem conteúdo. */
export async function carregarConversaDaPessoa(pessoaId: number): Promise<ConversaDaPessoa> {
  const pessoa = await carregarPessoaDeContato(pessoaId);
  if (!pessoa) throw new OpportunityRuleError("Pessoa não encontrada.", "PERSON_NOT_FOUND", 404);
  const vinculo = await localizarConversaWhatsapp(pessoa);
  if (vinculo.tipo !== "vinculada") return { pessoaId, vinculo, conversa: null, mensagens: [] };
  const [conversa] = await db.select({ id: conversations.id, status: conversations.status }).from(conversations)
    .where(eq(conversations.id, vinculo.conversationId)).limit(1);
  if (!conversa) return { pessoaId, vinculo, conversa: null, mensagens: [] };
  return { pessoaId, vinculo, conversa, mensagens: await listarMensagensDaConversa(conversa.id) };
}

export async function conversaVinculadaDoCartao(opportunityId: number): Promise<{ pessoaId: number; conversationId: number }> {
  const card = await cartao(opportunityId);
  const pessoa = await carregarPessoaDeContato(card.pessoaId);
  if (!pessoa) throw new OpportunityRuleError("Pessoa não encontrada.", "PERSON_NOT_FOUND", 404);
  const vinculo = await localizarConversaWhatsapp(pessoa);
  if (vinculo.tipo !== "vinculada") {
    throw new OpportunityRuleError("Este cartão ainda não tem uma conversa de WhatsApp vinculada.", "CONVERSATION_NOT_LINKED", 409);
  }
  return { pessoaId: card.pessoaId, conversationId: vinculo.conversationId };
}

export function ocupada(erro: unknown): never {
  if (erro instanceof ConversaOcupadaErro) {
    throw new OpportunityRuleError("A conversa está ocupada com uma resposta da Sofia. Tente de novo em instantes.", "CONVERSATION_BUSY", 409);
  }
  throw erro;
}

/** A equipe assume a conversa: a Sofia fica em silêncio nela. Vale também quando a Sofia ainda atendia. */
export async function assumirConversa(input: { opportunityId: number; actor: OpportunityActor }): Promise<{ conversationId: number; status: string }> {
  exigirHumano(input.actor);
  const { conversationId } = await conversaVinculadaDoCartao(input.opportunityId);
  try {
    return await comTravaDaConversa(conversationId, async () => db.transaction(async (tx) => {
      await travarOportunidadeAberta(tx, input.opportunityId);
      const [antes] = await tx.select({ status: conversations.status }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
      if (!antes) throw new OpportunityRuleError("Conversa não encontrada.", "NOT_FOUND", 404);
      if (antes.status === "atendimento_humano") return { conversationId, status: antes.status };
      await tx.update(conversations).set({ status: "atendimento_humano" })
        .where(and(eq(conversations.id, conversationId), inArray(conversations.status, ["ativa", "aguardando_humano"])));
      await registrarAcao(tx, input.opportunityId, input.actor, "ATTENDANCE_ASSUMED", { conversationId, previousStatus: antes.status });
      return { conversationId, status: "atendimento_humano" };
    }), ESPERA_TRAVA_CONVERSA_MS);
  } catch (erro) { return ocupada(erro); }
}

/** A equipe devolve a conversa para a Sofia. */
export async function devolverConversaParaSofia(input: { opportunityId: number; actor: OpportunityActor }): Promise<{ conversationId: number; status: string }> {
  const autorId = exigirHumano(input.actor);
  const { conversationId } = await conversaVinculadaDoCartao(input.opportunityId);
  const [usuario] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, autorId)).limit(1);
  try {
    return await comTravaDaConversa(conversationId, async () => db.transaction(async (tx) => {
      await travarOportunidadeAberta(tx, input.opportunityId);
      const [antes] = await tx.select({ status: conversations.status }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
      if (!antes) throw new OpportunityRuleError("Conversa não encontrada.", "NOT_FOUND", 404);
      if (antes.status === "ativa") return { conversationId, status: antes.status };
      await tx.update(conversations)
        .set({ status: "ativa", handoffResolvedAt: new Date(), handoffResolvedBy: usuario?.name ?? "desconhecido" })
        .where(and(eq(conversations.id, conversationId), inArray(conversations.status, ["aguardando_humano", "atendimento_humano"])));
      await registrarAcao(tx, input.opportunityId, input.actor, "ATTENDANCE_RETURNED", { conversationId, previousStatus: antes.status });
      return { conversationId, status: "ativa" };
    }), ESPERA_TRAVA_CONVERSA_MS);
  } catch (erro) { return ocupada(erro); }
}

/** A equipe confirma que a conversa do número é desta pessoa (vínculo registrado no histórico). */
export async function confirmarVinculoDoCartao(input: { opportunityId: number; actor: OpportunityActor }): Promise<void> {
  exigirHumano(input.actor);
  const card = await cartao(input.opportunityId);
  if (card.stage === "CLOSED") throw new OpportunityRuleError("Oportunidade encerrada: só é possível reativá-la.", "OPPORTUNITY_CLOSED", 409);
  const pessoa = await carregarPessoaDeContato(card.pessoaId);
  if (!pessoa) throw new OpportunityRuleError("Pessoa não encontrada.", "PERSON_NOT_FOUND", 404);
  const vinculo = await localizarConversaWhatsapp(pessoa);
  if (vinculo.tipo !== "a_confirmar") {
    throw new OpportunityRuleError("Não há vínculo a confirmar para este cartão.", "LINK_NOT_ALLOWED", 409);
  }
  await confirmarVinculoDaConversa({ pessoaId: card.pessoaId, conversationId: vinculo.conversationId, actor: input.actor });
}

/**
 * As condições de qualquer envio livre (texto ou arquivo) da equipe, conferidas DENTRO das travas da pessoa e da
 * conversa, logo antes de enviar: cartão aberto, conversa de WhatsApp, atendimento assumido, pessoa que não
 * pediu para ficar sem mensagens e janela de 24h aberta. Devolve o telefone da conversa.
 */
export async function exigirCondicoesDeEnvioLivre(input: {
  opportunityId: number; pessoaId: number; conversationId: number; agora: Date;
}): Promise<{ canalUsuario: string }> {
  const { opportunityId, pessoaId, conversationId, agora } = input;
  await db.transaction(tx => travarOportunidadeAberta(tx, opportunityId));
  const [conversa] = await db.select({ status: conversations.status, canal: conversations.canal, canalUsuario: conversations.canalUsuario })
    .from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (!conversa || conversa.canal !== "whatsapp" || !conversa.canalUsuario || !/^\d{8,15}$/.test(conversa.canalUsuario)) {
    throw new OpportunityRuleError("Esta conversa não tem um WhatsApp para responder.", "CONVERSATION_NOT_LINKED", 409);
  }
  if (conversa.status !== "atendimento_humano") {
    throw new OpportunityRuleError("Assuma o atendimento antes de enviar mensagens.", "ATTENDANCE_NOT_ASSUMED", 409);
  }
  const contato = await carregarEstadoDeContato(pessoaId);
  if (contato.naoQuerReceber || await pessoaTemCartaoSemContato(pessoaId)) {
    throw new OpportunityRuleError("Esta pessoa pediu para não receber mensagens.", "OPTED_OUT", 409);
  }
  const ultimaDaPessoa = await ultimaMensagemDaPessoa(conversationId);
  if (!ultimaDaPessoa || ultimaDaPessoa.getTime() + JANELA_24H_MS <= agora.getTime()) {
    throw new OpportunityRuleError(
      "Passaram mais de 24h desde a última mensagem da pessoa. Só o modelo de abertura pode ser enviado.",
      "OUTSIDE_WINDOW", 409,
    );
  }
  return { canalUsuario: conversa.canalUsuario };
}

/**
 * Envia um texto da equipe pelo WhatsApp. Todas as condições são conferidas de novo dentro das travas (da
 * pessoa e da conversa), logo antes de enviar. Uma tentativa; sem fallback para modelo.
 */
export async function enviarTextoDaEquipe(input: {
  opportunityId: number;
  actor: OpportunityActor;
  texto: unknown;
  deps?: HabllaClientDeps;
  agora?: () => Date;
}): Promise<{ messageId: number }> {
  const autorId = exigirHumano(input.actor);
  const texto = textoObrigatorio(input.texto, "A mensagem", LIMITE_MENSAGEM_DA_EQUIPE);
  const deps = input.deps ?? {};
  const agora = input.agora ?? (() => new Date());

  const { pessoaId, conversationId } = await conversaVinculadaDoCartao(input.opportunityId);
  return comTravaDeContato(pessoaId, async () => {
    try {
      return await comTravaDaConversa(conversationId, async () => {
        const { canalUsuario } = await exigirCondicoesDeEnvioLivre({ opportunityId: input.opportunityId, pessoaId, conversationId, agora: agora() });

        const [mensagem] = await db.insert(messages).values({
          conversationId, role: "staff", content: texto, authorUserId: autorId,
        }).returning({ id: messages.id });
        let externoId: string | null;
        try {
          ({ externoId } = await enviarMensagemWhatsapp({ para: canalUsuario, texto }, deps));
        } catch (erro) {
          logger.warn({ erroTipo: (erro as { name?: string })?.name, erroCodigo: (erro as { codigo?: string })?.codigo, conversationId }, "chat do CRM: envio falhou");
          const detalhe = (erro instanceof Error ? erro.message : String(erro)).slice(0, 500);
          await db.insert(canalEnvios).values({ conversationId, messageId: mensagem!.id, canal: "whatsapp", texto, status: "falhou", erro: detalhe });
          throw new OpportunityRuleError(
            erro instanceof HabllaErro && erro.codigo === "janela_24h"
              ? "O WhatsApp recusou a mensagem: a janela de 24h está fechada."
              : "Não foi possível enviar a mensagem. Ela não foi reenviada.",
            "SEND_FAILED", 502,
          );
        }
        await db.insert(canalEnvios).values({
          conversationId, messageId: mensagem!.id, canal: "whatsapp", texto, status: "aceito", externoId, filaId: externoId,
        });
        if (externoId) {
          await reconciliarEntrega(externoId, esperadoDoAmbiente(deps.env)).catch(erro =>
            logger.warn({ erroTipo: (erro as { name?: string })?.name }, "chat do CRM: não consegui reaplicar avisos de entrega pendentes"));
        }
        // Mensagem já enviada: o histórico não pode falhar por o cartão ter sido encerrado nesse meio-tempo.
        await db.transaction(tx => registrarAcao(tx, input.opportunityId, input.actor, "MESSAGE_SENT", {
          conversationId, messageId: mensagem!.id, excerpt: texto.slice(0, 200),
        }));
        return { messageId: mensagem!.id };
      }, ESPERA_TRAVA_CONVERSA_MS);
    } catch (erro) { return ocupada(erro); }
  });
}
