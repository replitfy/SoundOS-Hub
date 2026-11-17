import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request } from "express";
import type { StorageEngine } from "multer";
import type { AnexoTipo } from "@workspace/db";
import { BYTES_PARA_RECONHECER, LIMITE_DE_ENVIO, MAIOR_LIMITE_DE_ENVIO, reconhecerConteudo } from "./anexosConteudo";

// Recebimento do arquivo que a equipe anexa no cartão: grava num arquivo temporário (nunca na memória) e
// confere o conteúdo ENQUANTO recebe. O tipo vem dos primeiros bytes; passou do limite daquele tipo, a
// leitura para na hora (a Meta limita imagem a 5 MB, vídeo e áudio a 16 MB, documento a 100 MB). Um
// arquivo recusado nunca chega ao armazenamento nem ao WhatsApp.

export type MotivoDeUploadRecusado = "tipo_nao_permitido" | "tamanho_excedido" | "arquivo_vazio";

export class UploadDeAnexoRecusado extends Error {
  constructor(public readonly motivo: MotivoDeUploadRecusado, public readonly tipo: AnexoTipo | null = null) {
    super(`upload de anexo recusado: ${motivo}`);
    this.name = "UploadDeAnexoRecusado";
  }
}

/** O que o multer deixa em `req.file` depois do recebimento. */
export interface ArquivoRecebido {
  caminho: string;
  tamanho: number;
  sha256: string;
}

class Verificador extends Transform {
  bytes = 0;
  private readonly hash = createHash("sha256");
  private readonly inicio: Buffer[] = [];
  private tamanhoDoInicio = 0;
  private limite = MAIOR_LIMITE_DE_ENVIO;
  private tipo: AnexoTipo | null = null;
  private avaliado = false;

  constructor(private readonly nome: string) { super(); }

  private avaliar(): UploadDeAnexoRecusado | null {
    const conteudo = reconhecerConteudo(Buffer.concat(this.inicio), this.nome);
    if (conteudo === null || !conteudo.enviavel) return new UploadDeAnexoRecusado("tipo_nao_permitido");
    this.avaliado = true;
    this.tipo = conteudo.tipo;
    this.limite = LIMITE_DE_ENVIO[conteudo.tipo];
    return this.bytes > this.limite ? new UploadDeAnexoRecusado("tamanho_excedido", conteudo.tipo) : null;
  }

  override _transform(pedaco: Buffer, _codificacao: BufferEncoding, proximo: TransformCallback): void {
    this.bytes += pedaco.length;
    if (this.bytes > this.limite) { proximo(new UploadDeAnexoRecusado("tamanho_excedido", this.tipo)); return; }
    this.hash.update(pedaco);
    if (this.tamanhoDoInicio < BYTES_PARA_RECONHECER) {
      const parte = pedaco.subarray(0, BYTES_PARA_RECONHECER - this.tamanhoDoInicio);
      this.inicio.push(parte);
      this.tamanhoDoInicio += parte.length;
    }
    if (!this.avaliado && this.tamanhoDoInicio >= BYTES_PARA_RECONHECER) {
      const erro = this.avaliar();
      if (erro) { proximo(erro); return; }
    }
    proximo(null, pedaco);
  }

  override _flush(fim: TransformCallback): void {
    if (this.bytes === 0) { fim(new UploadDeAnexoRecusado("arquivo_vazio")); return; }
    if (!this.avaliado) {
      const erro = this.avaliar();
      if (erro) { fim(erro); return; }
    }
    fim();
  }

  get sha256(): string { return this.hash.copy().digest("hex"); }
}

export class ArmazenamentoTemporarioDeAnexos implements StorageEngine {
  _handleFile(_req: Request, arquivo: Express.Multer.File, cb: (erro?: unknown, info?: Partial<Express.Multer.File> & ArquivoRecebido) => void): void {
    const caminho = join(tmpdir(), `anexo-${randomUUID()}`);
    const verificador = new Verificador(arquivo.originalname);
    pipeline(arquivo.stream, verificador, createWriteStream(caminho, { mode: 0o600 }))
      .then(() => cb(null, { path: caminho, caminho, tamanho: verificador.bytes, size: verificador.bytes, sha256: verificador.sha256 }))
      .catch(erro => { unlink(caminho).catch(() => undefined); cb(erro); });
  }

  _removeFile(_req: Request, arquivo: Express.Multer.File, cb: (erro: Error | null) => void): void {
    unlink(arquivo.path).then(() => cb(null)).catch(() => cb(null));
  }
}
