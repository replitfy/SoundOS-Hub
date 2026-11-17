import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, habllaEventos } from "@workspace/db";
import { UpdateCanalInstagramBody, UpdateCanalWhatsappBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { publicAppBaseUrl } from "../lib/publicUrl";
import { requireAdminRole } from "../middlewares/roleAuth";
import {
  definirInstagramResponde, definirSofiaIniciaConversa, definirWhatsappResponde, gerarTokenWebhook, gerarTokenWebhookWhatsapp, lerConfigHablla,
  tokenDoWebhookConfere, tokenDoWebhookWhatsappConfere,
} from "../services/habllaConfig";
import {
  credenciaisHabllaConfiguradas, enviarMensagemInstagram, enviarMensagemWhatsapp, verificarCredenciaisHablla,
  type VerificacaoHablla,
} from "../services/habllaClient";
import { descreverFormato, interpretarEventoHablla } from "../services/habllaEvento";
import { interpretarEventoWhatsapp, telefoneDoRemetente, type EventoWhatsapp } from "../services/habllaEventoWhatsapp";
import { LIMITE_INICIOS_POR_DIA, LIMITE_INICIOS_POR_HORA } from "../services/primeiroContatoFormulario";
import { traduzirErroDeEnvio } from "../services/metaErros";
import { ultimaFalhaDeEnvioDoWhatsapp } from "../services/falhasDeEnvio";
import { prepararConversaWhatsapp } from "../services/cartaoDaConversa";
import {
  criarRodarSofiaSimples, processarEventoInstagram, type ProcessarEventoDeps,
} from "../services/sofiaCanalInstagram";
import {
  esperadoDoAmbiente, processarEventoWhatsapp, type ProcessarEventoWhatsappDeps,
} from "../services/sofiaCanalWhatsapp";
import { searchKnowledge } from "./sofia";

const router: IRouter = Router();

/** Ganchos só para testes: trocar as dependências e esperar o processamento em segundo plano. */
export const habllaRouteTestHooks: {
  deps: ProcessarEventoDeps | null;
  depsWhatsapp: ProcessarEventoWhatsappDeps | null;
  rastrear: ((trabalho: Promise<unknown>) => void) | null;
  verificar: (() => Promise<VerificacaoHablla>) | null;
} = { deps: null, depsWhatsapp: null, rastrear: null, verificar: null };

function dependenciasPadrao(): ProcessarEventoDeps {
  return habllaRouteTestHooks.deps ?? {
    rodarSofia: criarRodarSofiaSimples(query => searchKnowledge(query)),
    enviar: entrada => enviarMensagemInstagram(entrada),
  };
}

function dependenciasWhatsapp(): ProcessarEventoWhatsappDeps {
  return habllaRouteTestHooks.depsWhatsapp ?? {
    rodarSofia: criarRodarSofiaSimples(query => searchKnowledge(query), "whatsapp"),
    enviar: entrada => enviarMensagemWhatsapp(entrada),
    // Ficha e cartão da conversa no CRM, antes de a Sofia responder; os testes de rota não passam por aqui.
    prepararConversa: async entrada => (await prepararConversaWhatsapp(entrada)).pessoaId,
  };
}

// ── Webhooks públicos (chamados pelo Hablla, protegidos por Bearer Token) ─────
// Cada canal tem a sua rota e o seu token: o do Instagram nunca abre o WhatsApp.
router.post("/webhooks/hablla/instagram", async (req, res): Promise<void> => {
  try {
    if (!(await tokenDoWebhookConfere(req.header("authorization")))) {
      res.status(401).json({ error: "Não autorizado." });
      return;
    }

    const payload: unknown = req.body !== null && typeof req.body === "object" ? req.body : {};
    const dados = interpretarEventoHablla(payload);
    logger.info(
      { externoId: dados.externoId, direcao: dados.direcao, tipoEvento: dados.tipoEvento, formato: descreverFormato(payload) },
      "hablla instagram: evento recebido",
    );

    // O Hablla pode reenviar o mesmo evento: o id externo único garante um processamento só.
    const [gravado] = await db.insert(habllaEventos)
      .values({ externoId: dados.externoId, tipoEvento: dados.tipoEvento, payload })
      .onConflictDoNothing({ target: habllaEventos.externoId })
      .returning({ id: habllaEventos.id });
    if (!gravado) {
      res.status(200).json({ ok: true, duplicado: true });
      return;
    }

    res.status(200).json({ ok: true });

    const trabalho = processarEventoInstagram(gravado.id, dependenciasPadrao())
      .catch(err => logger.error({ err, eventoId: gravado.id }, "hablla instagram: processamento falhou"));
    habllaRouteTestHooks.rastrear?.(trabalho);
  } catch (err) {
    logger.error({ err }, "hablla instagram: erro ao receber webhook");
    if (!res.headersSent) res.status(500).json({ error: "Erro interno." });
  }
});

router.post("/webhooks/hablla/whatsapp", async (req, res): Promise<void> => {
  try {
    if (!(await tokenDoWebhookWhatsappConfere(req.header("authorization")))) {
      res.status(401).json({ error: "Não autorizado." });
      return;
    }

    const payload: unknown = req.body !== null && typeof req.body === "object" ? req.body : {};
    const dados = interpretarEventoWhatsapp(payload, esperadoDoAmbiente());
    // Só a estrutura vai para o log: nem telefone, nem texto, nem o id da mensagem (a Meta o deriva do número).
    logger.info(
      {
        tipo: dados.tipo,
        tipoEvento: dados.tipoEvento,
        motivo: dados.tipo === "ignorado" ? dados.motivo : undefined,
        formato: descreverFormato(payload),
      },
      "hablla whatsapp: evento recebido",
    );

    // O Hablla pode reenviar o mesmo evento: o id externo único (com canal e, nos status, o próprio status) garante um processamento só.
    const tipoGravado = dados.tipo === "status" ? `status:${dados.status}` : dados.tipo === "ignorado" ? dados.tipoEvento : dados.tipo;
    const [gravado] = await db.insert(habllaEventos)
      .values({ canal: "whatsapp", externoId: dados.externoId, tipoEvento: tipoGravado, payload })
      .onConflictDoNothing({ target: habllaEventos.externoId })
      .returning({ id: habllaEventos.id });
    if (!gravado) {
      res.status(200).json({ ok: true, duplicado: true });
      return;
    }

    res.status(200).json({ ok: true });

    const trabalho = processarEventoWhatsapp(gravado.id, dependenciasWhatsapp())
      .catch(err => logger.error({ err, eventoId: gravado.id }, "hablla whatsapp: processamento falhou"));
    habllaRouteTestHooks.rastrear?.(trabalho);
  } catch (err) {
    logger.error({ err }, "hablla whatsapp: erro ao receber webhook");
    if (!res.headersSent) res.status(500).json({ error: "Erro interno." });
  }
});

// ── Administração do canal (somente administradores) ─────────────────────────
async function estadoDoCanal() {
  const config = await lerConfigHablla();
  const base = publicAppBaseUrl();
  return {
    respondeAtivo: config.instagramResponde,
    tokenConfigurado: config.tokenConfigurado,
    tokenGeradoEm: config.tokenGeradoEm ? config.tokenGeradoEm.toISOString() : null,
    webhookUrl: base ? `${base}/api/webhooks/hablla/instagram` : null,
    credenciaisHabllaConfiguradas: credenciaisHabllaConfiguradas(),
  };
}

async function estadoDoCanalWhatsapp() {
  const config = await lerConfigHablla();
  const base = publicAppBaseUrl();
  return {
    respondeAtivo: config.whatsappResponde ?? false,
    iniciaConversaAtivo: config.sofiaIniciaConversa ?? false,
    limiteIniciosPorHora: LIMITE_INICIOS_POR_HORA,
    limiteIniciosPorDia: LIMITE_INICIOS_POR_DIA,
    tokenConfigurado: config.whatsappTokenConfigurado ?? false,
    tokenGeradoEm: config.whatsappTokenGeradoEm ? config.whatsappTokenGeradoEm.toISOString() : null,
    webhookUrl: base ? `${base}/api/webhooks/hablla/whatsapp` : null,
    credenciaisHabllaConfiguradas: credenciaisHabllaConfiguradas("whatsapp"),
    ultimaFalhaDeEnvio: await ultimaFalhaDeEnvioDoWhatsapp(),
  };
}

router.get("/sofia/canais/instagram", requireAdminRole, async (_req, res): Promise<void> => {
  res.json(await estadoDoCanal());
});

router.put("/sofia/canais/instagram", requireAdminRole, async (req, res): Promise<void> => {
  const parsed = UpdateCanalInstagramBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  if (parsed.data.respondeAtivo) {
    const config = await lerConfigHablla();
    if (!config.tokenConfigurado) {
      res.status(409).json({ error: "Gere o token do webhook antes de ligar a resposta automática." });
      return;
    }
    if (!credenciaisHabllaConfiguradas()) {
      res.status(409).json({ error: "Faltam o token da API, o workspace e o ID da conexão de Instagram do Hablla no ambiente." });
      return;
    }
  }
  await definirInstagramResponde(parsed.data.respondeAtivo);
  res.json(await estadoDoCanal());
});

router.get("/sofia/canais/whatsapp", requireAdminRole, async (_req, res): Promise<void> => {
  res.json(await estadoDoCanalWhatsapp());
});

router.put("/sofia/canais/whatsapp", requireAdminRole, async (req, res): Promise<void> => {
  const parsed = UpdateCanalWhatsappBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { respondeAtivo, iniciaConversaAtivo } = parsed.data;
  if (respondeAtivo === undefined && iniciaConversaAtivo === undefined) {
    res.status(400).json({ error: "Informe respondeAtivo ou iniciaConversaAtivo." });
    return;
  }

  if (respondeAtivo || iniciaConversaAtivo) {
    const config = await lerConfigHablla();
    if (!config.whatsappTokenConfigurado) {
      res.status(409).json({ error: "Gere o token do webhook do WhatsApp antes de ligar a resposta automática." });
      return;
    }
    if (!credenciaisHabllaConfiguradas("whatsapp")) {
      res.status(409).json({ error: "Faltam o token da API, o workspace e o ID da conexão de WhatsApp do Hablla no ambiente." });
      return;
    }
    // A Sofia só inicia conversa se também responde: sem isso a pessoa responderia ao modelo e ninguém leria.
    if (iniciaConversaAtivo && !(respondeAtivo ?? config.whatsappResponde)) {
      res.status(409).json({ error: "Ligue a resposta automática da Sofia no WhatsApp antes de deixá-la iniciar conversas." });
      return;
    }
  }
  // Desligar a resposta desliga também o início de conversa: o segundo depende do primeiro.
  if (respondeAtivo !== undefined) await definirWhatsappResponde(respondeAtivo);
  if (iniciaConversaAtivo !== undefined) await definirSofiaIniciaConversa(iniciaConversaAtivo);
  else if (respondeAtivo === false) await definirSofiaIniciaConversa(false);
  res.json(await estadoDoCanalWhatsapp());
});

// Só leituras na API do Hablla; a resposta traz estados e nomes de exibição, nunca segredos.
router.get("/sofia/canais/hablla/verificacao", requireAdminRole, async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await (habllaRouteTestHooks.verificar ?? verificarCredenciaisHablla)());
});

