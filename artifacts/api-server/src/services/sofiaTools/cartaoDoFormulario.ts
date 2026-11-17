import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { commercialOpportunities, commercialOpportunityEvents, db } from "@workspace/db";
import { interestGroupLabel } from "../interesseGeral";
import { CONVERSA_IDENTIDADE } from "../cartaoDaConversaIdentidade";
import { REGRA_CONTATO_APOS_FORMULARIO } from "./contatoAposFormulario";

/**
 * Contexto do formulário para a Sofia: quando a conversa é de uma pessoa cujo cartão aberto nasceu de um
 * formulário de interesse, ela sabe o que a pessoa preencheu (o título do cartão, o grupo e a página) e
 * retoma o assunto em vez de perguntar de novo. Só dados desta pessoa; nada escrito pela equipe e nada de
 * valores (o título do cartão é o nome do evento ou da lista de interesse).
 */
export interface FormularioRecente {
  titulo: string;
  grupo: string | null;
  paginaOrigem: string | null;
  quando: Date;
}

const MAX_TITULO = 120;
const MAX_PAGINA = 160;

function paginaResumida(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "").slice(0, MAX_PAGINA);
  } catch {
    return null;
  }
}

function dataBr(data: Date): string {
  return data.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Linha do bloco CONTEXTO. Pura, para teste. */
export function descreverFormularioRecente(f: FormularioRecente): string {
  const partes = [`preencheu o formulário de interesse "${f.titulo.slice(0, MAX_TITULO)}" em ${dataBr(f.quando)}`];
  if (f.grupo) partes.push(`grupo ${f.grupo}`);
  const pagina = paginaResumida(f.paginaOrigem);
  if (pagina) partes.push(`pela página ${pagina}`);
  return `formulario_recente: ${partes.join(", ")}. ` +
    `Não informe preço de evento.\n${REGRA_CONTATO_APOS_FORMULARIO}`;
}

/** Último formulário de interesse que abriu um cartão ainda aberto desta pessoa; nulo se não houver. */
export async function carregarFormularioRecente(pessoaId: number): Promise<FormularioRecente | null> {
  const [cartao] = await db.select({ id: commercialOpportunities.id, offerLabel: commercialOpportunities.offerLabel })
    .from(commercialOpportunities)
    .where(and(
      eq(commercialOpportunities.pessoaId, pessoaId),
      sql`${commercialOpportunities.stage} <> 'CLOSED'`,
      eq(commercialOpportunities.source, "SOFIA_INTERESSE"),
      // O cartão "Conversa no WhatsApp" também nasce como interesse da Sofia, mas não vem de formulário:
      // sem este corte ele esconderia o cartão do formulário, que é anterior.
      ne(commercialOpportunities.offerIdentity, CONVERSA_IDENTIDADE),
    ))
    .orderBy(desc(commercialOpportunities.createdAt), desc(commercialOpportunities.id)).limit(1);
  if (!cartao) return null;
  const [evento] = await db.select({ metadata: commercialOpportunityEvents.metadata, createdAt: commercialOpportunityEvents.createdAt })
    .from(commercialOpportunityEvents)
    .where(and(
      eq(commercialOpportunityEvents.opportunityId, cartao.id),
      inArray(commercialOpportunityEvents.source, ["FORMULARIO_INTERESSE", "FORMULARIO_EVENTO"]),
    ))
    .orderBy(asc(commercialOpportunityEvents.createdAt), asc(commercialOpportunityEvents.id)).limit(1);
  if (!evento) return null;
  const envio = (evento.metadata as { formSubmission?: { grupo?: unknown; paginaOrigem?: unknown } } | null)?.formSubmission;
  const grupo = typeof envio?.grupo === "string" ? interestGroupLabel(envio.grupo) ?? null : null;
  const pagina = typeof envio?.paginaOrigem === "string" ? envio.paginaOrigem : null;
  return { titulo: cartao.offerLabel ?? "interesse", grupo, paginaOrigem: pagina, quando: evento.createdAt };
}
