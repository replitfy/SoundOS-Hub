import { readFile, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { UploadDeAnexoRecusado } from "./anexosUpload";
import { ArmazenamentoTemporarioDeAnexos } from "./anexosUpload";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const criados: string[] = [];
afterEach(async () => { await Promise.all(criados.splice(0).map(c => unlink(c).catch(() => undefined))); });

function receber(nome: string, partes: Buffer[]) {
  const engine = new ArmazenamentoTemporarioDeAnexos();
  return new Promise<{ caminho: string; tamanho: number; sha256: string }>((resolve, reject) => {
    engine._handleFile({} as never, { originalname: nome, stream: Readable.from(partes) } as never, (erro, info) => {
      if (erro) { reject(erro); return; }
      criados.push(info!.caminho);
      resolve(info as never);
    });
  });
}

describe("recebimento do arquivo anexado pela equipe", () => {
  it("grava num arquivo temporário e devolve tamanho e hash do que foi gravado", async () => {
    const conteudo = Buffer.concat([PNG, Buffer.alloc(1000, 7)]);
    const recebido = await receber("foto.png", [conteudo.subarray(0, 100), conteudo.subarray(100)]);
    expect(recebido.tamanho).toBe(conteudo.length);
    expect(recebido.sha256).toBe(createHash("sha256").update(conteudo).digest("hex"));
    expect((await readFile(recebido.caminho)).equals(conteudo)).toBe(true);
    expect(((await stat(recebido.caminho)).mode & 0o777)).toBe(0o600);
  });

  it("arquivo vazio, formato não aceito e executável são recusados sem deixar rastro", async () => {
    await expect(receber("a.png", [Buffer.alloc(0)])).rejects.toMatchObject({ motivo: "arquivo_vazio" });
    await expect(receber("a.png", [Buffer.from("<html></html>")])).rejects.toMatchObject({ motivo: "tipo_nao_permitido" });
    await expect(receber("a.pdf", [Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100)])])).rejects.toBeInstanceOf(UploadDeAnexoRecusado);
  });

  it("imagem acima de 5 MB é interrompida pelo limite do tipo (não do maior limite)", async () => {
    const grande = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    const pedacos: Buffer[] = [];
    for (let i = 0; i < grande.length; i += 64 * 1024) pedacos.push(grande.subarray(i, i + 64 * 1024));
    await expect(receber("grande.png", pedacos)).rejects.toMatchObject({ motivo: "tamanho_excedido", tipo: "image" });
  });
});