router.post("/sofia/canais/instagram/token", requireAdminRole, async (_req, res): Promise<void> => {
  const { token, geradoEm } = await gerarTokenWebhook();
  // O token só aparece nesta resposta; nada deve ficar em cache.
  res.setHeader("Cache-Control", "no-store");
  res.json({ token, geradoEm: geradoEm.toISOString() });
});

router.post("/sofia/canais/whatsapp/token", requireAdminRole, async (_req, res): Promise<void> => {
  const { token, geradoEm } = await gerarTokenWebhookWhatsapp();
  // O token só aparece nesta resposta; nada deve ficar em cache.
  res.setHeader("Cache-Control", "no-store");
  res.json({ token, geradoEm: geradoEm.toISOString() });
});

const EVENTOS_RECENTES = 50;
const TEXTO_RESUMIDO = 140;

router.get("/sofia/canais/instagram/eventos", requireAdminRole, async (_req, res): Promise<void> => {
  // Cada canal lista só os seus eventos.
  const linhas = await db.select().from(habllaEventos).where(eq(habllaEventos.canal, "instagram"))
    .orderBy(desc(habllaEventos.createdAt), desc(habllaEventos.id)).limit(EVENTOS_RECENTES);
  res.json(linhas.map(linha => {
    const dados = interpretarEventoHablla(linha.payload);
    return {
      id: linha.id,
      createdAt: linha.createdAt.toISOString(),
      status: linha.status,
      motivo: linha.motivo,
      tipoEvento: linha.tipoEvento,
      conversationId: linha.conversationId,
      usuario: dados.usuario,
      texto: dados.texto ? dados.texto.slice(0, TEXTO_RESUMIDO) + (dados.texto.length > TEXTO_RESUMIDO ? "…" : "") : null,
    };
  }));
});

