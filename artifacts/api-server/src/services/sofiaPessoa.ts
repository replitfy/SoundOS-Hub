import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { conteudoParaASofia } from "./anexosConteudo.js";
import { conversations, db, messages, pessoasTable } from "@workspace/db";
import { filtrarAtualizacaoInferida, filtrarAtualizacaoSofia, registrarEvidencia } from "./evidencias.js";
import { namesLikelySame } from "./identityMatching.js";
import { normalizeBrazilianPhone } from "./phone.js";
import { isPgUniqueViolation } from "../lib/pg-errors.js";
import { logger } from "../lib/logger.js";

/**
 * Identificação de pessoa do modo simples, feita pelo backend antes do LLM e
 * nunca exposta ao modelo. Em qualquer dúvida a conversa segue anônima e
 * nenhum dado de ficha existente é revelado.
 */

export type StatusIdentificacao =
  | "criada"
  | "reconhecida"
  | "nome_divergente"
  | "celular_compartilhado"
  | "ficha_inativa"
  | "celular_invalido"
  | "nome_invalido";

export interface IdentificacaoResultado {
  status: StatusIdentificacao;
  pessoaId: number | null;
  primeiroNome: string | null;
  temHistorico: boolean;
}

const PLACEHOLDER_CRIACAO = "(ficha em criação)";
const NOMES_PLACEHOLDER = new Set(["nathalia", "ficha em criacao", "sem nome", "fulano de tal", "fulano"]);

function normalizarNome(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Ficha aberta pelo Instagram só com o @usuário: o nome verdadeiro ainda não foi dito. */
const NOME_SO_COM_USUARIO = /^@[A-Za-z0-9._]{1,30}$/;

/**
 * Ficha aberta pelo WhatsApp: o nome de perfil (não confirmado) ganha o sufixo "(WhatsApp)"; sem um nome
 * de perfil aproveitável, "WhatsApp +<telefone>". Em ambos o nome verdadeiro ainda não foi dito.
 */
const SUFIXO_PERFIL_WHATSAPP = " (WhatsApp)";
const NOME_DE_PERFIL_WHATSAPP = /\s\(WhatsApp\)$/i;
const NOME_SO_COM_TELEFONE_WHATSAPP = /^WhatsApp \+\d{8,15}$/i;

/** Nome provisório da ficha criada pelo WhatsApp. Nunca é tratado como nome confirmado. */
export function nomeProvisorioWhatsapp(perfil: string | null | undefined, telefoneComPais: string): string {
  const limpo = (perfil ?? "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s'.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  if (/\p{L}{2}/u.test(limpo) && !nomeEhPlaceholder(limpo)) return `${limpo}${SUFIXO_PERFIL_WHATSAPP}`;
  return `WhatsApp +${telefoneComPais.replace(/\D/g, "")}`;
}

export function nomeEhPlaceholder(nome: string | null | undefined): boolean {
  const aparado = (nome ?? "").trim();
  if (NOME_SO_COM_USUARIO.test(aparado)) return true;
  if (NOME_DE_PERFIL_WHATSAPP.test(aparado) || NOME_SO_COM_TELEFONE_WHATSAPP.test(aparado)) return true;
  const normalizado = normalizarNome(nome ?? "");
  return !normalizado || NOMES_PLACEHOLDER.has(normalizado);
}

export function primeiroNomeDe(nome: string | null | undefined): string | null {
  if (nomeEhPlaceholder(nome)) return null;
  const [primeiro] = nome!.trim().split(/\s+/);
  return primeiro ?? null;
}

interface LinhaFicha {
  id: number;
  nome: string | null;
  sobrenome: string | null;
  ativo: boolean;
  arquivado_em: Date | string | null;
}

function nomeCompativel(linha: LinhaFicha, nome: string): boolean {
  if (nomeEhPlaceholder(linha.nome)) return true;
  const completo = [linha.nome, linha.sobrenome].filter(Boolean).join(" ");
  return namesLikelySame(completo, nome);
}

/**
 * Regra de decisão pura. Celular com várias fichas só reconhece quando
 * exatamente uma delas tem nome compatível.
 */
export function decidirIdentificacao(
  linhas: LinhaFicha[],
  nome: string,
): { status: "criar" } | { status: "reconhecida" | "ficha_inativa"; linha: LinhaFicha } | { status: "nome_divergente" | "celular_compartilhado" } {
  if (linhas.length === 0) return { status: "criar" };
  const compativeis = linhas.filter(linha => nomeCompativel(linha, nome));
  if (compativeis.length !== 1) {
    return { status: linhas.length > 1 ? "celular_compartilhado" : "nome_divergente" };
  }
  const linha = compativeis[0]!;
  return { status: !linha.ativo || linha.arquivado_em ? "ficha_inativa" : "reconhecida", linha };
}

async function temConversaAnterior(pessoaId: number, conversaAtualId: number | null): Promise<boolean> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(
      eq(conversations.pessoaId, pessoaId),
      ...(conversaAtualId ? [ne(conversations.id, conversaAtualId)] : []),
    ))
    .limit(1);
  return Boolean(row);
}

