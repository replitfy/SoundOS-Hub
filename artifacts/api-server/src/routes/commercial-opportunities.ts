import { Router, type IRouter, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import { db } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, type AuthedRequest } from "../middlewares/roleAuth";
import { loadProfileSummaries, summarizeUserProfile } from "../services/accessProfiles";
import {
  claimOpportunity,
  completeOpportunityTask,
  createOpportunity,
  getOpportunityDetail,
  listOpportunities,
  OpportunityRuleError,
  transitionOpportunity,
  updateOpportunity,
  parseOpportunityDate,
  parseConfirmationEvidence,
  assertReactivationTarget,
  getConfirmationEvidenceOptions,
} from "../services/commercialOpportunities";
import {
  OPPORTUNITY_NUCLEI,
  OPPORTUNITY_STAGES,
  OPPORTUNITY_TASK_TYPES,
  CONTACT_STATUSES,
  OFFER_INTEREST_STATUSES,
  type OpportunityNucleus,
  type OpportunityStage,
  type OpportunityTaskType,
  usersTable,
} from "@workspace/db";
import type { OpportunityActor } from "../services/commercialOpportunities";
import {
  CreateCommercialOpportunityBody,
  CompleteCommercialOpportunityTaskBody,
  TransitionCommercialOpportunityBody,
  UpdateCommercialOpportunityBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

export function crmKanbanEnabled(): boolean {
  const configured = process.env.CRM_KANBAN_ENABLED?.trim().toLowerCase();
  if (configured !== undefined && configured !== "") {
    return !["0", "false", "off", "no"].includes(configured);
  }
  // The completed CRM is available by default in every environment. The flag
  // remains an explicit emergency kill switch when set to a false-like value.
  return true;
}

function actor(req: AuthedRequest): OpportunityActor {
  const user = req.authedUser;
  if (!user) throw new OpportunityRuleError("Not authenticated.", "UNAUTHENTICATED", 401);
  return { kind: "HUMAN", id: user.id, role: user.role, isAdmin: user.isAdmin };
}

function idOf(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new OpportunityRuleError("Invalid opportunity id.");
  return id;
}

function bodyString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function bodyNumber(value: unknown): number | undefined {
  if (value === null) return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function assertEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): asserts value is T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new OpportunityRuleError(`Invalid ${field}.`);
  }
}

router.use("/crm/opportunities", (req, res, next) => {
  if (!crmKanbanEnabled()) {
    res.status(404).json({ code: "CRM_KANBAN_DISABLED", error: "CRM Kanban is disabled." });
    return;
  }
  next();
});

// The CRM belongs to profiles that have the "crm" menu area. Being able to
// authenticate is not enough: the area comes from the profile read on this request.
function requireCrmStaff(req: Request, res: Response, next: NextFunction): void {
  const areas = (req as AuthedRequest).authedUser?.areas;
  if (!areas || !areas.includes("crm")) {
    res.status(403).json({ code: "CRM_FORBIDDEN", error: "CRM staff permission required." });
    return;
  }
  next();
}

function runRoute(handler: (req: AuthedRequest, res: Response) => Promise<void>): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req as AuthedRequest, res);
    } catch (error) {
      if (error instanceof OpportunityRuleError) {
        res.status(error.status).json({ code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
        return;
      }
      next(error);
    }
  };
}

router.get("/crm/opportunities", requireAuth, requireCrmStaff, runRoute(async (req, res) => {
  const query = req.query as Record<string, string | undefined>;
  const filters: {
    stage?: OpportunityStage;
    nucleus?: OpportunityNucleus;
    ownerUserId?: number;
    unassigned?: boolean;
    search?: string;
    includeClosed?: boolean;
    grupo?: string;
    cursoId?: number;
    eventoId?: number;
  } = {};
  if (query.stage) assertEnum(query.stage, OPPORTUNITY_STAGES, "stage");
  if (query.nucleus) assertEnum(query.nucleus, OPPORTUNITY_NUCLEI, "nucleus");
  if (query.stage) filters.stage = query.stage as OpportunityStage;
  if (query.nucleus) filters.nucleus = query.nucleus as OpportunityNucleus;
  if (query.ownerUserId) filters.ownerUserId = bodyNumber(query.ownerUserId);
  filters.unassigned = query.unassigned === "true";
  filters.search = query.search;
  filters.includeClosed = query.includeClosed === "true";
  if (query.grupo?.trim()) filters.grupo = query.grupo.trim();
  if (query.cursoId) filters.cursoId = bodyNumber(query.cursoId);
  if (query.eventoId) filters.eventoId = bodyNumber(query.eventoId);
  const rows = await listOpportunities(filters);
  // This endpoint is intentionally an operational projection: only the
  // minimal display identity is joined; CPF and health/profile fields remain
  // unavailable to the board.
  res.json(rows);
}));

