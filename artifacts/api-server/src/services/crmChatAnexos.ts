import { createReadStream, openAsBlob } from "node:fs";
import { open } from "node:fs/promises";
import { db, mensagemAnexos, messages, canalEnvios } from "@workspace/db";
import { logger } from "../lib/logger";
import { enviarAnexoWhatsapp, HabllaErro, type HabllaClientDeps } from "./habllaClient";
import { OpportunityRuleError, type OpportunityActor } from "./commercialOpportunities";
import { comTravaDaConversa } from "./conversationLock";
import { comTravaDeContato } from "./contatoAutorizacao";
import { exigirHumano, registrarAcaoNosCartoesAbertos } from "./crmAtendimento";
import {
  conversaVinculadaDoCartao, ESPERA_TRAVA_CONVERSA_MS, exigirCondicoesDeEnvioLivre, ocupada,
} from "./crmChat";
import { reconciliarEntrega } from "./entregaWhatsapp";
import { esperadoDoAmbiente } from "./sofiaCanalWhatsapp";
import { armazenamentoDeAnexos, novaChaveDeAnexo, type ArmazenamentoDeAnexos } from "./anexosArmazenamento";
import { BYTES_PARA_RECONHECER, LIMITE_DE_ENVIO, nomeSeguroDoArquivo, reconhecerConteudo } from "./anexosConteudo";
import type { ArquivoRecebido } from "./anexosUpload";

// Arquivo enviado pela equipe no chat do cartão. Mesmas regras do texto livre (atendimento assumido, janela
// de 24h, pessoa que não pediu para ficar sem mensagens, conversa vinculada, travas pessoa → conversa →
// cartão), mais o conteúdo conferido pelos primeiros bytes e o limite do tipo. Um arquivo por mensagem e uma
// única tentativa de envio: falhou, a equipe vê e decide. O arquivo é guardado antes do envio, então a
// tentativa fica visível mesmo quando o WhatsApp recusa.

export const LIMITE_DA_LEGENDA = 1_024;

export interface ArquivoParaEnviar extends ArquivoRecebido {
  nomeOriginal: string;
}

function megabytes(bytes: number): string {
  return String(Math.round(bytes / (1024 * 1024)));
}