type TxPessoa = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * `nome` é NOT NULL: a ficha nasce com um placeholder registrado como evidência
 * de sistema (auditável) e o nome verdadeiro entra depois, pelo mesmo mecanismo
 * de evidências que protege campos confirmados por humanos.
 */
async function inserirFichaEmCriacao(tx: TxPessoa): Promise<number> {
  let pessoaId: number | undefined;
  for (let tentativa = 0; tentativa < 5 && pessoaId === undefined; tentativa++) {
    const codigo = `PS-${Math.floor(100000 + Math.random() * 900000)}`;
    try {
      // Savepoint: uma colisão de código não pode abortar a transação inteira.
      const [row] = await tx.transaction(inner =>
        inner.insert(pessoasTable).values({ codigo, nome: PLACEHOLDER_CRIACAO }).returning({ id: pessoasTable.id }));
      pessoaId = row!.id;
    } catch (err) {
      if (!isPgUniqueViolation(err, "codigo") || tentativa === 4) throw err;
    }
  }
  await registrarEvidencia({
    pessoaId: pessoaId!, campo: "nome", valor: PLACEHOLDER_CRIACAO,
    tipoEvidencia: "inferida", origem: "sistema:placeholder-criacao", aplicada: true,
  }, tx);
  return pessoaId!;
}

export async function identificarOuCriarPessoa(input: {
  nome: string | null | undefined;
  celular: string | null | undefined;
  conversationId: number | null;
}): Promise<IdentificacaoResultado> {
  const anonimo = (status: StatusIdentificacao): IdentificacaoResultado =>
    ({ status, pessoaId: null, primeiroNome: null, temHistorico: false });
  const telefone = normalizeBrazilianPhone(input.celular);
  const nome = input.nome?.trim() ?? "";
  let resultado: IdentificacaoResultado;
  if (!telefone.valid || !telefone.key) {
    resultado = anonimo("celular_invalido");
  } else if (nomeEhPlaceholder(nome)) {
    resultado = anonimo("nome_invalido");
  } else {
    resultado = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pessoa-phone:${telefone.key}`}, 0))`);
      const encontrados = await tx.execute(sql`
        SELECT id, nome, sobrenome, ativo, arquivado_em
        FROM pessoas
        WHERE celular_normalizado = ${telefone.key} AND merged_into_pessoa_id IS NULL
        ORDER BY id
        FOR UPDATE`);
      const decisao = decidirIdentificacao(encontrados.rows as unknown as LinhaFicha[], nome);
      if (decisao.status === "nome_divergente" || decisao.status === "celular_compartilhado" || decisao.status === "ficha_inativa") {
        return anonimo(decisao.status);
      }
      if (decisao.status === "reconhecida") {
        const { linha } = decisao;
        if (nomeEhPlaceholder(linha.nome)) {
          const { aplicaveis } = await filtrarAtualizacaoSofia(linha.id, { nome }, tx);
          if (Object.keys(aplicaveis).length > 0) {
            await tx.update(pessoasTable).set({ ...aplicaveis, updatedAt: new Date() }).where(eq(pessoasTable.id, linha.id));
          }
        }
        return {
          status: "reconhecida" as const,
          pessoaId: linha.id,
          primeiroNome: primeiroNomeDe(linha.nome) ?? primeiroNomeDe(nome),
          temHistorico: false,
        };
      }
      const pessoaId = await inserirFichaEmCriacao(tx);
      const { aplicaveis } = await filtrarAtualizacaoSofia(pessoaId, { nome, celular: input.celular!.trim() }, tx);
      if (Object.keys(aplicaveis).length > 0) {
        await tx.update(pessoasTable).set({ ...aplicaveis, updatedAt: new Date() }).where(eq(pessoasTable.id, pessoaId));
      }
      return { status: "criada" as const, pessoaId, primeiroNome: primeiroNomeDe(nome), temHistorico: false };
    });
    if (resultado.status === "reconhecida" && resultado.pessoaId) {
      resultado.temHistorico = await temConversaAnterior(resultado.pessoaId, input.conversationId);
    }
  }
  // Sem telefone nem nome no log.
  logger.info({ status: resultado.status, conversationId: input.conversationId }, "Sofia simples: identificação");
  return resultado;
}

