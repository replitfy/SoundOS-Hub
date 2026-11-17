import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, pessoaNotes, pessoasTable } from "@workspace/db";
import {
  IdentityReviewError, applyDeclaration, createDeclaredPerson, declaredFields, readPersonLocked,
  resolveEventPerson, submittedIdentifiers,
  type EventTx, type IdentityReviewDetails, type PessoaRow, type SubmittedIdentifiers,
} from "./eventIdentity";
import { namesEqual, normalizedName } from "./identityMatching";

/**
 * Formulário público de interesse nunca recusa o cliente por causa da identidade.
 * Quando o cadastro não pode ser ligado com segurança a uma ficha, a equipe recebe o caso:
 * ficha em conferência (ou a ficha certa, quando o e-mail e o nome não deixam dúvida),
 * nota na ficha e cartão do CRM com a tarefa de conferir. Nada disso volta na resposta.
 */

/** Ficha criada porque não havia como saber de quem era o envio. */
export const NOTA_FICHA_EM_CONFERENCIA = "conferencia_cadastro";
/** Ficha certa, mas o celular informado pertence a outra e não foi gravado. */
export const NOTA_CONTATO_DIVERGENTE = "conferencia_contato";
const AUTOR_DA_NOTA = "sistema:formulario_publico";

/** Texto que o cartão do CRM mostra enquanto o cadastro não for conferido. */
export interface ConferenciaDoCartao { resumo: string }
export interface PessoaDoFormulario { personId: number; conferencia: ConferenciaDoCartao | null }

type Campo = "cpf" | "email" | "celular";

/** Próxima ação do cartão aberto por formulário: com identidade em dúvida, a equipe confere antes de responder. */
export function textoDaProximaAcao(conferencia?: ConferenciaDoCartao | null): string {
  return conferencia
    ? "Conferir o cadastro e retornar ao interesse recebido pelo formulário"
    : "Retornar ao interesse recebido pelo formulário";
}

/** Abre a linha da nota com os dados que o formulário trouxe e a ficha não recebeu. */
const PREFIXO_NAO_GRAVADOS = "Informado e não gravado: ";

const semPontoFinal = (texto: string) => texto.replace(/[.\s]+$/, "");

export function nomeDaFicha(pessoa: Pick<PessoaRow, "nome" | "sobrenome">): string {
  return [pessoa.nome, pessoa.sobrenome].filter(Boolean).join(" ").trim() || "(sem nome)";
}

/** Mesma pessoa + mesmos identificadores = mesmo caso: repetir o envio não cria outra ficha. */
export function impressaoDaConferencia(nomeCompleto: string, { cpf, email, phone }: SubmittedIdentifiers): string {
  const texto = [normalizedName(nomeCompleto).join(" "), cpf ?? "", email, phone].join("|");
  return createHash("sha256").update(texto).digest("hex").slice(0, 32);
}

/** Quais identificadores informados batem com uma ficha candidata (para a nota). */
export function coincidenciasDaFicha(id: number, detalhes: Pick<IdentityReviewDetails, "cpfIds" | "emailIds" | "phoneIds">): string[] {
  const motivos: string[] = [];
  if (detalhes.cpfIds.includes(id)) motivos.push("mesmo CPF");
  if (detalhes.emailIds.includes(id)) motivos.push("mesmo e-mail");
  if (detalhes.phoneIds.includes(id)) motivos.push("mesmo celular");
  return motivos;
}

export interface FichaRelacionada { codigo: string; nome: string; arquivada: boolean; coincide: string[] }
export interface DadoNaoGravado { rotulo: string; valor: string }

function linhasDasFichas(fichas: FichaRelacionada[]): string[] {
  return fichas.map(ficha => {
    const detalhes = [...ficha.coincide, ...(ficha.arquivada ? ["arquivada"] : [])];
    return `- ${ficha.codigo} — ${ficha.nome}${detalhes.length ? ` (${detalhes.join(", ")})` : ""}`;
  });
}

