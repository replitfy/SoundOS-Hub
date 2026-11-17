import { and, desc, eq, sql } from "drizzle-orm";
import { db, pessoasTable, conversations, canalContatos } from "@workspace/db";
import { normalizeBrazilianPhone } from "./phone";
import { chaveDoContatoWhatsapp } from "./sofiaCanalWhatsapp";
import { OpportunityRuleError, type OpportunityActor } from "./commercialOpportunities";
import { exigirHumano, registrarAcaoNosCartoesAbertos } from "./crmAtendimento";

// Como a ficha de uma pessoa se liga à conversa de WhatsApp dela. O telefone é só um sinal de busca: ele
// nunca vincula sozinho. Se a conversa do número ainda não tem ficha, a equipe confirma (com registro);
// se o número está em mais de uma ficha ativa, ou a conversa é de outra ficha, nada é escolhido.

/** `sem_telefone`: a ficha não tem celular. É diferente de `telefone_invalido`, que é um número preenchido que não serve. */
export type MotivoDeTelefone = "sem_telefone" | "telefone_invalido" | "telefone_estrangeiro";

export type TelefoneDeEnvio =
  | { ok: true; chave: string; destino: string }
  | { ok: false; motivo: MotivoDeTelefone };

/** Só telefone do Brasil: o destino é 55 + DDD + número. Número com "+" de outro país não recebe. */
export function telefoneDeEnvio(celular: string | null | undefined): TelefoneDeEnvio {
  const bruto = (celular ?? "").trim();
  if (bruto === "") return { ok: false, motivo: "sem_telefone" };
  const digitos = bruto.replace(/\D/g, "");
  if (bruto.startsWith("+") && !digitos.startsWith("55")) return { ok: false, motivo: "telefone_estrangeiro" };
  const normalizado = normalizeBrazilianPhone(celular);
  if (!normalizado.valid || !normalizado.key) return { ok: false, motivo: "telefone_invalido" };
  return { ok: true, chave: normalizado.key, destino: `55${normalizado.key}` };
}

export type VinculoDaConversa =
  | { tipo: "vinculada"; conversationId: number }
  | { tipo: "a_confirmar"; conversationId: number }
  | { tipo: "nenhuma" }
  | { tipo: "bloqueada"; motivo: "telefone_em_varias_fichas" | "conversa_de_outra_ficha" | MotivoDeTelefone };

export interface PessoaDeContato {
  id: number;
  nome: string;
  celular: string | null;
  arquivadoEm: Date | null;
  mergedIntoPessoaId: number | null;
}

export async function carregarPessoaDeContato(pessoaId: number): Promise<PessoaDeContato | null> {
  const [pessoa] = await db.select({
    id: pessoasTable.id, nome: pessoasTable.nome, celular: pessoasTable.celular,
    arquivadoEm: pessoasTable.arquivadoEm, mergedIntoPessoaId: pessoasTable.mergedIntoPessoaId,
  }).from(pessoasTable).where(eq(pessoasTable.id, pessoaId)).limit(1);
  return pessoa ?? null;
}

/** Quantas fichas ativas (não unidas, não arquivadas) têm este telefone. */
export async function contarFichasAtivasComTelefone(chave: string): Promise<number> {
  const [linha] = await db.select({ total: sql<number>`count(*)::int` }).from(pessoasTable)
    .where(and(
      sql`${pessoasTable.celularNormalizado} = ${chave}`,
      sql`${pessoasTable.mergedIntoPessoaId} IS NULL`,
      sql`${pessoasTable.arquivadoEm} IS NULL`,
    ));
  return linha?.total ?? 0;
}

export interface FichaComMesmoTelefone {
  id: number;
  codigo: string;
  nome: string;
  sobrenome: string | null;
  email: string | null;
  celular: string | null;
}

/** As fichas ativas que têm o telefone desta pessoa: o que a equipe precisa ver para unir ou escolher a certa. */
export async function listarFichasAtivasComTelefone(celular: string | null | undefined): Promise<FichaComMesmoTelefone[]> {
  const telefone = telefoneDeEnvio(celular);
  if (!telefone.ok) return [];
  return db.select({
    id: pessoasTable.id, codigo: pessoasTable.codigo, nome: pessoasTable.nome, sobrenome: pessoasTable.sobrenome,
    email: pessoasTable.email, celular: pessoasTable.celular,
  }).from(pessoasTable)
    .where(and(
      sql`${pessoasTable.celularNormalizado} = ${telefone.chave}`,
      sql`${pessoasTable.mergedIntoPessoaId} IS NULL`,
      sql`${pessoasTable.arquivadoEm} IS NULL`,
    ))
    .orderBy(pessoasTable.id);
}

