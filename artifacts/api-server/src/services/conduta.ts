// Conduta comercial da Sofia (Documento 15 — Playbook Comercial da Sofia).
//
// O contrato define dois agentes (Triagem / Comercial) que não precisam ser
// dois serviços separados: a mesma rota de chat aplica um bloco de instruções
// diferente por mensagem, dependendo do quanto já se sabe e confia sobre a
// pessoa. Este módulo decide qual conduta está ativa e fornece o texto de
// cada bloco, além dos gatilhos de escalonamento específicos da conduta
// comercial (reaproveitando o mecanismo de handoff já existente).

import { db, pessoaEvidencias, condutaConfigTable } from "@workspace/db";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { isTransactionAdvancementRequest } from "./commercialIntent";

export const CONDUTAS = ["triagem", "comercial"] as const;
export type Conduta = (typeof CONDUTAS)[number];

// Temperaturas relacionais (Documento 14A) a partir das quais a pessoa já
// mostra engajamento suficiente para uma conversa comercial mais direta.
// "inativo", "latente" e "frio" continuam em triagem/relação.
const TEMPERATURAS_PRONTAS_PARA_COMERCIAL = new Set(["morno", "quente", "muito_quente"]);

// Campos cuja confiança acumulada em pessoa_evidencias sustenta a transição
// para conduta comercial (os mesmos usados no critério de leitura de perfil).
const CAMPOS_CONFIANCA_COMERCIAL = ["perfilPrincipal", "intencaoPrincipal"] as const;

export interface PessoaConductSignals {
  pessoaId: number | null;
  perfilPrincipal: string | null;
  intencaoPrincipal: string | null;
  temperatura: string | null;
}

/**
 * Critério de transição (Documento 14 → Documento 15): a conduta só passa
 * para "comercial" quando já existe (a) uma leitura de perfil, (b) uma
 * intenção principal identificada, (c) temperatura relacional favorável, e
 * (d) pelo menos uma dessas leituras tem confiança média/alta registrada em
 * pessoa_evidencias — uma única inferência de baixa confiança não é suficiente
 * para a Sofia começar a recomendar. Sem ficha vinculada, é sempre triagem.
 */
// Número mínimo de inferências independentes da Sofia por campo classificatório
// para que a convergência de baixa confiança seja aceita como sinal suficiente
// de transição — evita que a conversa fique presa em triagem indefinidamente
// quando nenhum caminho normal produz evidência de confiança média/alta.
export const CONVERGENCIA_MINIMA_POR_CAMPO = 3;

export async function determineConduta(signals: PessoaConductSignals): Promise<Conduta> {
  const { pessoaId, perfilPrincipal, intencaoPrincipal, temperatura } = signals;

  if (!pessoaId || !perfilPrincipal || !intencaoPrincipal) return "triagem";
  if (!temperatura || !TEMPERATURAS_PRONTAS_PARA_COMERCIAL.has(temperatura)) return "triagem";

  // Critério primário: qualquer evidência de confiança média/alta nos campos
  // classificatórios já é suficiente (declarada, validada por humano,
  // comportamental, relacional…). Limitamos a 1 porque só precisamos de um
  // único resultado positivo — sem risco de esconder linhas qualificadas.
  const confidentRows = await db
    .select({ nivelConfianca: pessoaEvidencias.nivelConfianca })
    .from(pessoaEvidencias)
    .where(and(
      eq(pessoaEvidencias.pessoaId, pessoaId),
      inArray(pessoaEvidencias.campo, [...CAMPOS_CONFIANCA_COMERCIAL]),
      inArray(pessoaEvidencias.nivelConfianca, ["media", "alta"]),
    ))
    .limit(1);

  if (confidentRows.length > 0) return "comercial";

  // Critério de segurança (safety net): quando a Sofia (origem = 'sofia',
  // tipoEvidencia = 'inferida') inferiu os dois campos classificatórios pelo
  // menos CONVERGENCIA_MINIMA_POR_CAMPO vezes cada, a repetição consistente de
  // inferências ao longo da conversa é sinal de convergência suficiente para a
  // transição. Usamos COUNT por campo — sem LIMIT — para não esconder linhas
  // antigas quando o outro campo tem muitas linhas recentes.
  const convergenciaCounts = await Promise.all(
    CAMPOS_CONFIANCA_COMERCIAL.map(async (campo) => {
      const [row] = await db
        .select({ total: count() })
        .from(pessoaEvidencias)
        .where(and(
          eq(pessoaEvidencias.pessoaId, pessoaId),
          eq(pessoaEvidencias.campo, campo),
          eq(pessoaEvidencias.tipoEvidencia, "inferida"),
          sql`${pessoaEvidencias.origem} like 'sofia%'`,
        ));
      return row?.total ?? 0;
    }),
  );

  const hasConvergence = convergenciaCounts.every(
    (total) => total >= CONVERGENCIA_MINIMA_POR_CAMPO,
  );
  return hasConvergence ? "comercial" : "triagem";
}