// ── Instagram: conversa sem telefone ───────────────────────────────────────

export type StatusIdentificacaoInstagram =
  | "criada"
  | "vinculada"
  | "reconhecida"
  | "usuario_compartilhado"
  | "ficha_inativa"
  | "fora_do_instagram";

export interface IdentificacaoInstagramResultado {
  status: StatusIdentificacaoInstagram;
  /** `null` quando não há ficha segura: nenhum cartão é aberto. */
  pessoaId: number | null;
}

/**
 * @usuário em minúsculas, sem "@", sem aspas de planilha, sem endereço do perfil e
 * sem parâmetros. Valor que não tenha cara de usuário do Instagram (e-mail, frase)
 * vira `null` e nunca casa com nada.
 */
export function normalizarUsuarioInstagram(valor: string | null | undefined): string | null {
  const limpo = (valor ?? "")
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?instagram\.com\//i, "")
    .replace(/^['"@\s]+/, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(limpo) ? limpo : null;
}

interface LinhaFichaInstagram {
  id: number;
  instagram: string | null;
  ativo: boolean;
  arquivado_em: Date | string | null;
}

/**
 * Regra de decisão pura. O @usuário é sinal de busca, como o celular: só uma
 * ficha com exatamente esse usuário e ativa é reconhecida. Mais de uma, ou uma
 * arquivada/inativa, não é escolhida nem recriada: sem ficha segura, sem cartão.
 */
export function decidirIdentificacaoInstagram(
  linhas: LinhaFichaInstagram[],
  usuario: string,
): { status: "criar" } | { status: "reconhecida"; pessoaId: number } | { status: "usuario_compartilhado" | "ficha_inativa" } {
  const casam = linhas.filter(linha => normalizarUsuarioInstagram(linha.instagram) === usuario);
  if (casam.length === 0) return { status: "criar" };
  if (casam.length > 1) return { status: "usuario_compartilhado" };
  const [linha] = casam;
  return !linha!.ativo || linha!.arquivado_em
    ? { status: "ficha_inativa" }
    : { status: "reconhecida", pessoaId: linha!.id };
}

/**
 * Ficha para quem conversa pelo Instagram e não informou telefone, usada quando
 * a Sofia vai abrir o cartão de interesse. Nunca escolhe uma ficha às cegas e
 * nunca cria uma segunda:
 *
 * - a conversa já ligada a uma ficha (pela equipe ou por uma chamada anterior) vence;
 * - uma única ficha ativa com o mesmo @usuário serve ao cartão, mas NÃO é ligada à
 *   conversa: o usuário na ficha é declarado por alguém, e ligar faria a Sofia
 *   revelar o histórico dessa ficha a quem escreve;
 * - nenhuma ficha com o @usuário (ou usuário desconhecido): cria uma, ligada à
 *   conversa, que é 1:1 com o contato do Instagram (portanto idempotente);
 * - várias fichas, ou uma arquivada: sem ficha segura, `pessoaId: null`.
 *
 * Passe `client` para rodar dentro de uma transação já aberta (testes).
 */
export async function identificarOuCriarPessoaDoInstagram(
  input: { conversationId: number },
  client?: TxPessoa,
): Promise<IdentificacaoInstagramResultado> {
  const executar = async (tx: TxPessoa): Promise<IdentificacaoInstagramResultado> => {
    // Duas chamadas simultâneas da mesma conversa (dois eventos na mesma mensagem) entram em fila.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pessoa-conversa:${input.conversationId}`}, 0))`);
    const [conversa] = await tx
      .select({ canal: conversations.canal, canalUsuario: conversations.canalUsuario, pessoaId: conversations.pessoaId })
      .from(conversations)
      .where(eq(conversations.id, input.conversationId))
      .limit(1)
      .for("no key update");
    if (!conversa || conversa.canal !== "instagram") return { status: "fora_do_instagram", pessoaId: null };
    if (conversa.pessoaId !== null) return { status: "vinculada", pessoaId: conversa.pessoaId };

    const usuario = normalizarUsuarioInstagram(conversa.canalUsuario);
    if (usuario) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pessoa-instagram:${usuario}`}, 0))`);
      // A mesma normalização do TypeScript, feita no banco; fichas já fundidas (tombstone) ficam de fora.
      const encontradas = await tx.execute(sql`
        SELECT id, instagram, ativo, arquivado_em
        FROM pessoas
        WHERE merged_into_pessoa_id IS NULL
          AND instagram IS NOT NULL
          AND lower(regexp_replace(
                regexp_replace(btrim(instagram), '^(https?://)?(www[.])?instagram[.]com/', '', 'i'),
                '^[''"@[:space:]]+|[/?#].*$', '', 'g')) = ${usuario}
        ORDER BY id`);
      const decisao = decidirIdentificacaoInstagram(encontradas.rows as unknown as LinhaFichaInstagram[], usuario);
      if (decisao.status === "reconhecida") return { status: "reconhecida", pessoaId: decisao.pessoaId };
      if (decisao.status !== "criar") return { status: decisao.status, pessoaId: null };
    }

    const pessoaId = await inserirFichaEmCriacao(tx);
    if (usuario) {
      const { aplicaveis } = await filtrarAtualizacaoInferida(
        pessoaId, { nome: `@${usuario}`, instagram: usuario }, "sofia:canal-instagram", tx,
      );
      if (Object.keys(aplicaveis).length > 0) {
        await tx.update(pessoasTable).set({ ...aplicaveis, updatedAt: new Date() }).where(eq(pessoasTable.id, pessoaId));
      }
    }
    await tx.update(conversations).set({ pessoaId }).where(eq(conversations.id, input.conversationId));
    return { status: "criada", pessoaId };
  };

  const resultado = await (client ? executar(client) : db.transaction(executar));
  // Sem @usuário no log.
  logger.info({ status: resultado.status, conversationId: input.conversationId }, "Sofia instagram: identificação sem telefone");
  return resultado;
}