router.get("/crm/opportunities/owners", requireAuth, requireCrmStaff, runRoute(async (_req, res) => {
  const users = await db.select({
    id: usersTable.id,
    name: usersTable.name,
    email: usersTable.email,
    role: usersTable.role,
    profileId: usersTable.profileId,
  }).from(usersTable).where(eq(usersTable.active, true)).orderBy(usersTable.name);
  const profiles = await loadProfileSummaries();
  res.json(users.map(user => ({
    id: user.id,
    name: user.name,
    email: user.email,
    profileName: summarizeUserProfile(user, profiles).profileName,
  })));
}));

router.post("/crm/opportunities", requireAuth, requireCrmStaff, runRoute(async (req, res) => {
  const parsed = CreateCommercialOpportunityBody.safeParse(req.body);
  if (!parsed.success) throw new OpportunityRuleError(parsed.error.message);
  const body = parsed.data;
  assertEnum(body.nucleus, OPPORTUNITY_NUCLEI, "nucleus");
  assertEnum(body.nextTaskType, OPPORTUNITY_TASK_TYPES, "nextTaskType");
  if (body.nextTaskType === "NONE") throw new OpportunityRuleError("A next action type is required.", "NEXT_ACTION_REQUIRED");
  const user = (req as AuthedRequest).authedUser!;
  const row = await createOpportunity({
    pessoaId: bodyNumber(body.pessoaId) ?? 0,
    nucleus: body.nucleus,
    cursosInscricaoId: bodyNumber(body.cursosInscricaoId) ?? null,
    offerLabel: bodyString(body.offerLabel),
    ownerUserId: body.ownerUserId === undefined ? user.id : bodyNumber(body.ownerUserId) ?? null,
    nextTaskType: body.nextTaskType,
    nextTaskText: bodyString(body.nextTaskText) ?? "",
    nextTaskAt: parseOpportunityDate(body.nextTaskAt, "nextTaskAt"),
    source: bodyString(body.source),
    idempotencyKey: bodyString(body.idempotencyKey),
    actor: actor(req as AuthedRequest),
  });
  res.status(201).json(row);
}));

router.get("/crm/opportunities/:id", requireAuth, requireCrmStaff, runRoute(async (req, res) => {
  const detail = await getOpportunityDetail(idOf(req.params.id));
  if (!detail) {
    res.status(404).json({ code: "NOT_FOUND", error: "Opportunity not found." });
    return;
  }
  res.json(detail);
}));

router.get("/crm/opportunities/:id/history", requireAuth, requireCrmStaff, runRoute(async (req, res) => {
  const detail = await getOpportunityDetail(idOf(req.params.id));
  if (!detail) {
    res.status(404).json({ code: "NOT_FOUND", error: "Opportunity not found." });
    return;
  }
  res.json(detail.events);
}));

router.patch("/crm/opportunities/:id", requireAuth, requireCrmStaff, runRoute(async (req, res) => {
  const parsed = UpdateCommercialOpportunityBody.safeParse(req.body);
  if (!parsed.success) throw new OpportunityRuleError(parsed.error.message);
  const body = parsed.data;
  const taskType = body.nextTaskType;
  if (taskType !== undefined) assertEnum(taskType, OPPORTUNITY_TASK_TYPES, "nextTaskType");
  if (body.contactStatus !== undefined) assertEnum(body.contactStatus, CONTACT_STATUSES, "contactStatus");
  if (body.offerInterestStatus !== undefined) assertEnum(body.offerInterestStatus, OFFER_INTEREST_STATUSES, "offerInterestStatus");
  const row = await updateOpportunity({
    opportunityId: idOf(req.params.id),
    actor: actor(req as AuthedRequest),
    ownerUserId: body.ownerUserId === undefined ? undefined : bodyNumber(body.ownerUserId) ?? null,
    contactStatus: body.contactStatus as Parameters<typeof updateOpportunity>[0]["contactStatus"],
    nextTaskType: taskType as OpportunityTaskType | null | undefined,
    nextTaskText: body.nextTaskText === undefined ? undefined : bodyString(body.nextTaskText) ?? null,
    nextTaskAt: body.nextTaskAt === undefined ? undefined : parseOpportunityDate(body.nextTaskAt, "nextTaskAt"),
    offerInterestStatus: body.offerInterestStatus as Parameters<typeof updateOpportunity>[0]["offerInterestStatus"],
    expectedVersion: bodyNumber(body.expectedVersion),
    source: bodyString(body.source),
    idempotencyKey: bodyString(body.idempotencyKey),
  });
  res.json(row);
}));

