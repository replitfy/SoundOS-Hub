import { and, eq, isNull } from "drizzle-orm";
import { db, mensagemAnexos, type AnexoCopia, type AnexoDirecao, type AnexoTipo } from "@workspace/db";
import { COPIA_PENDENTE_EXPIRA_MS } from "./anexosRecebidos";

// Leitura dos anexos pela equipe: descrição para a tela (sem endereço, chave do armazenamento nem hash), marca
// de "visto" e o intervalo de bytes de uma requisição com Range. O arquivo em si só sai pela rota autenticada.

export interface AnexoDaMensagem {
  id: number;
  tipo: AnexoTipo;
  direcao: AnexoDirecao;
  nome: string | null;
  mimeType: string | null;
  tamanhoBytes: number | null;
  /** Estado já corrigido: uma cópia "pendente" interrompida há muito tempo aparece como indisponível. */
  copia: AnexoCopia;
  /** Código do motivo (a tela traduz). */
  motivo: string | null;
  /** Arquivo recebido que ninguém da equipe abriu ainda. */
  naoVisto: boolean;
  /** A equipe pode pedir nova tentativa de cópia (não envia nada à pessoa). */
  podeRecopiar: boolean;
}

export function estadoEfetivoDaCopia(copia: AnexoCopia, atualizadoEm: Date, agora: Date): AnexoCopia {
  return copia === "pendente" && agora.getTime() - atualizadoEm.getTime() > COPIA_PENDENTE_EXPIRA_MS ? "indisponivel" : copia;
}

/** Anexos da conversa, por id da mensagem. */
export async function anexosDaConversa(conversationId: number, agora: Date = new Date()): Promise<Map<number, AnexoDaMensagem>> {
  const linhas = await db.select().from(mensagemAnexos).where(eq(mensagemAnexos.conversationId, conversationId));
  const porMensagem = new Map<number, AnexoDaMensagem>();
  for (const linha of linhas) {
    const copia = estadoEfetivoDaCopia(linha.copia, linha.updatedAt, agora);
    porMensagem.set(linha.messageId, {
      id: linha.id,
      tipo: linha.tipo,
      direcao: linha.direcao,
      nome: linha.nome,
      mimeType: linha.mimeType,
      tamanhoBytes: linha.tamanhoBytes,
      copia,
      motivo: copia === "indisponivel" && linha.copia === "pendente" ? "download_falhou" : linha.motivo,
      naoVisto: linha.direcao === "recebido" && linha.vistoEm === null,
      podeRecopiar: linha.direcao === "recebido" && copia === "indisponivel" && linha.urlOrigem !== null,
    });
  }
  return porMensagem;
}

/** A equipe abriu a conversa: os arquivos recebidos até agora passam a "vistos". Devolve quantos foram marcados. */
export async function marcarAnexosComoVistos(conversationId: number, usuarioId: number, agora: Date = new Date()): Promise<number> {
  const marcados = await db.update(mensagemAnexos).set({ vistoEm: agora, vistoPor: usuarioId })
    .where(and(
      eq(mensagemAnexos.conversationId, conversationId),
      eq(mensagemAnexos.direcao, "recebido"),
      isNull(mensagemAnexos.vistoEm),
    )).returning({ id: mensagemAnexos.id });
  return marcados.length;
}

export type IntervaloPedido =
  | { tipo: "completo" }
  | { tipo: "parcial"; inicio: number; fim: number }
  | { tipo: "invalido" };

/** Interpreta `Range: bytes=...` (um só intervalo; vários ou formato desconhecido servem o arquivo inteiro). */
export function intervaloDeBytes(cabecalho: string | undefined, tamanho: number): IntervaloPedido {
  if (cabecalho === undefined) return { tipo: "completo" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(cabecalho.trim());
  if (!m) return { tipo: "completo" };
  const [, de, ate] = m;
  if (de === "" && ate === "") return { tipo: "invalido" };
  if (tamanho <= 0) return { tipo: "invalido" };
  if (de === "") {
    const ultimos = Number(ate);
    if (!Number.isSafeInteger(ultimos) || ultimos <= 0) return { tipo: "invalido" };
    return { tipo: "parcial", inicio: Math.max(0, tamanho - ultimos), fim: tamanho - 1 };
  }
  const inicio = Number(de);
  const fim = ate === "" ? tamanho - 1 : Math.min(Number(ate), tamanho - 1);
  if (!Number.isSafeInteger(inicio) || inicio >= tamanho || fim < inicio) return { tipo: "invalido" };
  return { tipo: "parcial", inicio, fim };
}