// ── WhatsApp: o telefone da conversa é só um sinal de busca ───────────────

export type StatusIdentificacaoWhatsapp =
  | "criada"
  | "vinculada"
  | "reconhecida"
  | "celular_compartilhado"
  | "ficha_inativa"
  | "celular_estrangeiro"
  | "fora_do_whatsapp";

export interface IdentificacaoWhatsappResultado {
  status: StatusIdentificacaoWhatsapp;
  /** `null` quando não há ficha segura: nenhum cartão é aberto. */
  pessoaId: number | null;
}

interface LinhaFichaWhatsapp {
  id: number;
  ativo: boolean;
  arquivado_em: Date | string | null;
}

/**
 * Regra de decisão pura. O telefone do WhatsApp não prova quem escreve (celulares são compartilhados):
 * só uma ficha ativa com exatamente esse telefone serve ao cartão. Mais de uma, ou uma arquivada/inativa,
 * não é escolhida nem recriada: sem ficha segura, sem cartão.
 */
export function decidirIdentificacaoWhatsapp(
  linhas: LinhaFichaWhatsapp[],
): { status: "criar" } | { status: "reconhecida"; pessoaId: number } | { status: "celular_compartilhado" | "ficha_inativa" } {
  if (linhas.length === 0) return { status: "criar" };
  if (linhas.length > 1) return { status: "celular_compartilhado" };
  const [linha] = linhas;
  return !linha!.ativo || linha!.arquivado_em ? { status: "ficha_inativa" } : { status: "reconhecida", pessoaId: linha!.id };
}

/** Número do Brasil como o WhatsApp envia: 55 + DDD + número. */
const BRASIL_COM_PAIS_WHATSAPP = /^55\d{10,11}$/;

