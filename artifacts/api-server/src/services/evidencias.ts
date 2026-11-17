import { eq, and, desc, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  db, pessoasTable, pessoaEvidencias, pessoaCamposConfirmados,
  NIVEL_CONFIANCA_POR_TIPO, type TipoEvidencia,
} from "@workspace/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbOrTx = NodePgDatabase<any> | Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** Lançado por `withPessoaLock` quando o id informado não corresponde a nenhuma pessoa. */
export class PessoaNotFoundError extends Error {
  constructor(public readonly pessoaId: number) {
    super(`Pessoa ${pessoaId} não encontrada`);
    this.name = "PessoaNotFoundError";
  }
}

/**
 * Abre uma transação e trava a linha da pessoa (SELECT ... FOR UPDATE) antes de
 * rodar `fn`. Isso serializa qualquer combinação de escrita humana / declaração
 * pública / tentativa da Sofia sobre a MESMA pessoa: quem pegar o lock primeiro
 * termina sua checagem de campos confirmados + gravação de evidência + update
 * oficial antes que a outra transação possa ler o estado de confirmação — evita
 * a corrida em que a Sofia decide aplicar um campo com base num snapshot que um
 * humano confirma logo em seguida, antes do UPDATE da Sofia ser commitado.
 *
 * Lança `PessoaNotFoundError` se o id não existir — isso deve acontecer ANTES de
 * qualquer gravação de evidência (que teria FK para pessoas.id e falharia com um
 * erro genérico de violação de constraint em vez de um "não encontrada" claro).
 */
export async function withPessoaLock<T>(pessoaId: number, fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`SELECT id FROM pessoas WHERE id = ${pessoaId} FOR UPDATE`);
    if (rows.rows.length === 0) throw new PessoaNotFoundError(pessoaId);
    return fn(tx);
  });
}

// Campos da ficha que participam do mecanismo de evidências (Documento 14/14A):
// tanto a Sofia (tool updatePessoa) quanto humanos (tela da ficha) escrevem
// nesses campos, e ambos os caminhos passam pelo mesmo registro de evidência.
export const PESSOA_EVIDENCIA_FIELDS = new Set([
  "nome", "sobrenome", "cpf", "dataNascimento", "sexo", "email", "celular",
  "instagram", "site", "profissao", "profissaoCategoria",
  "enderecoRua", "cidade", "estadoUf", "cep",
  "servicoInteresse", "comoFicouSabendo", "qualAmigoParceiro", "preferenciaContato", "contatoPara", "adicionarContato",
  "aguaPresencial", "fogoPresencial", "workshopAgua", "cacau", "ayahuasca", "concerto", "zapPierre", "idAlunoCliente", "turma",
  "conectadoProposito", "buscaEspiritual", "lugarMusicaSom", "participouTrabalhoSom", "qualTrabalhoSom",
  "midiaInput", "midiaInputOutro", "terapeuta", "formacaoMusicaTerapia",
  "objetivoCurso", "cursoProposito", "cursoExpectativas", "outroCurso", "sentidoParticipar",
  "experienciaAyahuasca", "psicodelicosDrogas", "traumaVida", "ansioliticoAntidepressivos",
  "problemaSaude", "psicoterapiaPsiquiatria", "sensacao", "sensacaoPerseguido",
  "covid", "comprovanteCovid",
  "perfilPrincipal", "objetivosDeclarados", "macrojornadaPrincipalId", "intencaoPrincipal",
  "temperatura", "estiloCognitivo", "velocidadeEvolucao", "preferredLanguage", "consentStatus",
  "idadeDeclarada", "idadeDeclaradaEm",
]);

function valorParaTexto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  if (Array.isArray(valor)) return JSON.stringify(valor);
  return String(valor);
}

/** Grava uma linha de evidência — nunca atualiza/apaga uma existente. */
export async function registrarEvidencia(params: {
  pessoaId: number;
  campo: string;
  valor: unknown;
  tipoEvidencia: TipoEvidencia;
  origem: string;
  aplicada: boolean;
}, client: DbOrTx = db): Promise<void> {
  await client.insert(pessoaEvidencias).values({
    pessoaId: params.pessoaId,
    campo: params.campo,
    valor: valorParaTexto(params.valor),
    tipoEvidencia: params.tipoEvidencia,
    origem: params.origem,
    nivelConfianca: NIVEL_CONFIANCA_POR_TIPO[params.tipoEvidencia],
    aplicada: params.aplicada ? "sim" : "nao",
  });
}

export async function getCamposConfirmados(pessoaId: number, client: DbOrTx = db): Promise<Map<string, { confirmadoPor: string; confirmadoEm: Date }>> {
  const rows = await client.select().from(pessoaCamposConfirmados).where(eq(pessoaCamposConfirmados.pessoaId, pessoaId));
  return new Map(rows.map(r => [r.campo, { confirmadoPor: r.confirmadoPor, confirmadoEm: r.confirmadoEm }]));
}

