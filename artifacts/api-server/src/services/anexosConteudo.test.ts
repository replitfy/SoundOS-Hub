import { describe, expect, it } from "vitest";
import {
  conteudoParaASofia, LIMITE_DE_ENVIO, mimeAceitoParaOTipo, mimeBase, nomeSeguroDoArquivo, NOTA_DE_ANEXO_PARA_A_SOFIA,
  reconhecerConteudo, tipoParaServir,
} from "./anexosConteudo";

const bytes = (...valores: number[]) => Buffer.from(valores);
const texto = (valor: string) => Buffer.from(valor, "latin1");
const comRelleno = (inicio: Buffer, total = 64) => Buffer.concat([inicio, Buffer.alloc(Math.max(0, total - inicio.length))]);

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const WEBP = Buffer.concat([texto("RIFF"), bytes(1, 2, 3, 4), texto("WEBP")]);
const ftyp = (marca: string) => Buffer.concat([bytes(0, 0, 0, 0x18), texto("ftyp"), texto(marca), bytes(0, 0, 0, 0)]);
const OLE = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);

describe("reconhecerConteudo — o tipo vem do conteúdo, não do nome", () => {
  it.each([
    ["JPEG", JPEG, "image", "image/jpeg"],
    ["PNG", PNG, "image", "image/png"],
    ["WebP", WEBP, "image", "image/webp"],
    ["MP4", ftyp("isom"), "video", "video/mp4"],
    ["3GPP", ftyp("3gp4"), "video", "video/3gpp"],
    ["M4A", ftyp("M4A "), "audio", "audio/mp4"],
    ["OGG Opus", Buffer.concat([texto("OggS"), Buffer.alloc(20), texto("OpusHead")]), "audio", "audio/ogg"],
    ["AMR", texto("#!AMR\n"), "audio", "audio/amr"],
    ["MP3 com ID3", texto("ID3\u0004"), "audio", "audio/mpeg"],
    ["MP3 sem ID3", bytes(0xff, 0xfb, 0x90, 0x00), "audio", "audio/mpeg"],
    ["AAC", bytes(0xff, 0xf1, 0x50, 0x80), "audio", "audio/aac"],
    ["PDF", texto("%PDF-1.7\n"), "document", "application/pdf"],
  ] as const)("%s", (_nome, head, tipo, mime) => {
    expect(reconhecerConteudo(comRelleno(head))).toMatchObject({ tipo, mime });
  });

  it("documentos do Office: ZIP com a estrutura certa; OLE só com a extensão compatível", () => {
    const docx = Buffer.concat([bytes(0x50, 0x4b, 0x03, 0x04), texto("[Content_Types].xml word/document.xml")]);
    const xlsx = Buffer.concat([bytes(0x50, 0x4b, 0x03, 0x04), texto("[Content_Types].xml xl/workbook.xml")]);
    expect(reconhecerConteudo(docx, "a.docx")).toMatchObject({ tipo: "document", extensao: "docx" });
    expect(reconhecerConteudo(xlsx)).toMatchObject({ tipo: "document", extensao: "xlsx" });
    expect(reconhecerConteudo(comRelleno(OLE), "a.xls")).toMatchObject({ mime: "application/vnd.ms-excel" });
    expect(reconhecerConteudo(comRelleno(OLE), "a.png")).toBeNull();
  });

  it("recusa ZIP qualquer, executável, HTML, SVG, GIF, MOV, OGG sem Opus e extensão que contradiz o conteúdo", () => {
    expect(reconhecerConteudo(Buffer.concat([bytes(0x50, 0x4b, 0x03, 0x04), texto("arquivo.txt")]), "a.docx")).toBeNull();
    expect(reconhecerConteudo(comRelleno(texto("MZ")), "a.pdf")).toBeNull();
    expect(reconhecerConteudo(texto("<html><script>alert(1)</script>"), "a.html")).toBeNull();
    expect(reconhecerConteudo(texto("<svg xmlns='http://www.w3.org/2000/svg'/>"), "a.svg")).toBeNull();
    expect(reconhecerConteudo(texto("GIF89a"), "a.gif")).toBeNull();
    expect(reconhecerConteudo(ftyp("qt  "), "a.mov")).toBeNull();
    expect(reconhecerConteudo(Buffer.concat([texto("OggS"), Buffer.alloc(40)]), "a.ogg")).toBeNull();
    const docxComo = Buffer.concat([bytes(0x50, 0x4b, 0x03, 0x04), texto("[Content_Types].xml word/document.xml")]);
    expect(reconhecerConteudo(docxComo, "a.xlsx")).toBeNull();
  });

  it("texto só vale com extensão txt ou csv e sem bytes nulos; CSV é só de recebimento", () => {
    expect(reconhecerConteudo(texto("linha 1\nlinha 2\n"), "a.txt")).toMatchObject({ mime: "text/plain", enviavel: true });
    expect(reconhecerConteudo(texto("a,b\n1,2\n"), "a.csv")).toMatchObject({ mime: "text/csv", enviavel: false });
    expect(reconhecerConteudo(texto("linha 1\n"), "a.exe")).toBeNull();
    expect(reconhecerConteudo(Buffer.concat([texto("abc"), bytes(0)]), "a.txt")).toBeNull();
    expect(reconhecerConteudo(Buffer.alloc(0), "a.txt")).toBeNull();
  });

  it("só imagem, vídeo e áudio de tipos conhecidos abrem na tela", () => {
    expect(reconhecerConteudo(comRelleno(JPEG))?.inline).toBe(true);
    expect(reconhecerConteudo(comRelleno(texto("%PDF-1.4")))?.inline).toBe(false);
  });
});

