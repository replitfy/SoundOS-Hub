import type { AnexoTipo } from "@workspace/db";

// Regras de tipo, tamanho e conteúdo dos anexos do WhatsApp. Arquivo recebido ou enviado é sempre tratado
// como não confiável: o tipo que vale é o do CONTEÚDO (primeiros bytes), nunca a extensão nem o formato
// declarado pelo provedor ou pelo navegador.
//
// Limites e formatos de ENVIO conferidos na documentação da Meta (WhatsApp Cloud API, "Supported media
// types", consultada em 07/11/2026): imagem JPEG/PNG/WebP estático até 5 MB; vídeo MP4/3GPP até 16 MB;
// áudio AAC/AMR/MP3/M4A/OGG (Opus) até 16 MB; documento TXT/XLS/XLSX/DOC/DOCX/PPT/PPTX/PDF até 100 MB.
// A Astenir não publica limites próprios para o envio de mídia.

const MB = 1024 * 1024;

export const LIMITE_DE_ENVIO: Record<AnexoTipo, number> = {
  image: 5 * MB,
  video: 16 * MB,
  audio: 16 * MB,
  document: 100 * MB,
};

/** Recebidos: a Meta aceita até 100 MB por mensagem; imagem, vídeo e áudio ficam abaixo disso por segurança. */
export const LIMITE_DE_RECEBIMENTO: Record<AnexoTipo, number> = {
  image: 16 * MB,
  video: 64 * MB,
  audio: 64 * MB,
  document: 100 * MB,
};

export const MAIOR_LIMITE_DE_ENVIO = Math.max(...Object.values(LIMITE_DE_ENVIO));
/** Quantos bytes do início bastam para reconhecer o formato. */
export const BYTES_PARA_RECONHECER = 64 * 1024;

/** Formatos (MIME) aceitos por tipo. O MIME declarado pelo provedor só serve para recusar cedo. */
export const MIMES_ACEITOS: Record<AnexoTipo, readonly string[]> = {
  image: ["image/jpeg", "image/png", "image/webp"],
  video: ["video/mp4", "video/3gpp"],
  audio: ["audio/aac", "audio/amr", "audio/mpeg", "audio/mp4", "audio/ogg"],
  document: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "text/csv",
  ],
};

/** Só estes abrem na própria tela; todo o resto é baixado. */
const MIMES_INLINE = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/aac"]);

/** O WhatsApp recusa CSV em mensagem de documento enviada pela API? A lista da Meta não o traz: só recebe. */
const SO_RECEBIDOS = new Set(["text/csv"]);

export type MotivoDeRecusa =
  | "tipo_nao_permitido" | "conteudo_nao_confere" | "tamanho_excedido" | "endereco_nao_confiavel"
  | "hash_diferente" | "arquivo_vazio";

export type MotivoDeIndisponibilidade =
  | "sem_endereco" | "download_falhou" | "tempo_esgotado" | "provedor_recusou" | "armazenamento_falhou";

export interface ConteudoReconhecido {
  tipo: AnexoTipo;
  mime: string;
  extensao: string;
  /** Pode ser enviado pelo WhatsApp (formatos da lista da Meta). */
  enviavel: boolean;
  /** Pode abrir na tela (imagem, vídeo e áudio de tipos conhecidos). */
  inline: boolean;
}

function reconhecido(tipo: AnexoTipo, mime: string, extensao: string): ConteudoReconhecido {
  return { tipo, mime, extensao, enviavel: !SO_RECEBIDOS.has(mime), inline: MIMES_INLINE.has(mime) && tipo !== "document" };
}

export function extensaoDoNome(nome: string | null | undefined): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(nome?.trim() ?? "");
  return m ? m[1]!.toLowerCase() : "";
}

/** MIME sem parâmetros e em minúsculas ("audio/ogg; codecs=opus" → "audio/ogg"). */
export function mimeBase(mime: unknown): string | null {
  if (typeof mime !== "string") return null;
  const base = mime.split(";")[0]!.trim().toLowerCase();
  return /^[a-z]+\/[a-z0-9.+-]+$/.test(base) ? base : null;
}

export function mimeAceitoParaOTipo(tipo: AnexoTipo, mime: string | null): boolean {
  return mime !== null && MIMES_ACEITOS[tipo].includes(mime);
}

function comeca(head: Buffer, ...bytes: number[]): boolean {
  return head.length >= bytes.length && bytes.every((b, i) => head[i] === b);
}

function ascii(head: Buffer, inicio: number, fim: number): string {
  return head.subarray(inicio, fim).toString("latin1");
}

function pareceTexto(head: Buffer): boolean {
  if (head.length === 0) return false;
  let controle = 0;
  for (const b of head) {
    if (b === 0) return false;
    if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 12) controle += 1;
  }
  return controle / head.length < 0.02;
}

const DOCUMENTOS_OLE = new Map([
  ["doc", "application/msword"],
  ["xls", "application/vnd.ms-excel"],
  ["ppt", "application/vnd.ms-powerpoint"],
]);
const DOCUMENTOS_OOXML = new Map([
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
]);