/**
 * Ficha para quem conversa pelo WhatsApp, usada quando a Sofia vai abrir o cartão de interesse. Mesmo
 * contrato do Instagram: nunca escolhe uma ficha às cegas e nunca cria uma segunda.
 *
 * - a conversa já ligada a uma ficha (pela equipe ou por chamada anterior) vence;
 * - uma única ficha ativa com o mesmo telefone (com ou sem o 55 na ficha) serve ao cartão, mas NÃO é
 *   ligada à conversa: quem escreve pode não ser o dono do telefone, e ligar faria a Sofia revelar o
 *   histórico dessa ficha;
 * - nenhuma ficha com o telefone: cria uma, ligada à conversa (1:1 com o número, portanto idempotente),
 *   com o telefone do WhatsApp. O nome de perfil do WhatsApp entra só como nome provisório
 *   ("Maria (WhatsApp)", tratado como placeholder): a Sofia o troca assim que a pessoa disser o nome;
 * - várias fichas, uma arquivada ou um número fora do Brasil: sem ficha segura, `pessoaId: null`.
 *
 * Passe `client` para rodar dentro de uma transação já aberta (testes).
 */
export async function identificarOuCriarPessoaDoWhatsapp(
  input: { conversationId: number; /** Nome de perfil do WhatsApp: só vira nome provisório da ficha nova. */ perfilWhatsapp?: string | null },
  client?: TxPessoa,
): Promise<IdentificacaoWhatsappResultado> {
  const executar = async (tx: TxPessoa): Promise<IdentificacaoWhatsappResultado> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pessoa-conversa:${input.conversationId}`}, 0))`);
    const [conversa] = await tx
      .select({ canal: conversations.canal, canalUsuario: conversations.canalUsuario, pessoaId: conversations.pessoaId })
      .from(conversations)
      .where(eq(conversations.id, input.conversationId))
      .limit(1)
      .for("no key update");
    if (!conversa || conversa.canal !== "whatsapp") return { status: "fora_do_whatsapp", pessoaId: null };
    if (conversa.pessoaId !== null) return { status: "vinculada", pessoaId: conversa.pessoaId };

    const digitos = (conversa.canalUsuario ?? "").replace(/\D/g, "");
    const telefone = normalizeBrazilianPhone(digitos);
    // Um número de 10/11 dígitos sem o 55 (por exemplo, dos EUA) seria lido como DDD + número do Brasil.
    if (!BRASIL_COM_PAIS_WHATSAPP.test(digitos) || !telefone.valid || !telefone.key) {
      return { status: "celular_estrangeiro", pessoaId: null };
    }

    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pessoa-phone:${telefone.key}`}, 0))`);
    const encontradas = await tx.execute(sql`
      SELECT id, ativo, arquivado_em
      FROM pessoas
      WHERE celular_normalizado = ${telefone.key} AND merged_into_pessoa_id IS NULL
      ORDER BY id
      FOR UPDATE`);
    const decisao = decidirIdentificacaoWhatsapp(encontradas.rows as unknown as LinhaFichaWhatsapp[]);
    if (decisao.status === "reconhecida") return { status: "reconhecida", pessoaId: decisao.pessoaId };
    if (decisao.status !== "criar") return { status: decisao.status, pessoaId: null };

    const pessoaId = await inserirFichaEmCriacao(tx);
    const { aplicaveis } = await filtrarAtualizacaoInferida(
      pessoaId, { celular: telefone.key, nome: nomeProvisorioWhatsapp(input.perfilWhatsapp, digitos) }, "sofia:canal-whatsapp", tx,
    );
    if (Object.keys(aplicaveis).length > 0) {
      await tx.update(pessoasTable).set({ ...aplicaveis, updatedAt: new Date() }).where(eq(pessoasTable.id, pessoaId));
    }
    await tx.update(conversations).set({ pessoaId }).where(eq(conversations.id, input.conversationId));
    return { status: "criada", pessoaId };
  };

  const resultado = await (client ? executar(client) : db.transaction(executar));
  // Sem telefone no log.
  logger.info({ status: resultado.status, conversationId: input.conversationId }, "Sofia whatsapp: identificação pelo telefone");
  return resultado;
}

