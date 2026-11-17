import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, mensagemAnexos } from "@workspace/db";
import { requireAuth, type AuthedRequest } from "../middlewares/roleAuth";
import { logger } from "../lib/logger";
import { armazenamentoDeAnexos, ArquivoAusenteErro } from "../services/anexosArmazenamento";
import { tipoParaServir } from "../services/anexosConteudo";
import { intervaloDeBytes } from "../services/anexosAcesso";
import { copiarAnexoRecebido, reivindicarNovaCopia } from "../services/anexosRecebidos";

// Arquivos do atendimento (anexos do WhatsApp). Não existe endereço público nem link assinado: o arquivo só
// sai por aqui, com a identidade da equipe e a área Conversas conferidas pelo servidor. A tela busca com o
// cabeçalho Authorization e mostra a partir de um blob; nada depende de cookie.

const router: IRouter = Router();

function idDoAnexo(req: Request): number | null {
  const bruto = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const n = Number(bruto);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function exigirConversas(req: Request, res: Response, next: NextFunction): void {
  if (!((req as AuthedRequest).authedUser?.areas ?? []).includes("conversas")) {
    res.status(403).json({ code: "ATTACHMENT_FORBIDDEN", error: "Os arquivos do atendimento exigem a área Conversas." });
    return;
  }
  next();
}

/** Nome para o cabeçalho: versão ASCII simples e a versão UTF-8 (RFC 5987). */
function disposicao(inline: boolean, nome: string | null): string {
  const base = (nome ?? "arquivo").replace(/[\r\n"\\]/g, "_");
  const ascii = base.replace(/[^\x20-\x7e]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

router.get("/anexos/:id/arquivo", requireAuth, exigirConversas, async (req, res): Promise<void> => {
  const id = idDoAnexo(req);
  if (id === null) { res.status(400).json({ error: "Invalid id" }); return; }
  const [anexo] = await db.select().from(mensagemAnexos).where(eq(mensagemAnexos.id, id)).limit(1);
  if (!anexo || anexo.copia !== "copiado" || !anexo.storageKey || anexo.tamanhoBytes === null) {
    res.status(404).json({ code: "ATTACHMENT_UNAVAILABLE", error: "Arquivo não disponível." });
    return;
  }

  const { contentType, inline } = tipoParaServir(anexo.mimeType, anexo.tipo);
  const tamanho = anexo.tamanhoBytes;
  const intervalo = intervaloDeBytes(req.headers.range, tamanho);
  // Cabeçalhos de segurança em toda resposta: nunca HTML na tela, nada de cache, nada que o navegador reinterprete.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Accept-Ranges", "bytes");
  if (intervalo.tipo === "invalido") {
    res.status(416).setHeader("Content-Range", `bytes */${tamanho}`);
    res.end();
    return;
  }

  let fluxo;
  try {
    fluxo = await armazenamentoDeAnexos().ler(
      anexo.storageKey,
      intervalo.tipo === "parcial" ? { inicio: intervalo.inicio, fim: intervalo.fim } : undefined,
    );
  } catch (erro) {
    if (erro instanceof ArquivoAusenteErro) {
      res.status(404).json({ code: "ATTACHMENT_UNAVAILABLE", error: "Arquivo não disponível." });
      return;
    }
    logger.warn({ erroTipo: (erro as { name?: string })?.name, anexoId: id }, "anexo: não consegui ler o arquivo");
    res.status(502).json({ code: "ATTACHMENT_STORAGE_FAILED", error: "Não foi possível ler o arquivo." });
    return;
  }

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", disposicao(inline, anexo.nome));
  if (intervalo.tipo === "parcial") {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${intervalo.inicio}-${intervalo.fim}/${tamanho}`);
    res.setHeader("Content-Length", String(intervalo.fim - intervalo.inicio + 1));
  } else {
    res.setHeader("Content-Length", String(tamanho));
  }
  fluxo.on("error", erro => {
    logger.warn({ erroTipo: (erro as { name?: string })?.name, anexoId: id }, "anexo: leitura interrompida");
    res.destroy();
  });
  res.on("close", () => fluxo.destroy());
  fluxo.pipe(res);
});

// A equipe pede nova tentativa de cópia de um arquivo indisponível. Não envia nada à pessoa.
router.post("/anexos/:id/recopiar", requireAuth, exigirConversas, async (req, res): Promise<void> => {
  const id = idDoAnexo(req);
  if (id === null) { res.status(400).json({ error: "Invalid id" }); return; }
  const [anexo] = await db.select({ conversationId: mensagemAnexos.conversationId }).from(mensagemAnexos).where(eq(mensagemAnexos.id, id)).limit(1);
  if (!anexo) { res.status(404).json({ code: "NOT_FOUND", error: "Arquivo não encontrado." }); return; }
  if (!(await reivindicarNovaCopia(id, anexo.conversationId))) {
    res.status(409).json({ code: "ATTACHMENT_NOT_RETRYABLE", error: "Este arquivo não pode ser copiado de novo." });
    return;
  }
  const copia = await copiarAnexoRecebido(id);
  res.json({ copia });
});

export default router;
