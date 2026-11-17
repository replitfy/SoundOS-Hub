import { and, eq, ne, or, sql } from "drizzle-orm";
import { conversations, db, primeiroContatoAutomatico, type PrimeiroContatoResultado } from "@workspace/db";
import { logger } from "../lib/logger";
import type { HabllaClientDeps } from "./habllaClient";
import { lerConfigHablla } from "./habllaConfig";
import { OpportunityRuleError, type OpportunityActor } from "./commercialOpportunities";
import { comTravaDeContato } from "./contatoAutorizacao";
import { carregarPessoaDeContato, telefoneDeEnvio } from "./conversaWhatsappDaPessoa";
import { registrarAcao } from "./crmAtendimento";
import { executarEnvioDeAbertura, prepararAbertura, type BloqueioDeAbertura } from "./whatsappModeloAbertura";

// Primeiro contato automático: quem preenche o formulário de interesse e marca o consentimento recebe o
// modelo de abertura do WhatsApp (o mesmo que a equipe envia pelo cartão), em nome da Sofia, logo depois
// do cadastro. Só vale para cartão NOVO criado pelo formulário, com a chave ligada no WhatsApp, e nunca
// atrasa nem derruba a resposta do formulário: roda depois do commit, numa única tentativa.

/** Limites de envio automático (contam enviados, falhos e em andamento; "não enviado" não conta). */
export const LIMITE_INICIOS_POR_HORA = 20;
export const LIMITE_INICIOS_POR_DIA = 100;

const NAMESPACE_LIMITE_DE_INICIOS = 0x50434c4d;
const SOFIA: OpportunityActor = { kind: "SOFIA" };

export type MotivoDoPrimeiroContato =
  | BloqueioDeAbertura
  | "pessoa_em_conferencia"
  | "sem_consentimento"
  | "conversa_com_equipe"
  | "ja_recebeu_modelo"
  | "limite_por_hora"
  | "limite_por_dia"
  | "conversa_ocupada"
  | "falha_no_envio";

export interface EntradaDoPrimeiroContato {
  pessoaId: number;
  /** Cartão novo criado por esta submissão. */
  opportunityId: number;
  /** A caixa de consentimento estava marcada nesta submissão. */
  consentiu: boolean;
  /** Identidade não confirmada: a ficha está em conferência. */
  conferencia: boolean;
}

export type DesfechoDoPrimeiroContato =
  | { resultado: "desligado" }
  | { resultado: "ja_processado" }
  | { resultado: "enviado"; conversationId: number; messageId: number }
  | { resultado: "nao_enviado"; motivo: MotivoDoPrimeiroContato }
  | { resultado: "falhou"; motivo: "falha_no_envio"; detalhe: string };

export type ExecutarPrimeiroContato = (entrada: EntradaDoPrimeiroContato, deps?: HabllaClientDeps) => Promise<DesfechoDoPrimeiroContato>;

/** Só para testes: troca a execução que roda depois do commit do formulário e reduz os limites de envio. */
export const primeiroContatoTestHooks: { executar?: ExecutarPrimeiroContato; limites?: { hora: number; dia: number } } = {};

async function gravarNaoEnviado(entrada: EntradaDoPrimeiroContato, motivo: MotivoDoPrimeiroContato, extra: Record<string, unknown> = {}): Promise<DesfechoDoPrimeiroContato> {
  await db.transaction(async tx => {
    const [linha] = await tx.insert(primeiroContatoAutomatico).values({
      pessoaId: entrada.pessoaId, opportunityId: entrada.opportunityId, resultado: "NAO_ENVIADO", motivo,
    }).onConflictDoNothing().returning({ id: primeiroContatoAutomatico.id });
    // Um card tem uma análise só: reanalisar não duplica o aviso no histórico.
    if (linha) await registrarAcao(tx, entrada.opportunityId, SOFIA, "AUTO_OPENING_NOT_SENT", { reason: motivo, ...extra });
  });
  return { resultado: "nao_enviado", motivo };
}

async function fecharTentativa(id: number, resultado: PrimeiroContatoResultado, campos: { motivo?: string | null; conversationId?: number; messageId?: number } = {}): Promise<void> {
  await db.update(primeiroContatoAutomatico).set({
    resultado, motivo: campos.motivo ?? null, conversationId: campos.conversationId ?? null, messageId: campos.messageId ?? null, updatedAt: new Date(),
  }).where(eq(primeiroContatoAutomatico.id, id));
}

