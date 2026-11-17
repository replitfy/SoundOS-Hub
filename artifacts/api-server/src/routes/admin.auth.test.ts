/**
 * Testes de integração (nível de rota) para o fluxo de autenticação após
 * redefinição de senha pelo administrador.
 *
 * Cenários cobertos:
 * 1. Usuário com password_must_reset=true NÃO consegue logar.
 * 2. Admin redefine senha via PUT /admin/users/:id:
 *    - O payload gravado no banco tem passwordMustReset=false e um hash bcrypt válido.
 *    - O usuário consegue logar com esse hash real (não um hash pré-fabricado).
 * 3. Usuário criado via POST /admin/users:
 *    - O payload inserido tem passwordMustReset=false e um hash bcrypt válido.
 *    - O login funciona com esse mesmo hash.
 * 4. Usuário ativo sem hash não consegue logar.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// SESSION_SECRET precisa estar definida ANTES de importar qualquer módulo que
// use ../lib/session, porque getSecret() lança se a variável não existir.
process.env["SESSION_SECRET"] = "test-secret-that-is-long-enough-for-hmac";

// ── Mocks declarados ANTES dos imports do módulo testado ────────────────────

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback((await import("@workspace/db")).db)),
  },
  usersTable: {
    id: "id",
    email: "email",
    name: "name",
    role: "role",
    profileId: "profile_id",
    passwordHash: "password_hash",
    passwordMustReset: "password_must_reset",
    active: "active",
    lastLogin: "last_login",
  },
  accessProfilesTable: { id: "id", systemKey: "system_key" },
  // Tabelas referenciadas pela rota mas não usadas nos testes deste arquivo:
  coursesTable: {},
  classesTable: {},
  enrollmentsTable: {},
  knowledgeItemsTable: {},
  promptsTable: {},
  conversations: {},
  messages: {},
  servicosCatalogo: { nome: "nome" },
  instrumentosCatalogo: { nome: "nome" },
  eq: vi.fn(),
  getTableColumns: vi.fn(() => ({})),
  sql: { raw: vi.fn() },
}));

// Os perfis vêm do banco; aqui usamos os 4 perfis do sistema como o servidor os grava.
vi.mock("../services/accessProfiles", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/accessProfiles")>();
  const { profileMaps } = await import("./testing/accessProfileFixtures");
  return {
    ...actual,
    loadProfileSummaries: vi.fn(async () => profileMaps()),
    countActiveManagers: vi.fn(async () => 2),
    assertStillManaged: vi.fn(async () => undefined),
  };
});

// O middleware de auth é mockado para injetar um admin sem tocar no banco.
vi.mock("../middlewares/roleAuth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireAdminRole: (req: any, _res: any, next: any) => {
    req.authedUser = {
      id: 1,
      role: "admin_master",
      name: "Admin Test",
      email: "admin@example.com",
    };
    next();
  },
}));

// ── Imports (após os mocks) ──────────────────────────────────────────────────

import express from "express";
import request from "supertest";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import adminRouter from "./admin";
import { profileIdFor, SYSTEM_PROFILE_ROWS } from "./testing/accessProfileFixtures";

// ── App de teste ─────────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/", adminRouter);
  return app;
}

const app = createApp();

type DbMock = {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
};

const dbMock = db as unknown as DbMock;

// ── Helpers para montar as cadeias de mock do Drizzle ───────────────────────

/**
 * Configura db.select:
 * - .where() pode ser awaited diretamente → `directResult` (checagem de e-mail único)
 * - .where().limit() → `limitResult` (busca de usuário pelo e-mail)
 */
function setupSelectChain(opts: { directResult?: unknown[]; limitResult?: unknown[] } = {}) {
  const limitFn = vi.fn().mockResolvedValue(opts.limitResult ?? []);
  const whereFn = vi.fn().mockReturnValue(
    Object.assign(Promise.resolve(opts.directResult ?? []), { limit: limitFn }),
  );
  const fromFn = vi.fn().mockReturnValue({ where: whereFn, orderBy: vi.fn().mockResolvedValue([]) });
  dbMock.select.mockReturnValue({ from: fromFn });
}

