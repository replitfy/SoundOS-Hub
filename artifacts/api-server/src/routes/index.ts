import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import storeRouter from "./store";
import educationRouter from "./education";
import sofiaRouter from "./sofia";
import adminRouter from "./admin";
import pessoasRouter from "./pessoas";
import pessoasLojaRouter from "./pessoas-loja";
import cursosInscricaoRouter from "./cursos-inscricao";
import interesseGeralRouter from "./interesse-geral";
import omieRouter from "./omie";
import commercialOpportunitiesRouter from "./commercial-opportunities";
import crmAtendimentoRouter from "./crm-atendimento";
import anexosRouter from "./anexos";
import habllaRouter from "./hablla";
import accessProfilesRouter from "./access-profiles";
import airtableCargaRouter from "./airtable-carga";
import formalizacaoRouter from "./formalizacao";
import { areaGuard } from "../middlewares/areaGuard";

const router: IRouter = Router();

router.use(healthRouter);
// Bloqueio por área antes de qualquer rota de tela: a decisão de acesso não
// depende de cada rota lembrar de pedir a área.
router.use(areaGuard);
router.use(dashboardRouter);
router.use(storeRouter);
router.use(educationRouter);
router.use(sofiaRouter);
router.use(adminRouter);
router.use(pessoasRouter);
router.use(pessoasLojaRouter);
router.use(cursosInscricaoRouter);
router.use(interesseGeralRouter);
router.use(formalizacaoRouter);
router.use(omieRouter);
router.use(crmAtendimentoRouter);
router.use(anexosRouter);
router.use(commercialOpportunitiesRouter);
router.use(habllaRouter);
router.use(accessProfilesRouter);
router.use(airtableCargaRouter);

export default router;
