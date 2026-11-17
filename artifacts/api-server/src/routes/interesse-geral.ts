import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { cursosInscricao, db } from "@workspace/db";
import {
  consentimentoParaOFormulario,
  lerConsentimentoWhatsapp,
  registrarConsentimentoDoFormulario,
  registrarConsentimentoNoCartaoNovo,
  TEXTO_CONSENTIMENTO_WHATSAPP,
} from "../services/consentimentoFormulario";
import { dispararPrimeiroContato } from "../services/primeiroContatoFormulario";
import { EventFlowError } from "../services/eventIdentity";
import { resolverPessoaDoFormularioPublico } from "../services/identidadeConferencia";
import {
  DEFAULT_INTEREST_STYLE,
  INTEREST_FIELDS,
  INTEREST_GROUPS,
  findInterestGroup,
  interestGroupLabel,
  normalizeGrupo,
  normalizePaginaOrigem,
  parseInterestEventId,
  recordGeneralInterest,
  validateInterestAnswers,
} from "../services/interesseGeral";
import { allowSubmission } from "./public-submission-limit";

const router: IRouter = Router();

// ─────────────────────────────────────────────────────────────────
// PUBLIC routes — formulário de interesse genérico, sem login
// ─────────────────────────────────────────────────────────────────

function describeGroup(slug: string | null) {
  if (!slug) return null;
  const known = findInterestGroup(slug);
  return {
    slug,
    label: interestGroupLabel(slug),
    cor: known?.cor ?? DEFAULT_INTEREST_STYLE.cor,
    corTexto: known?.corTexto ?? DEFAULT_INTEREST_STYLE.corTexto,
    conhecido: Boolean(known),
  };
}

router.get("/public/interesse/formulario", (req, res): void => {
  res.json({
    campos: INTEREST_FIELDS,
    grupo: describeGroup(normalizeGrupo(req.query.grupo)),
    grupos: INTEREST_GROUPS,
    consentimento: consentimentoParaOFormulario(),
  });
});

router.post("/public/interesse/submissoes", async (req, res): Promise<void> => {
  if (!allowSubmission(req.ip || "unknown", "interesse-geral")) {
    res.status(429).json({ error: "Muitas submissões. Tente novamente em alguns instantes." });
    return;
  }
  const validation = validateInterestAnswers(req.body?.respostas);
  if (!validation.ok) { res.status(400).json({ error: validation.error }); return; }
  // Grupo ou página inválidos nunca recusam o cadastro: o lead entra sem essa informação.
  const grupo = normalizeGrupo(req.body?.grupo);
  const paginaOrigem = normalizePaginaOrigem(req.body?.paginaOrigem);
  const eventoId = parseInterestEventId(req.body?.eventoId);
  if (eventoId === false) { res.status(400).json({ error: "Curso ou evento inválido." }); return; }
  // Só `true` conta como consentimento; a caixa vem desmarcada.
  const consentiu = lerConsentimentoWhatsapp(req.body?.consentimentoWhatsapp);
  try {
    const resultado = await db.transaction(async tx => {
      let evento: { id: number; nome: string } | null = null;
      if (eventoId !== null) {
        const [encontrado] = await tx.select({ id: cursosInscricao.id, nome: cursosInscricao.nome })
          .from(cursosInscricao)
          .where(eq(cursosInscricao.id, eventoId))
          .limit(1);
        if (!encontrado) throw new EventFlowError("Curso ou evento indisponível.", 404, "EVENT_NOT_FOUND");
        evento = encontrado;
      }
      // Conflito de identidade nunca chega ao cliente: a equipe recebe o caso na ficha e no cartão.
      const origem = `formulário de interesse geral${grupo ? ` (${interestGroupLabel(grupo)})` : ""}${evento ? ` — ${evento.nome}` : ""}`;
      const { personId, conferencia } = await resolverPessoaDoFormularioPublico(tx, validation.answers, origem);
      // A autorização entra antes do cartão: a trava de contato sempre vem antes das travas de cartão.
      const registroId = await registrarConsentimentoDoFormulario(tx, { pessoaId: personId, consentiu, conferencia: Boolean(conferencia) });
      const registro = await recordGeneralInterest(tx, {
        personId, answers: validation.answers, grupo, paginaOrigem, evento, conferencia,
        consentimento: { aceito: consentiu, texto: TEXTO_CONSENTIMENTO_WHATSAPP },
      });
      if (registro.created) await registrarConsentimentoNoCartaoNovo(tx, registro.opportunity.id, registroId);
      return { personId, conferencia: Boolean(conferencia), created: registro.created, opportunityId: registro.opportunity.id };
    });
    res.status(201).json({ success: true, grupo });
    // Depois da resposta e do commit: o primeiro contato nunca atrasa nem derruba o cadastro.
    dispararPrimeiroContato({
      pessoaId: resultado.personId, opportunityId: resultado.opportunityId, consentiu,
      conferencia: resultado.conferencia, cartaoNovo: resultado.created,
    });
  } catch (error) {
    if (error instanceof EventFlowError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    throw error;
  }
});

export default router;
