import { createHash } from "node:crypto";

// O Hablla não publica o formato dos eventos de webhook de conexões. Este módulo
// extrai o que precisamos de forma tolerante (procura chaves conhecidas em
// qualquer profundidade) e, na dúvida, decide pelo lado seguro: sem evidência
// POSITIVA de que a mensagem veio do cliente, ela NÃO dispara resposta.

export type DirecaoEvento = "entrada" | "saida" | "desconhecida";

export interface EventoHablla {
  /** Id da mensagem no Hablla; sem ele, hash do corpo (idempotência de retentativas). */
  externoId: string;
  tipoEvento: string | null;
  direcao: DirecaoEvento;
  /** Id do contato no canal (IGSID no Instagram). */
  contatoId: string | null;
  /** @usuário, sem o "@". */
  usuario: string | null;
  texto: string | null;
  temAnexo: boolean;
  tipoMensagem: string | null;
}

const MAX_PROFUNDIDADE = 5;

function normalizarChave(chave: string): string {
  return chave.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizarTexto(valor: string): string {
  return valor.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}

/** Percorre objetos e arrays em largura. */
function* percorrer(raiz: unknown): Generator<{ chave: string; valor: unknown; profundidade: number }> {
  let fila: Array<{ no: unknown; profundidade: number }> = [{ no: raiz, profundidade: 0 }];
  while (fila.length > 0) {
    const proxima: typeof fila = [];
    for (const { no, profundidade } of fila) {
      if (profundidade > MAX_PROFUNDIDADE) continue;
      if (Array.isArray(no)) {
        for (const item of no.slice(0, 20)) proxima.push({ no: item, profundidade: profundidade + 1 });
      } else if (ehObjeto(no)) {
        for (const [chave, valor] of Object.entries(no)) {
          yield { chave: normalizarChave(chave), valor, profundidade };
          if (typeof valor === "object" && valor !== null) proxima.push({ no: valor, profundidade: profundidade + 1 });
        }
      }
    }
    fila = proxima;
  }
}

function comoTexto(valor: unknown): string | null {
  if (typeof valor === "string") return valor.trim() === "" ? null : valor.trim();
  if (typeof valor === "number" && Number.isFinite(valor)) return String(valor);
  return null;
}

/** Primeiro valor textual cuja chave esteja na lista (a ordem da lista dá a prioridade). */
function acharTexto(raiz: unknown, chaves: string[]): string | null {
  const encontrados = new Map<string, string>();
  for (const { chave, valor } of percorrer(raiz)) {
    if (!chaves.includes(chave) || encontrados.has(chave)) continue;
    const texto = comoTexto(valor);
    if (texto !== null) encontrados.set(chave, texto);
  }
  for (const chave of chaves) {
    const achado = encontrados.get(chave);
    if (achado !== undefined) return achado;
  }
  return null;
}

function acharBoolean(raiz: unknown, chaves: string[]): boolean | null {
  for (const { chave, valor } of percorrer(raiz)) {
    if (!chaves.includes(chave)) continue;
    if (typeof valor === "boolean") return valor;
    if (valor === "true") return true;
    if (valor === "false") return false;
  }
  return null;
}

/** Objeto de pessoa/remetente: procura o id dentro de objetos com esses nomes. */
function acharIdEmObjeto(raiz: unknown, nomesObjeto: string[]): { id: string | null; usuario: string | null } {
  for (const { chave, valor } of percorrer(raiz)) {
    if (!nomesObjeto.includes(chave) || !ehObjeto(valor)) continue;
    const id = acharTexto(valor, ["igsid", "instagramid", "instagramscopedid", "externalid", "id", "uid"]);
    const usuario = acharTexto(valor, ["username", "usuario", "handle", "instagramusername"]);
    if (id !== null || usuario !== null) return { id, usuario };
  }
  return { id: null, usuario: null };
}

const CHAVES_DIRECAO_TEXTO = ["direction", "direcao", "messagedirection", "origin", "origem"];
const CHAVES_TIPO_REMETENTE = [
  "sendertype", "fromtype", "authortype", "sentby", "senderrole", "role", "sender", "author", "origintype",
];
const CHAVES_NOME_EVENTO = ["event", "eventtype", "eventname", "topic", "action", "evento", "tipoevento"];

const REMETENTE_CLIENTE = /^(person|customer|client|contact|lead|cliente|pessoa|contato|external)$/;
const REMETENTE_NOSSO = /^(user|agent|bot|automation|system|attendant|robot|atendente|robo|flow|fluxo|operator|operador|workspace|company|empresa|page|me)$/;

function direcaoDeTexto(valor: string): DirecaoEvento {
  const v = normalizarTexto(valor);
  if (/^(in|inbound|incoming|received|recebid|entrada|receive)/.test(v)) return "entrada";
  if (/^(out|outbound|outgoing|sent|enviad|saida|send)/.test(v)) return "saida";
  return "desconhecida";
}

function direcaoDeRemetente(valor: string): DirecaoEvento {
  const v = normalizarTexto(valor).replace(/[\s-]+/g, "_");
  if (REMETENTE_NOSSO.test(v)) return "saida";
  if (REMETENTE_CLIENTE.test(v)) return "entrada";
  return "desconhecida";
}

function direcaoDeNomeEvento(valor: string): DirecaoEvento {
  const v = normalizarTexto(valor);
  // Qualquer menção a envio, entrega, leitura, status ou remoção não é "cliente falou".
  if (/(sent|outbound|outgoing|echo|enviad|saida|deliver|read|status|updat|delet|remov|fail|falh)/.test(v)) return "saida";
  if (/(receiv|inbound|incoming|recebid|entrada|new[-_. ]?message|message[-_. ]?created|nova[-_. ]?mensagem)/.test(v)) return "entrada";
  return "desconhecida";
}

function decidirDirecao(payload: unknown): DirecaoEvento {
  const evidencias: DirecaoEvento[] = [];

  for (const chave of ["fromme", "isecho", "echo", "isoutbound", "outbound", "ismine", "issent"]) {
    if (acharBoolean(payload, [chave]) === true) evidencias.push("saida");
  }
  for (const chave of ["inbound", "isinbound", "isincoming", "incoming"]) {
    if (acharBoolean(payload, [chave]) === true) evidencias.push("entrada");
  }

  const direcao = acharTexto(payload, CHAVES_DIRECAO_TEXTO);
  if (direcao) evidencias.push(direcaoDeTexto(direcao));

  for (const { chave, valor } of percorrer(payload)) {
    if (!CHAVES_TIPO_REMETENTE.includes(chave)) continue;
    if (typeof valor === "string") evidencias.push(direcaoDeRemetente(valor));
    else if (ehObjeto(valor)) {
      const tipo = acharTexto(valor, ["type", "tipo", "role"]);
      if (tipo) evidencias.push(direcaoDeRemetente(tipo));
    }
  }

  // "type" costuma ser o tipo da mensagem ("text"), mas também pode ser o do evento ("incoming").
  for (const nome of [acharTexto(payload, CHAVES_NOME_EVENTO), acharTexto(payload, ["type"])]) {
    if (nome) evidencias.push(direcaoDeNomeEvento(nome));
  }

  // Evidência de saída vence qualquer outra: na dúvida, não respondemos.
  if (evidencias.includes("saida")) return "saida";
  if (evidencias.includes("entrada")) return "entrada";
  return "desconhecida";
}

export function interpretarEventoHablla(payload: unknown): EventoHablla {
  const direcao = decidirDirecao(payload);

  const sender = acharIdEmObjeto(payload, ["sender", "from", "contact", "person", "customer", "client", "user"]);
  const contatoId =
    acharTexto(payload, ["igsid", "instagramscopedid", "instagramid", "senderid", "fromid", "contactid", "customerid", "personid"])
    ?? sender.id
    ?? (direcao === "entrada" ? acharTexto(payload, ["from"]) : acharTexto(payload, ["to", "recipient", "recipientid"]));
  const usuario = (acharTexto(payload, ["username", "instagramusername", "instagramhandle", "handle"]) ?? sender.usuario)
    ?.replace(/^@/, "") ?? null;

  const texto = acharTexto(payload, ["text", "message", "content", "body", "texto", "mensagem", "caption"]);
  const tipoMensagem = acharTexto(payload, ["messagetype", "contenttype", "mediatype", "kind", "type"]);

  let temAnexo = false;
  for (const { chave, valor } of percorrer(payload)) {
    if (["attachments", "attachment", "media", "files", "file", "image", "audio", "video", "sticker"].includes(chave)) {
      if (Array.isArray(valor) ? valor.length > 0 : valor !== null && valor !== undefined && valor !== "" && valor !== false) {
        temAnexo = true;
        break;
      }
    }
  }

  const idMensagem = acharTexto(payload, ["messageid", "mid", "wamid", "externalmessageid", "eventid"])
    ?? acharIdEmObjeto(payload, ["message", "msg", "data"]).id;
  const externoId = idMensagem
    ? `msg:${idMensagem}`
    : `sha256:${createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex")}`;

  return {
    externoId,
    tipoEvento: acharTexto(payload, CHAVES_NOME_EVENTO),
    direcao,
    contatoId,
    usuario,
    texto,
    temAnexo,
    tipoMensagem,
  };
}

/** Descreve só a estrutura (chaves e tipos), sem valores, para log sem dados pessoais. */
export function descreverFormato(valor: unknown, profundidade = 0): unknown {
  if (profundidade > 4) return "…";
  if (Array.isArray(valor)) return valor.length === 0 ? [] : [descreverFormato(valor[0], profundidade + 1)];
  if (ehObjeto(valor)) {
    return Object.fromEntries(Object.entries(valor).slice(0, 40).map(([k, v]) => [k, descreverFormato(v, profundidade + 1)]));
  }
  return valor === null ? "null" : typeof valor;
}