/** Marca um campo como confirmado (trava contra sobrescrita futura da Sofia). Upsert por pessoa+campo. */
export async function marcarCampoConfirmado(pessoaId: number, campo: string, confirmadoPor: string, client: DbOrTx = db): Promise<void> {
  await client.insert(pessoaCamposConfirmados)
    .values({ pessoaId, campo, confirmadoPor })
    .onConflictDoUpdate({
      target: [pessoaCamposConfirmados.pessoaId, pessoaCamposConfirmados.campo],
      set: { confirmadoPor, confirmadoEm: new Date() },
    });
}

interface AplicarEscritaOpts {
  tipoEvidencia: TipoEvidencia;
  origem: string;
  /** Se true, campos já confirmados são bloqueados (viram evidência pendente, não aplicados). */
  respeitarConfirmados: boolean;
  /** Se true, os campos efetivamente aplicados passam a ficar confirmados (travados contra a Sofia). */
  marcarConfirmado: boolean;
}

/**
 * Núcleo do mecanismo de evidências: toda escrita em campos rastreados da ficha passa
 * por aqui. Sempre grava uma linha de evidência (nunca pula o registro). Quando
 * `respeitarConfirmados` está ativo, campos já confirmados não são aplicados —
 * apenas viram evidência pendente (aplicada=false) — protegendo o dado oficial.
 */
async function aplicarEscrita(
  pessoaId: number,
  campos: Record<string, unknown>,
  opts: AplicarEscritaOpts,
  client: DbOrTx,
): Promise<{ aplicaveis: Record<string, unknown>; bloqueados: string[] }> {
  const confirmados = opts.respeitarConfirmados ? await getCamposConfirmados(pessoaId, client) : new Map();
  const aplicaveis: Record<string, unknown> = {};
  const bloqueados: string[] = [];
  const entries = Object.entries(campos).filter(([k, v]) => PESSOA_EVIDENCIA_FIELDS.has(k) && v !== undefined);

  // Sequencial (não Promise.all) — dentro de uma transação com lock de linha,
  // uma única conexão é usada; chamadas concorrentes na mesma tx causariam erro.
  for (const [campo, valor] of entries) {
    const bloqueado = confirmados.has(campo);
    await registrarEvidencia({
      pessoaId, campo, valor,
      tipoEvidencia: opts.tipoEvidencia,
      origem: opts.origem,
      aplicada: !bloqueado,
    }, client);
    if (bloqueado) {
      bloqueados.push(campo);
    } else {
      aplicaveis[campo] = valor;
      if (opts.marcarConfirmado) await marcarCampoConfirmado(pessoaId, campo, opts.origem, client);
    }
  }

  return { aplicaveis, bloqueados };
}

/**
 * Chamado quando um HUMANO grava valores pela tela da ficha (canal oficial de edição):
 * sempre aplica (um humano pode corrigir mesmo um campo já confirmado por outro humano)
 * e registra evidência "validada", travando o campo contra sobrescrita futura da Sofia.
 * Deve ser chamado dentro de `withPessoaLock`, na mesma transação do UPDATE oficial.
 */
export async function registrarEdicaoHumana(
  pessoaId: number,
  campos: Record<string, unknown>,
  origem: string,
  client: DbOrTx,
): Promise<void> {
  await aplicarEscrita(pessoaId, campos, {
    tipoEvidencia: "validada", origem,
    respeitarConfirmados: false, marcarConfirmado: true,
  }, client);
}

// Tipos de evidência que a Sofia pode emitir autonomamente durante o chat.
// "comportamental" → a pessoa descreveu algo que ela fez ou viveu (nivelConfianca = media).
// "relacional"     → a pessoa mencionou quem a indicou/conectou (nivelConfianca = media).
// "inferida"       → leitura da Sofia sem confirmação explícita (nivelConfianca = baixa).
// Apenas esses três estão disponíveis para a Sofia; "validada", "declarada" e
// "transacional" são exclusivos de humanos ou de canais oficiais.
export type TipoEvidenciaSofia = "inferida" | "comportamental" | "relacional";

/**
 * Chamado quando a SOFIA tenta gravar valores via tool updatePessoa. Campos já
 * confirmados (por humano ou por declaração direta da pessoa) nunca são sobrescritos:
 * a tentativa vira evidência pendente (aplicada=false) mas o valor oficial
 * não muda. A Sofia nunca marca um campo como confirmado. Retorna os campos aplicáveis.
 *
 * O parâmetro `tipoEvidencia` permite que a Sofia sinalize sinais comportamentais ou
 * relacionais (nivelConfianca = media) em vez de tratar tudo como inferência de baixa
 * confiança. Isso habilita a transição rápida para conduta comercial via critério
 * primário de `determineConduta` sem depender da convergência mínima de 3× inferências.
 * Padrão: "inferida".
 *
 * Deve ser chamado dentro de `withPessoaLock`, na mesma transação do UPDATE oficial.
 */