export async function localizarConversaWhatsapp(pessoa: PessoaDeContato): Promise<VinculoDaConversa> {
  const telefone = telefoneDeEnvio(pessoa.celular);

  const ligadas = await db.select({ id: conversations.id, canalUsuario: conversations.canalUsuario }).from(conversations)
    .where(and(eq(conversations.pessoaId, pessoa.id), eq(conversations.canal, "whatsapp")))
    .orderBy(desc(conversations.createdAt), desc(conversations.id));
  if (ligadas.length > 0) {
    // Se houver mais de uma (números diferentes), vale a do telefone da ficha; senão, a mais recente.
    const doTelefone = telefone.ok
      ? ligadas.find(c => c.canalUsuario && chaveDoContatoWhatsapp(c.canalUsuario) === telefone.chave)
      : undefined;
    return { tipo: "vinculada", conversationId: (doTelefone ?? ligadas[0]!).id };
  }

  if (!telefone.ok) return { tipo: "bloqueada", motivo: telefone.motivo };

  const [contato] = await db.select({ conversationId: canalContatos.conversationId }).from(canalContatos)
    .where(and(eq(canalContatos.canal, "whatsapp"), eq(canalContatos.contatoExternoId, telefone.chave))).limit(1);
  if (!contato) return { tipo: "nenhuma" };

  const [conversa] = await db.select({ id: conversations.id, pessoaId: conversations.pessoaId }).from(conversations)
    .where(eq(conversations.id, contato.conversationId)).limit(1);
  if (!conversa) return { tipo: "nenhuma" };
  if (conversa.pessoaId === pessoa.id) return { tipo: "vinculada", conversationId: conversa.id };
  if (conversa.pessoaId !== null) return { tipo: "bloqueada", motivo: "conversa_de_outra_ficha" };

  // Conversa sem ficha: só vira proposta de vínculo se o número identifica uma única ficha ativa, esta.
  if (pessoa.arquivadoEm !== null || pessoa.mergedIntoPessoaId !== null) return { tipo: "bloqueada", motivo: "telefone_em_varias_fichas" };
  const fichas = await contarFichasAtivasComTelefone(telefone.chave);
  if (fichas !== 1) return { tipo: "bloqueada", motivo: "telefone_em_varias_fichas" };
  return { tipo: "a_confirmar", conversationId: conversa.id };
}

/**
 * A equipe confirma que a conversa do número é desta pessoa. Refaz a análise no servidor (só vincula quando
 * ela ainda é "a confirmar" para a mesma conversa) e registra o vínculo no histórico dos cartões abertos.
 */
export async function confirmarVinculoDaConversa(input: { pessoaId: number; conversationId: number; actor: OpportunityActor }): Promise<void> {
  exigirHumano(input.actor);
  const pessoa = await carregarPessoaDeContato(input.pessoaId);
  if (!pessoa) throw new OpportunityRuleError("Pessoa não encontrada.", "PERSON_NOT_FOUND", 404);
  const vinculo = await localizarConversaWhatsapp(pessoa);
  if (vinculo.tipo === "vinculada" && vinculo.conversationId === input.conversationId) return;
  if (vinculo.tipo !== "a_confirmar" || vinculo.conversationId !== input.conversationId) {
    throw new OpportunityRuleError("Esta conversa não pode ser vinculada a esta ficha.", "LINK_NOT_ALLOWED", 409);
  }
  await db.transaction(async (tx) => {
    const atualizadas = await tx.update(conversations).set({ pessoaId: input.pessoaId })
      .where(and(eq(conversations.id, input.conversationId), sql`${conversations.pessoaId} IS NULL`, eq(conversations.canal, "whatsapp")))
      .returning({ id: conversations.id });
    if (atualizadas.length === 0) throw new OpportunityRuleError("A conversa já foi vinculada.", "LINK_NOT_ALLOWED", 409);
    await registrarAcaoNosCartoesAbertos(tx, input.pessoaId, input.actor, "CONVERSATION_LINKED", { conversationId: input.conversationId });
  });
}
