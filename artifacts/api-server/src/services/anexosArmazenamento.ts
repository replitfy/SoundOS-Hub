import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Storage } from "@google-cloud/storage";

// Armazenamento dos arquivos do atendimento (anexos do WhatsApp). Os arquivos ficam no diretório PRIVADO
// do armazenamento de arquivos do projeto e só saem por uma rota autenticada do servidor: nunca por
// endereço público nem por URL assinada. A chave de um arquivo é `anexos/<conversa>/<uuid>`: apagar uma
// conversa ou uma ficha apaga o prefixo da conversa, mesmo que algum registro já tenha sumido.

export interface ArmazenamentoDeAnexos {
  /** Grava o fluxo inteiro; lança se falhar (o objeto parcial é descartado). */
  gravar(chave: string, conteudo: Readable | Buffer, contentType: string): Promise<void>;
  /** Fluxo do arquivo (ou do trecho pedido, com `fim` inclusivo). Lança `ArquivoAusenteErro` se não existir. */
  ler(chave: string, trecho?: { inicio: number; fim: number }): Promise<Readable>;
  apagar(chave: string): Promise<void>;
  /** Apaga tudo sob o prefixo e devolve quantos objetos foram removidos. */
  apagarPrefixo(prefixo: string): Promise<number>;
}

export class ArquivoAusenteErro extends Error {
  constructor() {
    super("Arquivo não encontrado no armazenamento.");
    this.name = "ArquivoAusenteErro";
  }
}

export function novaChaveDeAnexo(conversationId: number): string {
  return `anexos/${conversationId}/${randomUUID()}`;
}

export function prefixoDaConversa(conversationId: number): string {
  return `anexos/${conversationId}/`;
}

const SIDECAR = "http://127.0.0.1:1106";

function separarCaminho(diretorio: string): { bucket: string; prefixo: string } {
  const limpo = diretorio.replace(/^\/+/, "").replace(/\/+$/, "");
  const [bucket, ...resto] = limpo.split("/");
  if (!bucket) throw new Error("PRIVATE_OBJECT_DIR inválido: falta o nome do bucket.");
  return { bucket, prefixo: resto.join("/") };
}

export function criarArmazenamentoDoProjeto(env: NodeJS.ProcessEnv = process.env): ArmazenamentoDeAnexos {
  let cliente: Storage | null = null;
  const alvo = () => {
    const diretorio = env.PRIVATE_OBJECT_DIR?.trim();
    if (!diretorio) throw new Error("PRIVATE_OBJECT_DIR não está configurado: o armazenamento de arquivos não foi ativado.");
    cliente ??= new Storage({
      credentials: {
        audience: "replit",
        subject_token_type: "access_token",
        token_url: `${SIDECAR}/token`,
        type: "external_account",
        credential_source: { url: `${SIDECAR}/credential`, format: { type: "json", subject_token_field_name: "access_token" } },
        universe_domain: "googleapis.com",
      } as never,
      projectId: "",
    });
    const { bucket, prefixo } = separarCaminho(diretorio);
    const nome = (chave: string) => (prefixo ? `${prefixo}/${chave}` : chave);
    return { bucket: cliente.bucket(bucket), nome };
  };

  return {
    async gravar(chave, conteudo, contentType) {
      const { bucket, nome } = alvo();
      const arquivo = bucket.file(nome(chave));
      if (Buffer.isBuffer(conteudo)) {
        await arquivo.save(conteudo, { contentType, resumable: false });
        return;
      }
      try {
        await pipeline(conteudo, arquivo.createWriteStream({ contentType, resumable: false }));
      } catch (erro) {
        await arquivo.delete({ ignoreNotFound: true }).catch(() => undefined);
        throw erro;
      }
    },
    async ler(chave, trecho) {
      const { bucket, nome } = alvo();
      const arquivo = bucket.file(nome(chave));
      const [existe] = await arquivo.exists();
      if (!existe) throw new ArquivoAusenteErro();
      return arquivo.createReadStream(trecho ? { start: trecho.inicio, end: trecho.fim } : undefined);
    },
    async apagar(chave) {
      const { bucket, nome } = alvo();
      await bucket.file(nome(chave)).delete({ ignoreNotFound: true });
    },
    async apagarPrefixo(prefixo) {
      const { bucket, nome } = alvo();
      const [arquivos] = await bucket.getFiles({ prefix: nome(prefixo) });
      await Promise.all(arquivos.map(a => a.delete({ ignoreNotFound: true })));
      return arquivos.length;
    },
  };
}

let atual: ArmazenamentoDeAnexos | null = null;

/** Armazenamento usado pelo servidor; só é criado quando alguém precisa dele. */
export function armazenamentoDeAnexos(): ArmazenamentoDeAnexos {
  atual ??= criarArmazenamentoDoProjeto();
  return atual;
}

/** Só para testes: troca o armazenamento (use `null` para voltar ao do projeto). */
export function definirArmazenamentoDeAnexosParaTestes(armazenamento: ArmazenamentoDeAnexos | null): void {
  atual = armazenamento;
}

/** Armazenamento em memória, para testes. */
export function criarArmazenamentoEmMemoria(): ArmazenamentoDeAnexos & {
  objetos: Map<string, { conteudo: Buffer; contentType: string }>;
  falharProximaGravacao: boolean;
} {
  const objetos = new Map<string, { conteudo: Buffer; contentType: string }>();
  const estado = {
    objetos,
    falharProximaGravacao: false,
    async gravar(chave: string, conteudo: Readable | Buffer, contentType: string) {
      const partes: Buffer[] = [];
      if (Buffer.isBuffer(conteudo)) partes.push(conteudo);
      else for await (const parte of conteudo) partes.push(Buffer.from(parte as Uint8Array));
      if (estado.falharProximaGravacao) {
        estado.falharProximaGravacao = false;
        throw new Error("falha simulada do armazenamento");
      }
      objetos.set(chave, { conteudo: Buffer.concat(partes), contentType });
    },
    async ler(chave: string, trecho?: { inicio: number; fim: number }) {
      const { Readable: Leitura } = await import("node:stream");
      const objeto = objetos.get(chave);
      if (!objeto) throw new ArquivoAusenteErro();
      return Leitura.from([trecho ? objeto.conteudo.subarray(trecho.inicio, trecho.fim + 1) : objeto.conteudo]);
    },
    async apagar(chave: string) { objetos.delete(chave); },
    async apagarPrefixo(prefixo: string) {
      let total = 0;
      for (const chave of [...objetos.keys()]) {
        if (chave.startsWith(prefixo)) { objetos.delete(chave); total += 1; }
      }
      return total;
    },
  };
  return estado;
}