export function montarNotaConferencia(entrada: {
  origem: string; motivo: string; desfecho: "ficha_em_conferencia" | "ficha_existente";
  fichas: FichaRelacionada[]; naoGravados: DadoNaoGravado[];
}): string {
  const linhas = [`Conferência de cadastro — ${entrada.origem}.`, `Motivo: ${semPontoFinal(entrada.motivo)}.`];
  linhas.push(entrada.desfecho === "ficha_em_conferencia"
    ? "Esta ficha foi criada porque não deu para ter certeza de quem enviou o formulário. Nenhum dado foi gravado nas outras fichas."
    : "O e-mail e o nome informados conferem com esta ficha. O celular informado pertence a outra ficha e não foi gravado aqui.");
  if (entrada.fichas.length) linhas.push(entrada.desfecho === "ficha_em_conferencia" ? "Fichas possivelmente relacionadas:" : "Outras fichas relacionadas:", ...linhasDasFichas(entrada.fichas));
  if (entrada.naoGravados.length) linhas.push(`${PREFIXO_NAO_GRAVADOS}${entrada.naoGravados.map(dado => `${dado.rotulo} ${dado.valor}`).join("; ")}.`);
  if (entrada.desfecho === "ficha_em_conferencia") linhas.push("Se for a mesma pessoa de uma dessas fichas, mescle as fichas.");
  return linhas.join("\n");
}

export function montarResumoDoCartao(motivo: string, fichas: FichaRelacionada[]): string {
  const codigos = fichas.map(ficha => ficha.codigo);
  return `Cadastro a conferir: ${semPontoFinal(motivo)}.${codigos.length ? ` Fichas relacionadas: ${codigos.join(", ")}.` : ""} Detalhes nas notas da ficha.`;
}

function fichasRelacionadas(candidatos: PessoaRow[], detalhes: IdentityReviewDetails, exceto?: number): FichaRelacionada[] {
  return candidatos.filter(pessoa => pessoa.id !== exceto).map(pessoa => ({
    codigo: pessoa.codigo, nome: nomeDaFicha(pessoa),
    arquivada: Boolean(pessoa.arquivadoEm) || !pessoa.ativo,
    coincide: coincidenciasDaFicha(pessoa.id, detalhes),
  }));
}

const digitos = (valor: string | null | undefined) => (valor ?? "").replace(/\D/g, "");
const fichaUtilizavel = (pessoa: PessoaRow | undefined): pessoa is PessoaRow => Boolean(pessoa && pessoa.ativo && !pessoa.arquivadoEm && !pessoa.mergedIntoPessoaId);

/**
 * O e-mail aponta para uma única ficha ativa, o nome é o mesmo, o CPF não contradiz e só o celular
 * aponta para outra pessoa: é a mesma pessoa com um celular compartilhado.
 */
function fichaDoEmail(detalhes: IdentityReviewDetails, nomeCompleto: string, cpf: string | null): PessoaRow | undefined {
  if (detalhes.emailIds.length !== 1) return undefined;
  const ficha = detalhes.candidatos.find(pessoa => pessoa.id === detalhes.emailIds[0]);
  if (!fichaUtilizavel(ficha)) return undefined;
  if (!namesEqual(nomeCompleto, nomeDaFicha(ficha))) return undefined;
  if (detalhes.cpfIds.some(id => id !== ficha.id)) return undefined;
  if (cpf && digitos(ficha.cpf) && digitos(ficha.cpf) !== cpf) return undefined;
  return ficha;
}

async function gravarNota(tx: EventTx, pessoaId: number, tipo: string, impressao: string, corpo: string): Promise<void> {
  await tx.insert(pessoaNotes).values({ pessoaId, noteType: tipo, value: impressao, body: corpo, createdBy: AUTOR_DA_NOTA });
}

const NAO_GRAVADOS: Record<Campo, string> = { cpf: "CPF", email: "e-mail", celular: "celular" };

/** A nota diz que o celular informado no formulário não foi gravado na ficha (pertence a outras fichas). */
export function notaRegistraCelularNaoGravado(corpo: string | null | undefined): boolean {
  const linha = (corpo ?? "").split("\n").find(trecho => trecho.startsWith(PREFIXO_NAO_GRAVADOS));
  if (!linha) return false;
  return semPontoFinal(linha.slice(PREFIXO_NAO_GRAVADOS.length)).split("; ").some(dado => dado.startsWith(`${NAO_GRAVADOS.celular} `));
}

/**
 * A ficha veio de um formulário público que informou um celular, mas o número não foi gravado porque
 * pertence a outras fichas. É o que explica, para a equipe, uma ficha sem telefone.
 */
export async function celularInformadoNaoGravado(pessoaId: number): Promise<boolean> {
  const notas = await db.select({ corpo: pessoaNotes.body }).from(pessoaNotes)
    .where(and(eq(pessoaNotes.pessoaId, pessoaId), inArray(pessoaNotes.noteType, [NOTA_FICHA_EM_CONFERENCIA, NOTA_CONTATO_DIVERGENTE])));
  return notas.some(nota => notaRegistraCelularNaoGravado(nota.corpo));
}