type Reserva =
  | { tipo: "ok"; id: number }
  | { tipo: "recusada"; motivo: "limite_por_hora" | "limite_por_dia" | "ja_recebeu_modelo" };

/** Confere os limites e reserva o envio sob uma trava global: duas análises simultâneas não passam do limite. */
async function reservarEnvio(entrada: EntradaDoPrimeiroContato, telefoneChave: string): Promise<Reserva> {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${NAMESPACE_LIMITE_DE_INICIOS}, 0)`);
    const jaRecebeu = await tx.select({ id: primeiroContatoAutomatico.id }).from(primeiroContatoAutomatico)
      .where(and(
        ne(primeiroContatoAutomatico.resultado, "NAO_ENVIADO"),
        or(eq(primeiroContatoAutomatico.pessoaId, entrada.pessoaId), eq(primeiroContatoAutomatico.telefoneChave, telefoneChave)),
      )).limit(1);
    if (jaRecebeu.length > 0) return { tipo: "recusada", motivo: "ja_recebeu_modelo" } as const;

    const [contagem] = await tx.select({
      hora: sql<number>`count(*) FILTER (WHERE ${primeiroContatoAutomatico.createdAt} > now() - interval '1 hour')::int`,
      dia: sql<number>`count(*) FILTER (WHERE ${primeiroContatoAutomatico.createdAt} > now() - interval '24 hours')::int`,
    }).from(primeiroContatoAutomatico).where(ne(primeiroContatoAutomatico.resultado, "NAO_ENVIADO"));
    const limiteHora = primeiroContatoTestHooks.limites?.hora ?? LIMITE_INICIOS_POR_HORA;
    const limiteDia = primeiroContatoTestHooks.limites?.dia ?? LIMITE_INICIOS_POR_DIA;
    if ((contagem?.hora ?? 0) >= limiteHora) return { tipo: "recusada", motivo: "limite_por_hora" } as const;
    if ((contagem?.dia ?? 0) >= limiteDia) return { tipo: "recusada", motivo: "limite_por_dia" } as const;

    const [linha] = await tx.insert(primeiroContatoAutomatico).values({
      pessoaId: entrada.pessoaId, opportunityId: entrada.opportunityId, telefoneChave, resultado: "EM_ANDAMENTO",
    }).onConflictDoNothing().returning({ id: primeiroContatoAutomatico.id });
    return linha ? { tipo: "ok", id: linha.id } as const : { tipo: "recusada", motivo: "ja_recebeu_modelo" } as const;
  });
}

/**
 * Analisa e, se tudo permitir, envia o modelo de abertura em nome da Sofia. Com a chave desligada, não
 * faz nem registra nada. Cada card novo é analisado uma vez: sai o envio, a falha ou o motivo de não
 * enviar, sempre no histórico do card. `deps` troca o cliente do Hablla (testes).
 */
export const iniciarPrimeiroContato: ExecutarPrimeiroContato = async (entrada, deps = {}) => {
  const config = await lerConfigHablla();
  if (!config.sofiaIniciaConversa) return { resultado: "desligado" };

  const [jaAnalisado] = await db.select({ id: primeiroContatoAutomatico.id }).from(primeiroContatoAutomatico)
    .where(eq(primeiroContatoAutomatico.opportunityId, entrada.opportunityId)).limit(1);
  if (jaAnalisado) return { resultado: "ja_processado" };

  if (entrada.conferencia) return gravarNaoEnviado(entrada, "pessoa_em_conferencia");
  if (!entrada.consentiu) return gravarNaoEnviado(entrada, "sem_consentimento");

  return comTravaDeContato(entrada.pessoaId, async (): Promise<DesfechoDoPrimeiroContato> => {
    // Reconfere dentro da trava: outro envio do mesmo card pode ter terminado enquanto esperávamos.
    const [repetido] = await db.select({ id: primeiroContatoAutomatico.id }).from(primeiroContatoAutomatico)
      .where(eq(primeiroContatoAutomatico.opportunityId, entrada.opportunityId)).limit(1);
    if (repetido) return { resultado: "ja_processado" };

    const { preparo, envio } = await prepararAbertura(entrada.pessoaId, deps);
    if (!envio) {
      const motivo = preparo.bloqueios[0] ?? "modelo_indisponivel";
      return gravarNaoEnviado(entrada, motivo, { blocks: preparo.bloqueios });
    }
    if (preparo.vinculo.tipo === "vinculada") {
      const [conversa] = await db.select({ status: conversations.status }).from(conversations)
        .where(eq(conversations.id, preparo.vinculo.conversationId)).limit(1);
      if (conversa && conversa.status !== "ativa") return gravarNaoEnviado(entrada, "conversa_com_equipe");
    }

    const pessoa = await carregarPessoaDeContato(entrada.pessoaId);
    const telefone = telefoneDeEnvio(pessoa?.celular);
    if (!telefone.ok) return gravarNaoEnviado(entrada, telefone.motivo);

    const reserva = await reservarEnvio(entrada, telefone.chave);
    if (reserva.tipo === "recusada") {
      if (reserva.motivo !== "ja_recebeu_modelo") {
        logger.warn({ limite: reserva.motivo, opportunityId: entrada.opportunityId }, "primeiro contato automático: limite de envios atingido");
      }
      return gravarNaoEnviado(entrada, reserva.motivo);
    }

    try {
      const enviado = await executarEnvioDeAbertura({ pessoaId: entrada.pessoaId, actor: SOFIA, preparo, envio, deps });
      await fecharTentativa(reserva.id, "ENVIADO", { conversationId: enviado.conversationId, messageId: enviado.messageId });
      return { resultado: "enviado", conversationId: enviado.conversationId, messageId: enviado.messageId };
    } catch (erro) {
      if (erro instanceof OpportunityRuleError && erro.code === "OPENING_BLOCKED") {
        // Algo mudou entre a análise e o envio: nada saiu, o motivo vai para o histórico.
        const bloqueios = (erro.details?.bloqueios as BloqueioDeAbertura[] | undefined) ?? [];
        await fecharTentativa(reserva.id, "NAO_ENVIADO", { motivo: bloqueios[0] ?? "modelo_indisponivel" });
        await db.transaction(tx => registrarAcao(tx, entrada.opportunityId, SOFIA, "AUTO_OPENING_NOT_SENT", { reason: bloqueios[0] ?? "modelo_indisponivel", blocks: bloqueios }));
        return { resultado: "nao_enviado", motivo: bloqueios[0] ?? "modelo_indisponivel" };
      }
      if (erro instanceof OpportunityRuleError && erro.code === "CONVERSATION_BUSY") {
        await fecharTentativa(reserva.id, "NAO_ENVIADO", { motivo: "conversa_ocupada" });
        await db.transaction(tx => registrarAcao(tx, entrada.opportunityId, SOFIA, "AUTO_OPENING_NOT_SENT", { reason: "conversa_ocupada" }));
        return { resultado: "nao_enviado", motivo: "conversa_ocupada" };
      }
      // Falha de envio (ou erro inesperado): uma tentativa só. A tentativa não se repete e fica visível.
      const detalhe = erro instanceof OpportunityRuleError && typeof erro.details?.motivo === "string" ? erro.details.motivo : "";
      await fecharTentativa(reserva.id, "FALHOU", { motivo: "falha_no_envio", conversationId: erro instanceof OpportunityRuleError ? (erro.details?.conversationId as number | undefined) : undefined });
      await db.transaction(tx => registrarAcao(tx, entrada.opportunityId, SOFIA, "AUTO_OPENING_NOT_SENT", {
        reason: "falha_no_envio", ...(detalhe ? { detail: detalhe } : {}),
      }));
      logger.warn({ erroTipo: (erro as { name?: string })?.name, opportunityId: entrada.opportunityId }, "primeiro contato automático: envio falhou");
      return { resultado: "falhou", motivo: "falha_no_envio", detalhe };
    }
  });
};

/**
 * Chamado pela rota do formulário DEPOIS de responder: nunca espera nem propaga erro. Só dispara quando o
 * cartão foi criado por esta submissão.
 */
export function dispararPrimeiroContato(entrada: EntradaDoPrimeiroContato & { cartaoNovo: boolean }): void {
  if (!entrada.cartaoNovo) return;
  const { cartaoNovo: _cartaoNovo, ...dados } = entrada;
  const executar = primeiroContatoTestHooks.executar ?? iniciarPrimeiroContato;
  void Promise.resolve()
    .then(() => executar(dados))
    .catch(erro => logger.error({ erroTipo: (erro as { name?: string })?.name, opportunityId: dados.opportunityId }, "primeiro contato automático: erro inesperado"));
}
