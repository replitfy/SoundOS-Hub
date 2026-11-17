import { and, eq, isNull, or } from "drizzle-orm";
import { db, conversations, messages, canalEnvios } from "@workspace/db";
import { logger } from "../lib/logger";
import { buscarModeloWhatsapp, enviarModeloWhatsapp, HabllaErro, type HabllaClientDeps, type ModeloWhatsapp } from "./habllaClient";
import { OpportunityRuleError, type OpportunityActor } from "./commercialOpportunities";
import { comTravaDaConversa, ConversaOcupadaErro } from "./conversationLock";
import { carregarEstadoDeContato, comTravaDeContato, pessoaTemCartaoSemContato } from "./contatoAutorizacao";
import {
  carregarPessoaDeContato, contarFichasAtivasComTelefone, localizarConversaWhatsapp, telefoneDeEnvio, type VinculoDaConversa,
} from "./conversaWhatsappDaPessoa";
import { exigirHumano, registrarAcaoNosCartoesAbertos, travarOportunidadeAberta } from "./crmAtendimento";
import { celularInformadoNaoGravado } from "./identidadeConferencia";
import { traduzirErroDeEnvio } from "./metaErros";
import { reconciliarEntrega } from "./entregaWhatsapp";
import { primeiroNomeDe } from "./sofiaPessoa";
import { esperadoDoAmbiente, telefoneParaExibir } from "./sofiaCanalWhatsapp";
import { obterOuCriarConversa } from "./sofiaCanalPipeline";

// Modelo de abertura do WhatsApp ("sofia_iniciar_conversa"): a primeira mensagem para quem não escreveu nos
// últimos 24h. Só sai por clique da equipe, com o status do modelo conferido na Meta/Astenir na hora, com
// autorização registrada da pessoa e sem "não quer receber". Uma tentativa, nunca reenviada sozinha.

export const MODELO_ABERTURA = { nome: "sofia_iniciar_conversa", idioma: "pt_BR" } as const;
const ESPERA_TRAVA_CONVERSA_MS = 15_000;

export type BloqueioDeAbertura =
  | "pessoa_arquivada" | "pessoa_unida" | "sem_primeiro_nome"
  | "sem_telefone" | "telefone_invalido" | "telefone_estrangeiro" | "telefone_em_varias_fichas"
  | "sem_autorizacao" | "nao_quer_receber" | "cartao_nao_quer_receber"
  | "vinculo_a_confirmar" | "conversa_de_outra_ficha"
  | "modelo_em_analise" | "modelo_nao_aprovado" | "modelo_inexistente" | "modelo_indisponivel" | "modelo_incompativel";

export interface PreparoDeAbertura {
  podeEnviar: boolean;
  bloqueios: BloqueioDeAbertura[];
  /** Texto exato que a pessoa vai receber (com o primeiro nome). Só existe com o modelo aprovado e compatível. */
  texto: string | null;
  vinculo: VinculoDaConversa;
  /** Só com a ficha sem telefone: o formulário informou um celular que não foi gravado por pertencer a outras fichas. */
  celularInformadoNaoGravado: boolean;
}

type SituacaoDoModelo =
  | { estado: "ok"; modelo: ModeloWhatsapp; corpo: string }
  | { estado: "bloqueado"; bloqueio: Extract<BloqueioDeAbertura, `modelo_${string}`> };