/** Motivo, em português, de um evento que é uma falha de envio ou de entrega; nulo nos demais. */
function falhaDoEvento(dados: EventoWhatsapp): string | null {
  if (dados.tipo === "status" && dados.status === "failed") return traduzirErroDeEnvio(dados.erro) ?? "O WhatsApp não entregou a mensagem.";
  if (dados.tipo === "resultado_envio" && !dados.sucesso) return traduzirErroDeEnvio(dados.erro) ?? "O Hablla não conseguiu enviar a mensagem.";
  return null;
}

router.get("/sofia/canais/whatsapp/eventos", requireAdminRole, async (_req, res): Promise<void> => {
  const linhas = await db.select().from(habllaEventos).where(eq(habllaEventos.canal, "whatsapp"))
    .orderBy(desc(habllaEventos.createdAt), desc(habllaEventos.id)).limit(EVENTOS_RECENTES);
  const esperado = esperadoDoAmbiente();
  res.json(linhas.map(linha => {
    const dados = interpretarEventoWhatsapp(linha.payload, esperado);
    const bruto = typeof linha.payload === "object" && linha.payload !== null ? (linha.payload as Record<string, unknown>) : {};
    return {
      id: linha.id,
      createdAt: linha.createdAt.toISOString(),
      status: linha.status,
      motivo: linha.motivo,
      tipoEvento: linha.tipoEvento,
      conversationId: linha.conversationId,
      telefone: dados.tipo === "mensagem" ? dados.telefone : telefoneDoRemetente(bruto.sender_phone),
      falha: falhaDoEvento(dados),
      texto: dados.tipo === "mensagem"
        ? dados.texto.slice(0, TEXTO_RESUMIDO) + (dados.texto.length > TEXTO_RESUMIDO ? "…" : "")
        : null,
    };
  }));
});

export default router;