// ── Blocos de conduta (Documento 14 / Documento 15) ───────────────────────
//
// Estes textos podem ser sobrescritos por um admin via a tabela
// conduta_config (linha única, id fixo = 1) — ver getCondutaConfig/
// saveCondutaConfig abaixo. As constantes DEFAULT_* abaixo continuam sendo o
// texto usado enquanto ninguém customizou nada, e o valor ao qual "voltar ao
// padrão" retorna.

const CONDUTA_CONFIG_ID = 1;

const DEFAULT_TRIAGEM_BLOCK = `MODO ATIVO: TRIAGEM (Documento 14 — Sofia ainda está entendendo a pessoa)
— Perguntas informacionais diretas sobre eventos, cursos ou produtos têm prioridade absoluta sobre a triagem.
— Responda somente o que foi perguntado, de preferência em uma a três linhas. Não mostre fontes, ferramentas, documentos, regras internas ou dados de auditoria.
— Depois de responder um fato suficiente, pare: não cumprimente, não retome a triagem e não termine com pergunta de continuidade.
— Só peça um esclarecimento curto quando houver ambiguidade real sobre qual item foi mencionado.
— Quando a pessoa pedir orientação personalizada e for realmente necessário compreender seu contexto, faça uma pergunta por vez, sem pressa.
— Valide hipóteses antes de afirmar algo sobre o perfil, intenção ou momento dela.
— Não transforme uma resposta factual em recomendação. Recomendar uma oferta, curso, experiência ou instrumento ainda é cedo demais.`;

const DEFAULT_COMERCIAL_BLOCK = `MODO ATIVO: COMERCIAL (Documento 15 — Playbook Comercial da Sofia)
Já existe confiança relacional suficiente (perfil, intenção e temperatura favoráveis) para conversar de forma mais
direta sobre o caminho desta pessoa — isso NÃO significa que a elegibilidade para uma oferta específica já está
confirmada. Antes de nomear qualquer oferta você ainda precisa validar isso na própria conversa. Regras:
— Pergunta direta primeiro: responda somente o que foi perguntado, de preferência em uma a três linhas. Não mostre fontes, ferramentas, documentos, regras internas ou dados de auditoria.
— Preço, link e disponibilidade podem ser informados quando a consulta oficial desta conversa os retornar. Nunca invente nem complete dados ausentes.
— Depois de responder um fato suficiente, pare: não retome entrevista, não faça oferta adicional e não termine com pergunta de continuidade.
— Pessoa antes da oferta: continue partindo do que já foi dito sobre ela, nunca do produto.
— Elegibilidade antes do interesse: entusiasmo não autoriza recomendação. Antes de nomear uma oferta mais avançada,
  confirme explicitamente com a pessoa se ela já tem o pré-requisito/experiência anterior esperado. Se ela não tiver,
  ou se isso ficar contraditório/confuso na conversa, chame a tool escalateToHuman (motivo elegibilidade_insuficiente
  ou sinais_contraditorios) imediatamente — não espere a pessoa insistir, não tente resolver sozinha.
— Convite antes de pressão: só depois de confirmar pré-requisito, nomeie uma oferta principal e uma alternativa
  coerente (upsell/downsell/cross-sell), sempre ligadas a algo que a pessoa já demonstrou — nunca "porque é
  estratégico para o negócio".
— Sugira um próximo passo concreto e humano (ex.: conversar com a equipe, conhecer melhor um curso/experiência),
  nunca force fechamento.
— Pausa é uma resposta comercial legítima: se houver sinal de dúvida, fragilidade ou pedido de tempo, não insista.`;

// Vale para as duas condutas: preço, desconto, disponibilidade, parcelamento,
// cupom e link de checkout dependem de documentos comerciais (18/18A/18B)
// ainda não entregues à Sofia — ela nunca inventa esse dado, em nenhum modo,
// mesmo na primeira mensagem da pessoa.
const DEFAULT_FORBIDDEN_COMMERCIAL_DATA_BLOCK = `RESTRIÇÃO COMERCIAL (vale em qualquer modo, mesmo na primeira mensagem):
Nunca invente preço, link, disponibilidade, vaga ou estoque. Preço, link e disponibilidade só podem ser informados
quando a consulta oficial desta conversa os retornar. Nunca revele quantidade exata de estoque, desconto, cupom,
parcelamento, condição especial ou checkout. Pedido para comprar, reservar, pagar ou se inscrever exige atendimento humano.`;