router.post("/crm/opportunities/:id/claim", requireAuth, requireCrmStaff, runRoute(async (req, res) => {
  const row = await claimOpportunity({
    opportunityId: idOf(req.params.id),
    actor: actor(req),
  });
  res.json(row);
}));

router.post("/crm/opportunities/:id/complete-task", requireAuth, requireCrmStaff, runRoute(async (req, res) => {
  const parsed = CompleteCommercialOpportunityTaskBody.safeParse(req.body);
  if (!parsed.success) throw new OpportunityRuleError(parsed.error.message);
  const body = parsed.data;
  const row = await completeOpportunityTask({
    opportunityId: idOf(req.params.id),
    actor: actor(req as AuthedRequest),
    source: bodyString(body.source),
    idempotencyKey: bodyString(body.idempotencyKey),
    nextTaskType: body.nextTaskType,
    nextTaskText: body.nextTaskText,
    nextTaskAt: parseOpportunityDate(body.nextTaskAt, "nextTaskAt"),
    expectedVersion: bodyNumber(body.expectedVersion),
  });
  res.json(row);
}));

async function transitionRoute(
  req: AuthedRequest,
  res: Response,
  toStage: OpportunityStage,
): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const confirmation = parseConfirmationEvidence(body.confirmation);
  if (toStage === "CONFIRMED" && confirmation?.kind === "HUMAN_ADMIN") {
    if (req.authedUser?.isAdmin !== true) {
      throw new OpportunityRuleError(
        "Only administrators may explicitly confirm an opportunity.",
        "ADMIN_CONFIRMATION_REQUIRED",
        403,
      );
    }
  }
  const row = await transitionOpportunity({
    opportunityId: idOf(req.params.id),
    toStage,
    actor: actor(req),
    reason: bodyString(body.reason),
    source: bodyString(body.source),
    idempotencyKey: bodyString(body.idempotencyKey),
    expectedVersion: bodyNumber(body.expectedVersion),
    confirmation,
  });
  res.json(row);
}

router.post("/crm/opportunities/:id/transition", requireAuth, requireCrmStaff, runRoute(async (req, res) => {
  parseConfirmationEvidence((req.body as Record<string, unknown>)?.confirmation);
  const parsed = TransitionCommercialOpportunityBody.strict().safeParse(req.body);
  if (!parsed.success) throw new OpportunityRuleError(parsed.error.message);
  req.body = parsed.data;
  await transitionRoute(req as AuthedRequest, res, parsed.data.toStage);
}));

router.post("/crm/opportunities/:id/pause", requireAuth, requireCrmStaff, runRoute(async (req, res) => {
  await transitionRoute(req as AuthedRequest, res, "NURTURE");
}));

router.post("/crm/opportunities/:id/reactivate", requireAuth, requireCrmStaff, runRoute(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const toStage = body.toStage === undefined ? "CONTACT_STARTED" : body.toStage as OpportunityStage;
  assertEnum(toStage, OPPORTUNITY_STAGES, "toStage");
  assertReactivationTarget(toStage);
  await transitionRoute(req as AuthedRequest, res, toStage);
}));

router.get("/crm/opportunities/:id/confirmation-options", requireAuth, requireCrmStaff, runRoute(async (req, res) => {
  res.json(await getConfirmationEvidenceOptions(idOf(req.params.id), {
    includeHumanAdmin: req.authedUser?.isAdmin === true,
  }));
}));

router.post("/crm/opportunities/:id/close", requireAuth, requireCrmStaff, runRoute(async (req, res) => {
  await transitionRoute(req as AuthedRequest, res, "CLOSED");
}));

export default router;