function documentoZip(head: Buffer, extensao: string): ConteudoReconhecido | null {
  const texto = head.toString("latin1");
  if (!texto.includes("[Content_Types].xml")) return null;
  const doConteudo = texto.includes("word/") ? "docx" : texto.includes("xl/") ? "xlsx" : texto.includes("ppt/") ? "pptx" : null;
  const ext = doConteudo ?? (DOCUMENTOS_OOXML.has(extensao) ? extensao : null);
  const mime = ext ? DOCUMENTOS_OOXML.get(ext) : undefined;
  // Um ZIP qualquer (ou uma extensão que contradiz o conteúdo) não é documento do Office.
  if (!ext || !mime || (doConteudo && DOCUMENTOS_OOXML.has(extensao) && doConteudo !== extensao)) return null;
  return reconhecido("document", mime, ext);
}

/**
 * Reconhece o formato pelos primeiros bytes. `nome` só desempata o que o conteúdo não distingue
 * (planilha/texto/apresentação do Office, TXT × CSV). `null` = formato que não aceitamos.
 */
export function reconhecerConteudo(head: Buffer, nome?: string | null): ConteudoReconhecido | null {
  const extensao = extensaoDoNome(nome);

  // Imagens
  if (comeca(head, 0xff, 0xd8, 0xff)) return reconhecido("image", "image/jpeg", "jpg");
  if (comeca(head, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return reconhecido("image", "image/png", "png");
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return reconhecido("image", "image/webp", "webp");

  // MP4 / 3GPP / M4A: caixa "ftyp" com a marca nos bytes 8 a 12.
  if (head.length >= 12 && ascii(head, 4, 8) === "ftyp") {
    const marca = ascii(head, 8, 12);
    if (marca === "M4A " || marca === "M4B ") return reconhecido("audio", "audio/mp4", "m4a");
    if (marca.startsWith("3gp") || marca.startsWith("3g2")) return reconhecido("video", "video/3gpp", "3gp");
    if (marca === "qt  ") return null;
    return reconhecido("video", "video/mp4", "mp4");
  }

  // Áudio
  if (ascii(head, 0, 4) === "OggS") return ascii(head, 0, 512).includes("OpusHead") ? reconhecido("audio", "audio/ogg", "ogg") : null;
  if (ascii(head, 0, 5) === "#!AMR") return reconhecido("audio", "audio/amr", "amr");
  if (ascii(head, 0, 3) === "ID3") return reconhecido("audio", "audio/mpeg", "mp3");
  if (head.length >= 2 && head[0] === 0xff) {
    const b1 = head[1]!;
    if ((b1 & 0xf6) === 0xf0) return reconhecido("audio", "audio/aac", "aac");
    if ((b1 & 0xe0) === 0xe0 && ((b1 >> 1) & 3) !== 0 && ((b1 >> 3) & 3) !== 1) return reconhecido("audio", "audio/mpeg", "mp3");
  }

  // Documentos
  if (ascii(head, 0, 5) === "%PDF-") return reconhecido("document", "application/pdf", "pdf");
  if (comeca(head, 0x50, 0x4b, 0x03, 0x04)) return documentoZip(head, extensao);
  if (comeca(head, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
    const mime = DOCUMENTOS_OLE.get(extensao);
    return mime ? reconhecido("document", mime, extensao) : null;
  }
  if ((extensao === "txt" || extensao === "csv") && pareceTexto(head)) {
    return reconhecido("document", extensao === "csv" ? "text/csv" : "text/plain", extensao);
  }
  return null;
}

/** Nome para exibir e baixar: sem caminho, sem caracteres de controle, curto; cai num nome neutro. */
export function nomeSeguroDoArquivo(nome: unknown, tipo: AnexoTipo, extensao: string): string {
  const neutro: Record<AnexoTipo, string> = { image: "imagem", video: "video", audio: "audio", document: "documento" };
  const base = typeof nome === "string"
    ? nome.replace(/[\\/]+/g, " ").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim()
    : "";
  const semPontos = base.replace(/^[.\s]+/, "");
  if (semPontos === "") return `${neutro[tipo]}.${extensao}`;
  if (semPontos.length <= 120) return semPontos;
  const ext = extensaoDoNome(semPontos);
  return ext ? `${semPontos.slice(0, 110)}.${ext}` : semPontos.slice(0, 120);
}

/** Cabeçalhos de um anexo servido ao navegador: só tipos conhecidos abrem na tela. */
export function tipoParaServir(mime: string | null, tipo: AnexoTipo): { contentType: string; inline: boolean } {
  const base = mimeBase(mime);
  if (base !== null && MIMES_ACEITOS[tipo].includes(base) && MIMES_INLINE.has(base) && tipo !== "document") {
    return { contentType: base, inline: true };
  }
  return { contentType: "application/octet-stream", inline: false };
}

/** O que a Sofia lê no lugar de um arquivo: ela não vê imagens, vídeos, áudios nem documentos. */
export const NOTA_DE_ANEXO_PARA_A_SOFIA = "[A pessoa enviou um arquivo que a Sofia não consegue ver.]";

/** Texto de uma mensagem para o histórico da Sofia: arquivo vira só a nota neutra (mais a legenda, que é texto da pessoa). */
export function conteudoParaASofia(mensagem: { content: string; kind: string | null }): string {
  if (mensagem.kind !== "anexo") return mensagem.content;
  return mensagem.content.trim() === "" ? NOTA_DE_ANEXO_PARA_A_SOFIA : `${NOTA_DE_ANEXO_PARA_A_SOFIA} ${mensagem.content}`;
}