function dadosInformados(answers: Record<string, string>, ids: SubmittedIdentifiers, campos: Campo[]): DadoNaoGravado[] {
  const valores: Record<Campo, string> = {
    cpf: ids.cpf ?? "",
    email: ids.email,
    celular: answers.celular?.trim() || ids.phone,
  };
  return campos.filter(campo => valores[campo]).map(campo => ({ rotulo: NAO_GRAVADOS[campo], valor: valores[campo] }));
}

async function conferirIdentidade(
  tx: EventTx, answers: Record<string, string>, erro: IdentityReviewError, origem: string,
): Promise<PessoaDoFormulario> {
  const ids = submittedIdentifiers(answers);
  const detalhes = erro.detalhes;
  const declarado = declaredFields(answers, ids);
  const nomeCompleto = [answers.nome, answers.sobrenome].filter(Boolean).join(" ");
  const impressao = impressaoDaConferencia(nomeCompleto, ids);

  // 1) Mesma pessoa, celular de outra: atualiza a ficha certa sem o celular.
  const candidata = fichaDoEmail(detalhes, nomeCompleto, ids.cpf);
  if (candidata) {
    const atual = await readPersonLocked(tx, candidata.id);
    if (fichaUtilizavel(atual) && (!ids.cpf || !digitos(atual.cpf) || digitos(atual.cpf) === ids.cpf)) {
      const { celular: _celular, celularNormalizado: _normalizado, ...semCelular } = declarado;
      await applyDeclaration(tx, atual.id, semCelular);
      await gravarNota(tx, atual.id, NOTA_CONTATO_DIVERGENTE, impressao, montarNotaConferencia({
        origem, motivo: erro.motivo, desfecho: "ficha_existente",
        fichas: fichasRelacionadas(detalhes.candidatos, detalhes, atual.id),
        naoGravados: dadosInformados(answers, ids, ["celular"]),
      }));
      return { personId: atual.id, conferencia: null };
    }
  }

  // 2) Não há como saber: ficha própria, sem os identificadores que pertencem a outras fichas.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"conferencia:" + impressao}, 0))`);
  const [mesmoCaso] = await tx.select({ id: pessoaNotes.pessoaId }).from(pessoaNotes)
    .innerJoin(pessoasTable, eq(pessoasTable.id, pessoaNotes.pessoaId))
    .where(and(
      eq(pessoaNotes.noteType, NOTA_FICHA_EM_CONFERENCIA), eq(pessoaNotes.value, impressao),
      isNull(pessoasTable.arquivadoEm), eq(pessoasTable.ativo, true), isNull(pessoasTable.mergedIntoPessoaId),
    ))
    .orderBy(desc(pessoaNotes.id)).limit(1);

  const reservados: Campo[] = [];
  if (detalhes.cpfIds.length) reservados.push("cpf");
  if (detalhes.emailIds.length) reservados.push("email");
  if (detalhes.phoneIds.length) reservados.push("celular");
  const proprios = { ...declarado };
  if (reservados.includes("cpf")) delete proprios.cpf;
  if (reservados.includes("email")) delete proprios.email;
  if (reservados.includes("celular")) { delete proprios.celular; delete proprios.celularNormalizado; }

  const personId = mesmoCaso?.id ?? await createDeclaredPerson(tx, answers.nome.trim(), proprios);
  const fichas = fichasRelacionadas(detalhes.candidatos, detalhes, personId);
  await gravarNota(tx, personId, NOTA_FICHA_EM_CONFERENCIA, impressao, montarNotaConferencia({
    origem, motivo: erro.motivo, desfecho: "ficha_em_conferencia", fichas,
    naoGravados: dadosInformados(answers, ids, reservados),
  }));
  return { personId, conferencia: { resumo: montarResumoDoCartao(erro.motivo, fichas) } };
}

/**
 * Identifica quem enviou um formulário público de interesse. Nunca lança por conflito de identidade:
 * erros de dado (CPF inválido) e falhas reais continuam subindo.
 */
export async function resolverPessoaDoFormularioPublico(
  tx: EventTx, answers: Record<string, string>, origem: string,
): Promise<PessoaDoFormulario> {
  try {
    return { personId: await resolveEventPerson(tx, answers), conferencia: null };
  } catch (erro) {
    if (!(erro instanceof IdentityReviewError)) throw erro;
    // Nenhuma escrita aconteceu antes do conflito (e os locks dos identificadores já estão presos): a transação segue válida.
    return conferirIdentidade(tx, answers, erro, origem);
  }
}