/**
 * Configura db.update e retorna uma referência ao spy de `set()` para que o
 * teste possa inspecionar o payload real gravado pela rota.
 *
 * A cadeia: update(table).set(payload).where(cond) → pode ser awaited (lastLogin)
 *            update(table).set(payload).where(cond).returning() → retorna usuário atualizado
 */
function setupUpdateChain(returningResult: unknown[]): ReturnType<typeof vi.fn> {
  const returningFn = vi.fn().mockResolvedValue(returningResult);
  const whereFn = vi.fn().mockReturnValue(
    Object.assign(Promise.resolve(undefined), { returning: returningFn }),
  );
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  dbMock.update.mockReturnValue({ set: setFn });
  return setFn;
}

/**
 * Configura db.insert e retorna uma referência ao spy de `values()` para que
 * o teste possa inspecionar o payload real inserido pela rota.
 */
function setupInsertChain(returningResult: unknown[]): ReturnType<typeof vi.fn> {
  const returningFn = vi.fn().mockResolvedValue(returningResult);
  const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
  dbMock.insert.mockReturnValue({ values: valuesFn });
  return valuesFn;
}

// ── Testes ───────────────────────────────────────────────────────────────────

describe("Fluxo de autenticação — redefinição de senha pelo admin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Cenário 1 ─────────────────────────────────────────────────────────────

  it("usuário com password_must_reset=true NÃO consegue logar", async () => {
    const lockedUser = {
      id: 42,
      name: "Maria",
      email: "maria@example.com",
      role: "usuario",
      active: true,
      passwordHash: null,
      passwordMustReset: true,
      lastLogin: null,
    };

    setupSelectChain({ limitResult: [lockedUser] });

    const res = await request(app)
      .post("/auth/login")
      .send({ email: "maria@example.com", password: "qualquercoisa" });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("PASSWORD_MUST_RESET");
  });

  // ── Cenário 2+3 ───────────────────────────────────────────────────────────

  it("PUT /admin/users/:id grava um hash bcrypt válido e passwordMustReset=false; login funciona com esse hash", async () => {
    const NOVA_SENHA = "NovaSenha@2026";

    // ── Passo A: admin chama PUT /admin/users/42 ────────────────────────────
    // Devolvemos um usuário placeholder em .returning() — o que a rota serializa
    // de volta ao cliente. O que importa é o que foi passado a set().
    const placeholderUser = {
      id: 42,
      name: "Maria",
      email: "maria@example.com",
      role: "usuario",
      active: true,
      passwordHash: "will-be-replaced-by-assertion",
      passwordMustReset: false,
      lastLogin: null,
    };

    const setSpy = setupUpdateChain([placeholderUser]);

    const putRes = await request(app)
      .put("/admin/users/42")
      .send({ password: NOVA_SENHA });

    expect(putRes.status).toBe(200);

    // ── Verificar o payload real que a rota gravaria no banco ───────────────
    expect(setSpy).toHaveBeenCalledOnce();
    const savedPayload = setSpy.mock.calls[0]![0] as Record<string, unknown>;

    // A rota deve ter limpo o flag de redefinição obrigatória.
    expect(savedPayload["passwordMustReset"]).toBe(false);

    // O hash deve ser uma string bcrypt válida (começa com $2b$).
    const savedHash = savedPayload["passwordHash"];
    expect(typeof savedHash).toBe("string");
    expect((savedHash as string).startsWith("$2")).toBe(true);

    // O hash gerado deve corresponder à senha enviada.
    const hashIsValid = await bcrypt.compare(NOVA_SENHA, savedHash as string);
    expect(hashIsValid).toBe(true);

    // ── Passo B: login com o hash REAL que a rota computou ──────────────────
    // Usamos o hash capturado — se a rota tivesse falhado em hashear, o login falharia.
    const userAfterReset = {
      id: 42,
      name: "Maria",
      email: "maria@example.com",
      role: "usuario",
      active: true,
      passwordHash: savedHash as string,
      passwordMustReset: false,
      lastLogin: null,
    };

    setupSelectChain({ limitResult: [userAfterReset] });
    setupUpdateChain([]); // lastLogin update

    const loginRes = await request(app)
      .post("/auth/login")
      .send({ email: "maria@example.com", password: NOVA_SENHA });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.passwordMustReset).toBe(false);
    expect(typeof loginRes.body.sessionToken).toBe("string");
    expect(loginRes.body.sessionToken.length).toBeGreaterThan(0);
  });

  // ── Cenário 4 ─────────────────────────────────────────────────────────────

  it("POST /admin/users insere um hash bcrypt válido e passwordMustReset=false; login funciona com esse hash", async () => {
    const SENHA_NOVA = "SenhaForte#123";

    // db.select → sem resultado para a checagem de e-mail único (e-mail livre)
    setupSelectChain({ directResult: [] });

    // Placeholder retornado em .returning() — o importante é capturar values()
    const assistenteProfile = SYSTEM_PROFILE_ROWS.find(row => row.systemKey === "assistente")!;
    // A rota confere se o perfil escolhido existe antes de inserir.
    setupSelectChain({ directResult: [], limitResult: [assistenteProfile] });

    const placeholderInserted = {
      id: 99,
      name: "Carlos",
      email: "carlos@example.com",
      role: "assistente",
      profileId: profileIdFor("assistente"),
      active: true,
      passwordHash: "placeholder",
      passwordMustReset: false,
      lastLogin: null,
    };

    const valuesSpy = setupInsertChain([placeholderInserted]);

    const postRes = await request(app)
      .post("/admin/users")
      .send({ name: "Carlos", email: "carlos@example.com", password: SENHA_NOVA, profileId: profileIdFor("assistente") });

    expect(postRes.status).toBe(201);

    // ── Verificar o payload real inserido pela rota ─────────────────────────
    expect(valuesSpy).toHaveBeenCalledOnce();
    const insertedPayload = valuesSpy.mock.calls[0]![0] as Record<string, unknown>;

    // O perfil escolhido é o que vale; o papel antigo é só espelho para auditoria.
    expect(insertedPayload["profileId"]).toBe(profileIdFor("assistente"));
    expect(insertedPayload["role"]).toBe("assistente");

    // Nunca deve marcar um usuário recém-criado como "deve resetar".
    expect(insertedPayload["passwordMustReset"]).toBe(false);

    const insertedHash = insertedPayload["passwordHash"];
    expect(typeof insertedHash).toBe("string");
    expect((insertedHash as string).startsWith("$2")).toBe(true);

    // O hash deve corresponder à senha enviada.
    const hashIsValid = await bcrypt.compare(SENHA_NOVA, insertedHash as string);
    expect(hashIsValid).toBe(true);

    // ── Login com o hash REAL inserido pela rota ────────────────────────────
    const createdUser = {
      id: 99,
      name: "Carlos",
      email: "carlos@example.com",
      role: "assistente",
      active: true,
      passwordHash: insertedHash as string,
      passwordMustReset: false,
      lastLogin: null,
    };

    setupSelectChain({ limitResult: [createdUser] });
    setupUpdateChain([]); // lastLogin update

    const loginRes = await request(app)
      .post("/auth/login")
      .send({ email: "carlos@example.com", password: SENHA_NOVA });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.passwordMustReset).toBe(false);
    expect(typeof loginRes.body.sessionToken).toBe("string");
  });

  // ── Invariante de segurança ────────────────────────────────────────────────

  it("usuário ativo com passwordMustReset=false mas sem hash não consegue logar", async () => {
    const userWithoutHash = {
      id: 77,
      name: "Joao",
      email: "joao@example.com",
      role: "usuario",
      active: true,
      passwordHash: null,
      passwordMustReset: false,
      lastLogin: null,
    };

    setupSelectChain({ limitResult: [userWithoutHash] });

    const res = await request(app)
      .post("/auth/login")
      .send({ email: "joao@example.com", password: "qualquer" });

    // O login verifica `!user.passwordHash` antes de bcrypt.compare.
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("PASSWORD_MUST_RESET");
  });
});