/** Ficha segura para o cartão de interesse, pelo canal da própria conversa. */
export async function identificarOuCriarPessoaDoCanal(
  input: { conversationId: number },
): Promise<{ status: string; pessoaId: number | null }> {
  const [conversa] = await db.select({ canal: conversations.canal }).from(conversations)
    .where(eq(conversations.id, input.conversationId)).limit(1);
  return conversa?.canal === "whatsapp"
    ? identificarOuCriarPessoaDoWhatsapp(input)
    : identificarOuCriarPessoaDoInstagram(input);
}

export interface HistoricoPessoa {
  primeiro_nome: string | null;
  ficha: {
    cidade: string | null;
    profissao: string | null;
    servico_interesse: string | null;
    objetivos_declarados: string[] | null;
    intencao_principal: string | null;
    preferred_language: string | null;
    idade_declarada: number | null;
    idade_declarada_em: string | null;
  };
  ultima_conversa_em: string | null;
  resumos_anteriores: string[];
  mensagens_recentes: Array<{ papel: "pessoa" | "sofia"; texto: string }>;
}

function truncar(texto: string, maximo = 300): string {
  const limpo = texto.replace(/\s+/g, " ").trim();
  return limpo.length > maximo ? `${limpo.slice(0, maximo - 1).trimEnd()}…` : limpo;
}

/** Contexto não sensível de conversas anteriores. Nunca CPF, saúde, e-mail ou evidências. */
export async function obterHistorico(pessoaId: number, conversaAtualId: number | null): Promise<HistoricoPessoa | null> {
  const [ficha] = await db
    .select({
      nome: pessoasTable.nome,
      cidade: pessoasTable.cidade,
      profissao: pessoasTable.profissao,
      servicoInteresse: pessoasTable.servicoInteresse,
      objetivosDeclarados: pessoasTable.objetivosDeclarados,
      intencaoPrincipal: pessoasTable.intencaoPrincipal,
      preferredLanguage: pessoasTable.preferredLanguage,
      idadeDeclarada: pessoasTable.idadeDeclarada,
      idadeDeclaradaEm: pessoasTable.idadeDeclaradaEm,
    })
    .from(pessoasTable)
    .where(eq(pessoasTable.id, pessoaId))
    .limit(1);
  if (!ficha) return null;

  const anteriores = await db
    .select({ id: conversations.id, createdAt: conversations.createdAt, handoffSummary: conversations.handoffSummary })
    .from(conversations)
    .where(and(
      eq(conversations.pessoaId, pessoaId),
      ...(conversaAtualId ? [ne(conversations.id, conversaAtualId)] : []),
    ))
    .orderBy(desc(conversations.createdAt), desc(conversations.id))
    .limit(3);

  const maisRecente = anteriores[0];
  const mensagens = maisRecente
    ? (await db
      .select({ role: messages.role, content: messages.content, kind: messages.kind })
      .from(messages)
      .where(and(eq(messages.conversationId, maisRecente.id), inArray(messages.role, ["user", "assistant"])))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(10))
      // Arquivo vira só uma nota neutra: a Sofia não vê imagens, vídeos, áudios nem documentos.
      .map(m => ({ role: m.role, content: conteudoParaASofia(m) }))
    : [];

  return {
    primeiro_nome: primeiroNomeDe(ficha.nome),
    ficha: {
      cidade: ficha.cidade,
      profissao: ficha.profissao,
      servico_interesse: ficha.servicoInteresse,
      objetivos_declarados: ficha.objetivosDeclarados?.length ? ficha.objetivosDeclarados : null,
      intencao_principal: ficha.intencaoPrincipal,
      preferred_language: ficha.preferredLanguage,
      idade_declarada: ficha.idadeDeclarada,
      idade_declarada_em: ficha.idadeDeclaradaEm,
    },
    ultima_conversa_em: maisRecente ? maisRecente.createdAt.toISOString().slice(0, 10) : null,
    resumos_anteriores: anteriores
      .map(conversa => conversa.handoffSummary?.trim())
      .filter((resumo): resumo is string => Boolean(resumo))
      .map(resumo => truncar(resumo)),
    mensagens_recentes: mensagens
      .reverse()
      .map(mensagem => ({ papel: mensagem.role === "user" ? "pessoa" as const : "sofia" as const, texto: truncar(mensagem.content) })),
  };
}