/** Consulta o modelo na Astenir agora. Qualquer dúvida (rede, token, formato) bloqueia: nunca se envia às cegas. */
async function situacaoDoModelo(deps: HabllaClientDeps): Promise<SituacaoDoModelo> {
  let modelo: ModeloWhatsapp | null;
  try {
    modelo = await buscarModeloWhatsapp(MODELO_ABERTURA, deps);
  } catch (erro) {
    logger.warn({ erroTipo: (erro as { name?: string })?.name, erroCodigo: (erro as { codigo?: string })?.codigo }, "modelo de abertura: não consegui consultar o modelo");
    return { estado: "bloqueado", bloqueio: "modelo_indisponivel" };
  }
  if (!modelo) return { estado: "bloqueado", bloqueio: "modelo_inexistente" };
  const status = modelo.status.toUpperCase();
  if (status === "PENDING" || status === "IN_APPEAL") return { estado: "bloqueado", bloqueio: "modelo_em_analise" };
  if (status !== "APPROVED") return { estado: "bloqueado", bloqueio: "modelo_nao_aprovado" };
  // O envio só preenche o corpo com UMA variável posicional ({{1}}, o primeiro nome).
  const corpo = modelo.corpo;
  const variaveis = new Set((corpo ?? "").match(/\{\{\s*[^}\s]+\s*\}\}/g) ?? []);
  const cabecalhoComVariavel = modelo.cabecalho !== null && /\{\{/.test(modelo.cabecalho);
  if (!corpo || cabecalhoComVariavel || variaveis.size !== 1 || !variaveis.has("{{1}}")) {
    return { estado: "bloqueado", bloqueio: "modelo_incompativel" };
  }
  return { estado: "ok", modelo, corpo };
}

export function renderizarModelo(corpo: string, primeiroNome: string): string {
  return corpo.replace(/\{\{1\}\}/g, primeiroNome);
}

/** Tudo que o envio exige, avaliado agora. A tela mostra o texto e os bloqueios; o envio repete a análise. */
export async function prepararAbertura(pessoaId: number, deps: HabllaClientDeps): Promise<{
  preparo: PreparoDeAbertura;
  /** Só existe quando o envio é possível: o que é preciso para enviar. */
  envio: { modelo: ModeloWhatsapp; destino: string; primeiroNome: string; texto: string } | null;
}> {
  const pessoa = await carregarPessoaDeContato(pessoaId);
  if (!pessoa) throw new OpportunityRuleError("Pessoa não encontrada.", "PERSON_NOT_FOUND", 404);
  const bloqueios: BloqueioDeAbertura[] = [];

  if (pessoa.mergedIntoPessoaId !== null) bloqueios.push("pessoa_unida");
  else if (pessoa.arquivadoEm !== null) bloqueios.push("pessoa_arquivada");
  const primeiroNome = primeiroNomeDe(pessoa.nome);
  if (!primeiroNome) bloqueios.push("sem_primeiro_nome");

  const telefone = telefoneDeEnvio(pessoa.celular);
  if (!telefone.ok) bloqueios.push(telefone.motivo);
  else if (await contarFichasAtivasComTelefone(telefone.chave) > 1) bloqueios.push("telefone_em_varias_fichas");

  const contato = await carregarEstadoDeContato(pessoaId);
  if (contato.naoQuerReceber) bloqueios.push("nao_quer_receber");
  else if (!contato.autorizado) bloqueios.push("sem_autorizacao");
  if (await pessoaTemCartaoSemContato(pessoaId)) bloqueios.push("cartao_nao_quer_receber");

  const vinculo = await localizarConversaWhatsapp(pessoa);
  if (vinculo.tipo === "a_confirmar") bloqueios.push("vinculo_a_confirmar");
  else if (vinculo.tipo === "bloqueada") {
    if (vinculo.motivo === "conversa_de_outra_ficha") bloqueios.push("conversa_de_outra_ficha");
    else if (!bloqueios.includes(vinculo.motivo)) bloqueios.push(vinculo.motivo);
  }

  const modelo = await situacaoDoModelo(deps);
  let texto: string | null = null;
  if (modelo.estado === "bloqueado") bloqueios.push(modelo.bloqueio);
  else if (primeiroNome) texto = renderizarModelo(modelo.corpo, primeiroNome);

  const celularNaoGravado = !telefone.ok && telefone.motivo === "sem_telefone" ? await celularInformadoNaoGravado(pessoaId) : false;
  const pode = bloqueios.length === 0 && texto !== null && modelo.estado === "ok" && telefone.ok && primeiroNome !== null;
  return {
    preparo: { podeEnviar: pode, bloqueios, texto, vinculo, celularInformadoNaoGravado: celularNaoGravado },
    envio: pode && texto !== null ? { modelo: modelo.modelo, destino: telefone.destino, primeiroNome, texto } : null,
  };
}

/** Prévia para a tela de confirmação (não envia nada). */
export async function previaDaAbertura(pessoaId: number, deps: HabllaClientDeps = {}): Promise<PreparoDeAbertura> {
  return (await prepararAbertura(pessoaId, deps)).preparo;
}

export interface AberturaEnviada {
  conversationId: number;
  messageId: number;
  texto: string;
}

/** O que o envio precisa, já analisado por `prepararAbertura` com a trava de contato da pessoa em mãos. */
export type EnvioPreparado = NonNullable<Awaited<ReturnType<typeof prepararAbertura>>["envio"]>;

/**
 * Envia o modelo de abertura à pessoa. `opportunityId` (quando o envio parte de um cartão) precisa ser da
 * pessoa e estar aberto. O envio tem uma única tentativa: se falhar, a falha fica visível na conversa e
 * ninguém reenvia sozinho. O texto e o autor ficam na conversa; a Sofia lê só este modelo como contexto.
 */
export async function enviarAbertura(input: {
  pessoaId: number;
  actor: OpportunityActor;
  opportunityId?: number;
  deps?: HabllaClientDeps;
}): Promise<AberturaEnviada> {
  exigirHumano(input.actor);
  const deps = input.deps ?? {};

  if (input.opportunityId !== undefined) {
    const cartao = await db.transaction(tx => travarOportunidadeAberta(tx, input.opportunityId!));
    if (cartao.pessoaId !== input.pessoaId) throw new OpportunityRuleError("Oportunidade não encontrada.", "NOT_FOUND", 404);
  }

  return comTravaDeContato(input.pessoaId, async () => {
    const { preparo, envio } = await prepararAbertura(input.pessoaId, deps);
    if (!envio) {
      throw new OpportunityRuleError("O modelo de abertura não pode ser enviado agora.", "OPENING_BLOCKED", 409, { bloqueios: preparo.bloqueios });
    }
    return executarEnvioDeAbertura({ pessoaId: input.pessoaId, actor: input.actor, preparo, envio, deps });
  });
}

/**
 * Faz o envio já analisado. Quem chama precisa estar dentro da trava de contato da pessoa (a mesma
 * análise e o mesmo envio valem para a equipe e para a Sofia). O autor é a pessoa da equipe ou, no
 * primeiro contato automático, a própria Sofia (sem usuário).
 */
export async function executarEnvioDeAbertura(input: {
  pessoaId: number;
  actor: OpportunityActor;
  preparo: PreparoDeAbertura;
  envio: EnvioPreparado;
  deps: HabllaClientDeps;
}): Promise<AberturaEnviada> {
  const { preparo, deps } = input;
  const autorId = input.actor.kind === "HUMAN" ? exigirHumano(input.actor) : null;
  const { texto, modelo, destino, primeiroNome } = input.envio;

  // Uma conversa por número; se ainda não existe, nasce aqui, já ligada a esta ficha.
  let conversationId: number;
  if (preparo.vinculo.tipo === "vinculada") {
    conversationId = preparo.vinculo.conversationId;
  } else {
    const chave = destino.slice(2);
    conversationId = await obterOuCriarConversa("whatsapp", {
      contatoId: chave, destinatario: destino, texto: "", usuario: null,
      titulo: `WhatsApp ${telefoneParaExibir(destino)}`, canalUsuario: destino,
    });
    // A conversa pode ter ganhado ficha (de outra pessoa) entre a análise e agora: nesse caso nada é enviado.
    const ligada = await db.update(conversations).set({ pessoaId: input.pessoaId })
      .where(and(eq(conversations.id, conversationId), or(isNull(conversations.pessoaId), eq(conversations.pessoaId, input.pessoaId))))
      .returning({ id: conversations.id });
    if (ligada.length === 0) {
      throw new OpportunityRuleError("O modelo de abertura não pode ser enviado agora.", "OPENING_BLOCKED", 409, { bloqueios: ["conversa_de_outra_ficha"] });
    }
  }

  try {
    return await comTravaDaConversa(conversationId, async () => {
      let externoId: string | null;
      try {
        ({ externoId } = await enviarModeloWhatsapp({ para: destino, modeloId: modelo.id, variaveis: { "1": primeiroNome } }, deps));
      } catch (erro) {
        logger.warn({ erroTipo: (erro as { name?: string })?.name, erroCodigo: (erro as { codigo?: string })?.codigo, conversationId }, "modelo de abertura: envio falhou");
        // A tentativa fica visível para a equipe, mas como mensagem da equipe: a Sofia não a lê como dela.
        // Se o erro traz um código da Meta, o motivo guardado é a tradução em português.
        const detalhe = (traduzirErroDeEnvio(erro instanceof Error ? erro.message : String(erro)) ?? "").slice(0, 500);
        const [falha] = await db.insert(messages).values({
          conversationId, role: "staff", content: texto, authorUserId: autorId, kind: "modelo_abertura",
        }).returning({ id: messages.id });
        await db.insert(canalEnvios).values({ conversationId, messageId: falha!.id, canal: "whatsapp", texto, status: "falhou", erro: detalhe });
        throw new OpportunityRuleError(
          erro instanceof HabllaErro && erro.codigo === "janela_24h"
            ? "O WhatsApp recusou o envio do modelo."
            : "Não foi possível enviar o modelo de abertura. Nada foi reenviado.",
          "OPENING_SEND_FAILED", 502, { conversationId, messageId: falha!.id, motivo: detalhe },
        );
      }

      const [mensagem] = await db.insert(messages).values({
        conversationId, role: "assistant", content: texto, authorUserId: autorId, kind: "modelo_abertura",
      }).returning({ id: messages.id });
      await db.insert(canalEnvios).values({
        conversationId, messageId: mensagem!.id, canal: "whatsapp", texto, status: "aceito", externoId, filaId: externoId,
      });
      if (externoId) {
        await reconciliarEntrega(externoId, esperadoDoAmbiente(deps.env)).catch(erro =>
          logger.warn({ erroTipo: (erro as { name?: string })?.name }, "modelo de abertura: não consegui reaplicar avisos de entrega pendentes"));
      }
      await db.transaction(tx => registrarAcaoNosCartoesAbertos(tx, input.pessoaId, input.actor, "TEMPLATE_SENT", {
        conversationId, messageId: mensagem!.id, templateName: MODELO_ABERTURA.nome, text: texto,
      }));
      return { conversationId, messageId: mensagem!.id, texto };
    }, ESPERA_TRAVA_CONVERSA_MS);
  } catch (erro) {
    if (erro instanceof ConversaOcupadaErro) {
      throw new OpportunityRuleError("A conversa está ocupada com uma resposta da Sofia. Tente de novo em instantes.", "CONVERSATION_BUSY", 409);
    }
    throw erro;
  }
}