describe("formato declarado e cabeçalhos de entrega", () => {
  it("mimeBase tira parâmetros e rejeita lixo; só os formatos da lista são aceitos para o tipo", () => {
    expect(mimeBase("Audio/OGG; codecs=opus")).toBe("audio/ogg");
    expect(mimeBase("não é mime")).toBeNull();
    expect(mimeBase(12)).toBeNull();
    expect(mimeAceitoParaOTipo("audio", "audio/ogg")).toBe(true);
    expect(mimeAceitoParaOTipo("image", "image/gif")).toBe(false);
    expect(mimeAceitoParaOTipo("image", "audio/ogg")).toBe(false);
    expect(mimeAceitoParaOTipo("image", null)).toBe(false);
  });

  it("limites de envio seguem a Meta: 5 MB imagem, 16 MB vídeo/áudio, 100 MB documento", () => {
    expect(LIMITE_DE_ENVIO).toEqual({ image: 5 * 1024 * 1024, video: 16 * 1024 * 1024, audio: 16 * 1024 * 1024, document: 100 * 1024 * 1024 });
  });

  it("tipoParaServir: conhecido abre na tela; documento, tipo errado ou desconhecido vira download genérico", () => {
    expect(tipoParaServir("image/png", "image")).toEqual({ contentType: "image/png", inline: true });
    expect(tipoParaServir("application/pdf", "document")).toEqual({ contentType: "application/octet-stream", inline: false });
    expect(tipoParaServir("text/html", "document")).toEqual({ contentType: "application/octet-stream", inline: false });
    expect(tipoParaServir("text/html", "image")).toEqual({ contentType: "application/octet-stream", inline: false });
    expect(tipoParaServir(null, "video")).toEqual({ contentType: "application/octet-stream", inline: false });
  });
});

describe("nome do arquivo e o que a Sofia lê", () => {
  it("tira caminho, controle e invisíveis; sem nome usa um neutro; nome longo é encurtado mantendo a extensão", () => {
    expect(nomeSeguroDoArquivo("../../etc/passwd.pdf", "document", "pdf")).toBe("etc passwd.pdf");
    expect(nomeSeguroDoArquivo("a\u0000b\u202ec.pdf", "document", "pdf")).toBe("abc.pdf");
    expect(nomeSeguroDoArquivo(null, "image", "jpg")).toBe("imagem.jpg");
    expect(nomeSeguroDoArquivo("...", "document", "pdf")).toBe("documento.pdf");
    const longo = nomeSeguroDoArquivo(`${"a".repeat(300)}.pdf`, "document", "pdf");
    expect(longo.length).toBeLessThanOrEqual(120);
    expect(longo.endsWith(".pdf")).toBe(true);
  });

  it("a Sofia vê só a nota neutra (mais a legenda, que é texto da pessoa)", () => {
    expect(conteudoParaASofia({ content: "", kind: "anexo" })).toBe(NOTA_DE_ANEXO_PARA_A_SOFIA);
    expect(conteudoParaASofia({ content: "Segue", kind: "anexo" })).toBe(`${NOTA_DE_ANEXO_PARA_A_SOFIA} Segue`);
    expect(conteudoParaASofia({ content: "Oi", kind: null })).toBe("Oi");
  });
});