export async function filtrarAtualizacaoSofia(
  pessoaId: number,
  campos: Record<string, unknown>,
  client: DbOrTx,
  tipoEvidencia: TipoEvidenciaSofia = "inferida",
): Promise<{ aplicaveis: Record<string, unknown>; bloqueados: string[] }> {
  return filtrarAtualizacaoInferida(pessoaId, campos, "sofia", client, tipoEvidencia);
}

export async function filtrarAtualizacaoInferida(
  pessoaId: number,
  campos: Record<string, unknown>,
  origem: string,
  client: DbOrTx,
  tipoEvidencia: TipoEvidenciaSofia = "inferida",
): Promise<{ aplicaveis: Record<string, unknown>; bloqueados: string[] }> {
  return aplicarEscrita(pessoaId, campos, {
    tipoEvidencia, origem,
    respeitarConfirmados: true, marcarConfirmado: false,
  }, client);
}

/**
 * Chamado quando a PRÓPRIA PESSOA declara seus dados por um canal oficial não
 * mediado por um humano da equipe (ex.: formulário público de inscrição em curso).
 * É uma evidência de alta confiança ("declarada"), mas ainda respeita campos já
 * confirmados — uma nova submissão do formulário não deve silenciosamente
 * sobrescrever um dado que a equipe já validou manualmente na ficha. Os campos
 * efetivamente aplicados também passam a ficar confirmados. Retorna os campos aplicáveis.
 * Deve ser chamado dentro de `withPessoaLock`, na mesma transação do UPDATE/INSERT oficial.
 */
export async function registrarDeclaracaoPublica(
  pessoaId: number,
  campos: Record<string, unknown>,
  origem: string,
  client: DbOrTx,
): Promise<{ aplicaveis: Record<string, unknown>; bloqueados: string[] }> {
  return aplicarEscrita(pessoaId, campos, {
    tipoEvidencia: "declarada", origem,
    respeitarConfirmados: true, marcarConfirmado: true,
  }, client);
}

/**
 * Chamado pela tool `atualizar_ficha` do modo simples quando a própria pessoa
 * disse o dado na conversa ("declarada", com origem `sofia:conversa:<id>`).
 * Respeita campos confirmados por humano e nunca marca nada como confirmado:
 * a equipe continua sendo quem valida. Deve rodar dentro de `withPessoaLock`.
 */
export async function registrarDeclaracaoNaConversa(
  pessoaId: number,
  campos: Record<string, unknown>,
  origem: string,
  client: DbOrTx,
): Promise<{ aplicaveis: Record<string, unknown>; bloqueados: string[] }> {
  return aplicarEscrita(pessoaId, campos, {
    tipoEvidencia: "declarada", origem,
    respeitarConfirmados: true, marcarConfirmado: false,
  }, client);
}

export interface CampoStatus {
  campo: string;
  confirmadoPor: string;
  confirmadoEm: string;
  valorAtual: string | null;
  valorSugeridoSofia: string | null;
}

/** Para a UI da ficha: quais campos estão travados e se há sugestão pendente da Sofia divergente. */
export async function getStatusCampos(pessoaId: number): Promise<CampoStatus[]> {
  const confirmados = await db.select().from(pessoaCamposConfirmados).where(eq(pessoaCamposConfirmados.pessoaId, pessoaId));
  if (confirmados.length === 0) return [];

  const [pessoa] = await db.select().from(pessoasTable).where(eq(pessoasTable.id, pessoaId)).limit(1);
  if (!pessoa) return [];

  const results: CampoStatus[] = [];
  for (const c of confirmados) {
    const valorAtualRaw = (pessoa as unknown as Record<string, unknown>)[c.campo];
    const valorAtual = valorParaTexto(valorAtualRaw);

    const [ultimaEvidenciaSofia] = await db.select().from(pessoaEvidencias)
      .where(and(
        eq(pessoaEvidencias.pessoaId, pessoaId),
        eq(pessoaEvidencias.campo, c.campo),
        eq(pessoaEvidencias.origem, "sofia"),
      ))
      .orderBy(desc(pessoaEvidencias.createdAt))
      .limit(1);

    const valorSugeridoSofia =
      ultimaEvidenciaSofia && ultimaEvidenciaSofia.aplicada === "nao" && ultimaEvidenciaSofia.valor !== valorAtual
        ? ultimaEvidenciaSofia.valor
        : null;

    results.push({
      campo: c.campo,
      confirmadoPor: c.confirmadoPor,
      confirmadoEm: c.confirmadoEm.toISOString(),
      valorAtual,
      valorSugeridoSofia,
    });
  }
  return results;
}