async function inicioDoArquivo(caminho: string): Promise<Buffer> {
  const arquivo = await open(caminho, "r");
  try {
    const buffer = Buffer.alloc(BYTES_PARA_RECONHECER);
    const { bytesRead } = await arquivo.read(buffer, 0, BYTES_PARA_RECONHECER, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await arquivo.close();
  }
}

export async function enviarAnexoDaEquipe(input: {
  opportunityId: number;
  actor: OpportunityActor;
  arquivo: ArquivoParaEnviar;
  legenda: unknown;
  deps?: HabllaClientDeps;
  armazenamento?: ArmazenamentoDeAnexos;
  agora?: () => Date;
}): Promise<{ messageId: number; anexoId: number }> {
  const autorId = exigirHumano(input.actor);
  const deps = input.deps ?? {};
  const agora = input.agora ?? (() => new Date());
  const armazenamento = input.armazenamento ?? armazenamentoDeAnexos();

  const legenda = typeof input.legenda === "string" ? input.legenda.trim() : "";
  if (legenda.length > LIMITE_DA_LEGENDA) {
    throw new OpportunityRuleError(`A legenda passa de ${LIMITE_DA_LEGENDA} caracteres.`, "TEXT_TOO_LONG", 422);
  }

  // Confere de novo o arquivo recebido (o servidor nunca confia no que o navegador declarou).
  const conteudo = reconhecerConteudo(await inicioDoArquivo(input.arquivo.caminho), input.arquivo.nomeOriginal);
  if (conteudo === null || !conteudo.enviavel) {
    throw new OpportunityRuleError(
      "Este tipo de arquivo não pode ser enviado pelo WhatsApp. Use imagem JPEG/PNG/WebP, vídeo MP4, áudio, PDF ou documento do Office.",
      "ATTACHMENT_TYPE_NOT_ALLOWED", 422,
    );
  }
  if (input.arquivo.tamanho <= 0) throw new OpportunityRuleError("O arquivo está vazio.", "ATTACHMENT_EMPTY", 422);
  const limite = LIMITE_DE_ENVIO[conteudo.tipo];
  if (input.arquivo.tamanho > limite) {
    throw new OpportunityRuleError(`O arquivo passa do limite de ${megabytes(limite)} MB para este tipo.`, "ATTACHMENT_TOO_LARGE", 413);
  }
  if (conteudo.tipo === "audio" && legenda !== "") {
    throw new OpportunityRuleError("O WhatsApp não aceita legenda em áudio.", "CAPTION_NOT_ALLOWED", 422);
  }
  const nome = nomeSeguroDoArquivo(input.arquivo.nomeOriginal, conteudo.tipo, conteudo.extensao);

  const { pessoaId, conversationId } = await conversaVinculadaDoCartao(input.opportunityId);
  return comTravaDeContato(pessoaId, async () => {
    try {
      return await comTravaDaConversa(conversationId, async () => {
        const { canalUsuario } = await exigirCondicoesDeEnvioLivre({ opportunityId: input.opportunityId, pessoaId, conversationId, agora: agora() });

        // O arquivo é guardado antes de qualquer mensagem: se o armazenamento falhar, nada foi registrado nem enviado.
        const chave = novaChaveDeAnexo(conversationId);
        try {
          await armazenamento.gravar(chave, createReadStream(input.arquivo.caminho), conteudo.mime);
        } catch (erro) {
          logger.warn({ erroTipo: (erro as { name?: string })?.name, conversationId }, "chat do CRM: não consegui guardar o arquivo");
          await armazenamento.apagar(chave).catch(() => undefined);
          throw new OpportunityRuleError("Não foi possível guardar o arquivo. Nada foi enviado.", "ATTACHMENT_STORAGE_FAILED", 502);
        }

        let registro: { messageId: number; anexoId: number };
        try {
          registro = await db.transaction(async tx => {
            const [mensagem] = await tx.insert(messages).values({
              conversationId, role: "staff", content: legenda, authorUserId: autorId, kind: "anexo",
            }).returning({ id: messages.id });
            const [anexo] = await tx.insert(mensagemAnexos).values({
              messageId: mensagem!.id, conversationId, direcao: "enviado", tipo: conteudo.tipo, nome,
              mimeType: conteudo.mime, tamanhoBytes: input.arquivo.tamanho, sha256: input.arquivo.sha256,
              copia: "copiado", storageKey: chave,
            }).returning({ id: mensagemAnexos.id });
            return { messageId: mensagem!.id, anexoId: anexo!.id };
          });
        } catch (erro) {
          await armazenamento.apagar(chave).catch(() => undefined);
          throw erro;
        }

        let externoId: string | null;
        try {
          const blob = await openAsBlob(input.arquivo.caminho, { type: conteudo.mime });
          ({ externoId } = await enviarAnexoWhatsapp({
            para: canalUsuario, tipo: conteudo.tipo, arquivo: blob, mime: conteudo.mime, nome, legenda: legenda || null,
          }, deps));
        } catch (erro) {
          logger.warn({ erroTipo: (erro as { name?: string })?.name, erroCodigo: (erro as { codigo?: string })?.codigo, conversationId }, "chat do CRM: envio de arquivo falhou");
          const detalhe = (erro instanceof Error ? erro.message : String(erro)).slice(0, 500);
          await db.insert(canalEnvios).values({
            conversationId, messageId: registro.messageId, canal: "whatsapp", texto: legenda || null, status: "falhou", erro: detalhe,
          });
          throw new OpportunityRuleError(
            erro instanceof HabllaErro && erro.codigo === "janela_24h"
              ? "O WhatsApp recusou o arquivo: a janela de 24h está fechada."
              : "Não foi possível enviar o arquivo. Ele não foi reenviado.",
            "SEND_FAILED", 502, { messageId: registro.messageId },
          );
        }
        await db.insert(canalEnvios).values({
          conversationId, messageId: registro.messageId, canal: "whatsapp", texto: legenda || null, status: "aceito",
          externoId, filaId: externoId,
        });
        if (externoId) {
          await reconciliarEntrega(externoId, esperadoDoAmbiente(deps.env)).catch(erro =>
            logger.warn({ erroTipo: (erro as { name?: string })?.name }, "chat do CRM: não consegui reaplicar avisos de entrega pendentes"));
        }
        // Arquivo já enviado: o histórico não pode falhar por o cartão ter sido encerrado nesse meio-tempo.
        await db.transaction(tx => registrarAcaoNosCartoesAbertos(tx, pessoaId, input.actor, "ATTACHMENT_SENT", {
          conversationId, messageId: registro.messageId, tipo: conteudo.tipo, nome, excerpt: legenda ? legenda.slice(0, 200) : null,
        }));
        return registro;
      }, ESPERA_TRAVA_CONVERSA_MS);
    } catch (erro) { return ocupada(erro); }
  });
}
