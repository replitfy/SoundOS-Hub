import { and, desc, eq, ne } from "drizzle-orm";
import { db, messages, pessoasTable } from "@workspace/db";

/**
 * Contexto que acompanha o cartão de interesse aberto pela Sofia, para quem
 * assume saber o que a pessoa disse sem caçar a conversa.
 *
 * Só entram trechos escritos pela PESSOA e campos não sensíveis da ficha. Nada
 * escrito pela Sofia, nada do catálogo (valores de evento) e nada de CPF, saúde
 * ou e-mail: o mesmo corte que `obterHistorico` já usa.
 */
export interface ContextoConversa {
  conversationId: number | null;
  capturadoEm: string;
  /** Últimas mensagens da pessoa nesta conversa, da mais antiga para a mais recente. */
  mensagens: string[];
  /** Só campos preenchidos. */
  ficha: {
    cidade?: string;
    profissao?: string;
    servicoInteresse?: string;
    objetivos?: string[];
  };
}

export const MAX_MENSAGENS_CONTEXTO = 5;
export const MAX_CARACTERES_MENSAGEM = 400;

export function limparTrecho(texto: string, maximo = MAX_CARACTERES_MENSAGEM): string {
  const limpo = texto.replace(/\s+/g, " ").trim();
  return limpo.length > maximo ? `${limpo.slice(0, maximo - 1).trimEnd()}…` : limpo;
}

interface FichaBruta {
  cidade: string | null;
  profissao: string | null;
  servicoInteresse: string | null;
  objetivosDeclarados: string[] | null;
}

/** Núcleo puro: monta o contexto a partir do que o banco devolveu. */
export function montarContextoConversa(input: {
  conversationId: number | null;
  now: Date;
  mensagensDaPessoa: string[];
  ficha: FichaBruta | null;
}): ContextoConversa {
  const mensagens = input.mensagensDaPessoa
    .map(texto => limparTrecho(texto))
    .filter(texto => texto.length > 0)
    .slice(-MAX_MENSAGENS_CONTEXTO);
  const ficha: ContextoConversa["ficha"] = {};
  const cidade = input.ficha?.cidade?.trim();
  const profissao = input.ficha?.profissao?.trim();
  const servicoInteresse = input.ficha?.servicoInteresse?.trim();
  const objetivos = (input.ficha?.objetivosDeclarados ?? []).map(o => limparTrecho(o, 120)).filter(Boolean);
  if (cidade) ficha.cidade = cidade;
  if (profissao) ficha.profissao = profissao;
  if (servicoInteresse) ficha.servicoInteresse = servicoInteresse;
  if (objetivos.length > 0) ficha.objetivos = objetivos;
  return { conversationId: input.conversationId, capturadoEm: input.now.toISOString(), mensagens, ficha };
}

/** Contexto mínimo quando a leitura falha: o cartão abre do mesmo jeito, com a referência da conversa. */
export function contextoVazio(conversationId: number | null, now: Date): ContextoConversa {
  return montarContextoConversa({ conversationId, now, mensagensDaPessoa: [], ficha: null });
}

export async function carregarContextoConversa(
  pessoaId: number,
  conversationId: number | null,
  now: Date,
): Promise<ContextoConversa> {
  const [ficha] = await db
    .select({
      cidade: pessoasTable.cidade,
      profissao: pessoasTable.profissao,
      servicoInteresse: pessoasTable.servicoInteresse,
      objetivosDeclarados: pessoasTable.objetivosDeclarados,
    })
    .from(pessoasTable)
    .where(eq(pessoasTable.id, pessoaId))
    .limit(1);

  const recentes = conversationId === null
    ? []
    : await db
      .select({ content: messages.content })
      .from(messages)
      // Arquivo sem legenda não é texto da pessoa: fica fora do contexto.
      .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "user"), ne(messages.content, "")))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(MAX_MENSAGENS_CONTEXTO);

  return montarContextoConversa({
    conversationId,
    now,
    mensagensDaPessoa: recentes.reverse().map(m => m.content),
    ficha: ficha ?? null,
  });
}