export interface CondutaConfig {
  triagemBlock: string;
  comercialBlock: string;
  forbiddenBlock: string;
  triagemIsDefault: boolean;
  comercialIsDefault: boolean;
  forbiddenIsDefault: boolean;
  updatedAt: string | null;
  fastPathEnabled: boolean;
  /** Valor gravado em conduta_config.sofia_mode. */
  sofiaMode: SofiaMode;
  /** Env SOFIA_MODE, quando definida com valor válido; vence a coluna. */
  sofiaModeEnvOverride: SofiaMode | null;
  /** Modo efetivamente usado pelo /sofia/chat agora. */
  sofiaModeEffective: SofiaMode;
}

export type SofiaMode = "legacy" | "simple";

export function isSofiaMode(value: unknown): value is SofiaMode {
  return value === "legacy" || value === "simple";
}

/** Env SOFIA_MODE vence a coluna; valor inválido na env é ignorado. */
export function sofiaModeFromEnv(env: NodeJS.ProcessEnv = process.env): SofiaMode | null {
  const raw = env.SOFIA_MODE?.trim().toLowerCase();
  return isSofiaMode(raw) ? raw : null;
}

/**
 * Lê a conduta_config ativa (linha única) direto do banco a cada chamada —
 * sem cache, igual ao padrão já usado para prompts — para que uma edição do
 * admin valha já na próxima mensagem, sem deploy/restart. Campos em branco
 * (null ou string vazia) caem para o texto padrão embutido no código.
 */
export async function getCondutaConfig(): Promise<CondutaConfig> {
  const [row] = await db
    .select()
    .from(condutaConfigTable)
    .where(eq(condutaConfigTable.id, CONDUTA_CONFIG_ID))
    .limit(1);

  const triagemCustom = row?.triagemBlock?.trim() || null;
  const comercialCustom = row?.comercialBlock?.trim() || null;
  const forbiddenCustom = row?.forbiddenBlock?.trim() || null;

  return {
    triagemBlock: triagemCustom ?? DEFAULT_TRIAGEM_BLOCK,
    comercialBlock: comercialCustom ?? DEFAULT_COMERCIAL_BLOCK,
    forbiddenBlock: forbiddenCustom ?? DEFAULT_FORBIDDEN_COMMERCIAL_DATA_BLOCK,
    triagemIsDefault: triagemCustom === null,
    comercialIsDefault: comercialCustom === null,
    forbiddenIsDefault: forbiddenCustom === null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    fastPathEnabled: row?.fastPathEnabled ?? false,
    sofiaMode: isSofiaMode(row?.sofiaMode) ? row.sofiaMode : "simple",
    sofiaModeEnvOverride: sofiaModeFromEnv(),
    sofiaModeEffective: sofiaModeFromEnv() ?? (isSofiaMode(row?.sofiaMode) ? row.sofiaMode : "simple"),
  };
}

/**
 * Modo da Sofia resolvido a cada requisição (sem cache) para permitir
 * troca imediata: env SOFIA_MODE > conduta_config.sofia_mode > "simple" (padrão).
 */
export async function resolveSofiaMode(): Promise<SofiaMode> {
  const fromEnv = sofiaModeFromEnv();
  if (fromEnv) return fromEnv;
  const [row] = await db
    .select({ sofiaMode: condutaConfigTable.sofiaMode })
    .from(condutaConfigTable)
    .where(eq(condutaConfigTable.id, CONDUTA_CONFIG_ID))
    .limit(1);
  return isSofiaMode(row?.sofiaMode) ? row.sofiaMode : "simple";
}

export interface CondutaConfigInput {
  triagemBlock?: string | null;
  comercialBlock?: string | null;
  forbiddenBlock?: string | null;
  fastPathEnabled?: boolean;
  sofiaMode?: SofiaMode;
}

/**
 * Grava a conduta_config (upsert na linha única). Passar null ou string
 * vazia para um campo faz esse bloco voltar a usar o texto padrão.
 */
export async function saveCondutaConfig(input: CondutaConfigInput): Promise<CondutaConfig> {
  const [existing] = await db.select({ fastPathEnabled: condutaConfigTable.fastPathEnabled, sofiaMode: condutaConfigTable.sofiaMode })
    .from(condutaConfigTable).where(eq(condutaConfigTable.id, CONDUTA_CONFIG_ID)).limit(1);
  const values = {
    triagemBlock: input.triagemBlock?.trim() ? input.triagemBlock : null,
    comercialBlock: input.comercialBlock?.trim() ? input.comercialBlock : null,
    forbiddenBlock: input.forbiddenBlock?.trim() ? input.forbiddenBlock : null,
    // Partial admin updates must not silently turn off an active rollout.
    fastPathEnabled: input.fastPathEnabled ?? existing?.fastPathEnabled ?? false,
    // Mesmo cuidado: PUT parcial não pode desligar o modo simples sem querer.
    sofiaMode: input.sofiaMode ?? (isSofiaMode(existing?.sofiaMode) ? existing.sofiaMode : "simple"),
  };

  await db
    .insert(condutaConfigTable)
    .values({ id: CONDUTA_CONFIG_ID, ...values })
    .onConflictDoUpdate({ target: condutaConfigTable.id, set: values });

  return getCondutaConfig();
}

/** Bloco de instruções a anexar ao system prompt, de acordo com a conduta ativa. */
export async function condutaPromptBlock(conduta: Conduta, fastPathEnabled = true): Promise<string> {
  const config = await getCondutaConfig();
  let base = conduta === "comercial" ? config.comercialBlock : config.triagemBlock;
  if (!fastPathEnabled) {
    base = base.split("\n").filter(line =>
      !/Exceção:|Pergunta direta primeiro:|Depois de responder o fato|Isso nunca vale para preço/.test(line)
    ).join("\n");
  }
  return `\n\n---\n${base}\n\n${config.forbiddenBlock}` +
    `\n\nPOLÍTICA OFICIAL MAIS RECENTE (tem precedência sobre restrições comerciais antigas acima): ` +
    `quando vierem de fonte oficial consultada nesta conversa, você pode informar preço, link e ` +
    `disponibilidade. Nunca revele quantidade exata em estoque, desconto, cupom ou condições especiais ` +
    `de pagamento. Perguntas factuais devem ser respondidas antes de qualquer triagem, somente com os ` +
    `campos pedidos, sem citar a fonte e sem encerrar com pergunta de continuidade.`;
}

// ── Gatilhos de escalonamento comercial (checados sobre a mensagem da
// pessoa, apenas quando a conduta comercial está ativa) ───────────────────
// Ambiguidade e elegibilidade insuficiente dependem de julgamento sobre o
// histórico da conversa — mais confiável vindo da própria Sofia via tool call
// (ver escalateCommercialTool em sofia.ts) do que por regex. Pedido de
// fechamento, por outro lado, tem padrões de linguagem previsíveis e é
// checado aqui, na mensagem da pessoa, antes mesmo de acionar a Sofia.
const CLOSING_REQUEST_PATTERNS = [
  /\bquero (comprar|fechar|contratar|adquirir|me inscrever)\b/i,
  /\bcomo (fa[çc]o para|eu) (pagar|comprar|fechar|me inscrever)\b/i,
  /\b(fazer|realizar|finalizar|concluir|confirmar|efetivar) (a |minha )?inscri[çc][ãa]o\b/i,
  /\bmanda(r)?(-me)? o link( de pagamento| de inscri[çc][ãa]o| de checkout)?\b/i,
  /\bqual([ée]| é)? (o |a )?(pre[çc]o|valor)\b/i,
  /\bpre[çc]o (do|da|de)\b/i,
  /\bquanto (custa|[ée] o valor|fica|sai)\b/i,
  /\btem desconto\b|\bcupom\b/i,
  /\bposso parcelar\b|\bem quantas vezes\b|\bformas de pagamento\b/i,
  /\btem vaga\b|\bainda tem disponibilidade\b|\bainda d[áa] tempo\b/i,
];

export function detectClosingRequest(userMessage: string): boolean {
  return isTransactionAdvancementRequest(userMessage) ||
    CLOSING_REQUEST_PATTERNS.some((p) => p.test(userMessage));
}

const RESTRICTED_COMMERCIAL_DATA_PATTERN =
  /\b(desconto|cupom|parcelar|parcelamento|formas? de pagamento|condi[çc][oõ]es? especiais|checkout|pagar|pagamento)\b|(?:\b(fazer|realizar|finalizar|concluir|confirmar|efetivar) (?:a |minha )?inscri[çc][ãa]o\b)/i;
const COMMERCIAL_LEAKAGE_PATTERN =
  /(?:\b(desconto|cupom|parcelar|parcelamento|formas? de pagamento|vaga|disponibilidade|estoque|checkout|link de pagamento|link para comprar|link de inscri[çc][ãa]o|inscri[çc][ãa]o|contratar|pre[çc]o|valor|quanto custa|combien|prix|réduction|promo(?:tion)?|coupon|paiement|disponibilit[ée]|places?|stock)\b|(?:R\$|US\$|€|£)\s*\d|(?:\d[\d.,]*)\s*(?:reais|euros?|dollars?|€|£))/iu;

/** Dados que continuam exclusivos do atendimento humano, mesmo para produtos Wix. */
export function needsHumanCommercialData(userMessage: string): boolean {
  return isTransactionAdvancementRequest(userMessage) ||
    RESTRICTED_COMMERCIAL_DATA_PATTERN.test(userMessage);
}

export function hasCommercialLeakage(text: string): boolean {
  return COMMERCIAL_LEAKAGE_PATTERN.test(text);
}
