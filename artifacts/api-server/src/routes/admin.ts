import { Router, type IRouter } from "express";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import {
  db,
  usersTable,
  coursesTable,
  classesTable,
  enrollmentsTable,
  knowledgeItemsTable,
  promptsTable,
  conversations,
  messages,
  servicosCatalogo,
  instrumentosCatalogo,
  accessProfilesTable,
} from "@workspace/db";
import { BulkDeleteUsersBody, CreateUserBody, UpdateUserBody } from "@workspace/api-zod";
import { requireAuth, requireAdminRole, type AuthedRequest } from "../middlewares/roleAuth";
import { createSessionToken } from "../lib/session";
import {
  ACCESS_MANAGEMENT_LOCK_ID,
  ManagerLossError,
  assertStillManaged,
  countActiveManagers,
  legacyRoleFor,
  loadProfileSummaries,
  summarizeUserProfile,
} from "../services/accessProfiles";

const router: IRouter = Router();

const BCRYPT_ROUNDS = 12;

const MOCK_CONNECTORS = [
  { id: "wix", name: "Wix eCommerce", description: "Sincronização de pedidos, produtos e clientes da loja Wix", status: "connected", lastSync: "2026-07-09T08:30:00Z" },
  { id: "omie", name: "OMIE ERP", description: "Integração real com as bases Education e Store — veja a página Omie ERP", status: "connected", lastSync: null },
  { id: "hotmart", name: "Hotmart", description: "Acesso a cursos online e gestão de alunos Hotmart", status: "connected", lastSync: "2026-07-08T22:00:00Z" },
  { id: "whatsapp", name: "WhatsApp Business", description: "Canal de atendimento da Sofia e notificações automáticas", status: "connected", lastSync: "2026-07-09T09:00:00Z" },
];

// Adicionar um middleware a uma rota faz o Express inferir req.params como
// string | string[]; os ids desta rota nunca usam params repetidos, então
// sempre pegamos o primeiro valor (mesmo padrão de pessoas.ts).
function paramId(raw: string | string[] | undefined): number {
  const s = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  return parseInt(s, 10);
}

type UserRow = typeof usersTable.$inferSelect;

function serializeUser(u: UserRow, profile: ReturnType<typeof summarizeUserProfile>) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    profileId: profile.profileId,
    profileName: profile.profileName,
    isAdmin: profile.isAdmin,
    active: u.active,
    passwordMustReset: u.passwordMustReset,
    lastLogin: u.lastLogin?.toISOString() ?? null,
  };
}

async function serializeUsers(users: UserRow[]) {
  const maps = await loadProfileSummaries();
  return users.map(user => serializeUser(user, summarizeUserProfile(user, maps)));
}

async function serializeOneUser(user: UserRow) {
  const [serialized] = await serializeUsers([user]);
  return serialized;
}

// ── POST /auth/login ────────────────────────────────────────────
router.post("/auth/login", async (req, res): Promise<void> => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email?.trim() || !password) {
    res.status(400).json({ error: "E-mail e senha obrigatórios." });
    return;
  }
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email.trim().toLowerCase()))
    .limit(1);
  if (!user || !user.active) {
    res.status(401).json({ error: "Credenciais inválidas." });
    return;
  }

  // Users whose password was stored in the old insecure format are forced to
  // reset via an admin-set new password before they can log in again.
  if (user.passwordMustReset || !user.passwordHash) {
    res.status(401).json({
      error: "Sua senha precisa ser redefinida. Solicite ao administrador que defina uma nova senha para você.",
      code: "PASSWORD_MUST_RESET",
    });
    return;
  }

  const passwordValid = await bcrypt.compare(password, user.passwordHash);
  if (!passwordValid) {
    res.status(401).json({ error: "Credenciais inválidas." });
    return;
  }

  await db.update(usersTable).set({ lastLogin: new Date() }).where(eq(usersTable.id, user.id));
  // Emite um token de sessão assinado (SESSION_SECRET) — o frontend passa a
  // enviá-lo como Authorization: Bearer <token> em vez de um x-user-id bruto,
  // que qualquer cliente poderia forjar para se passar por outro usuário.
  const sessionToken = createSessionToken(user.id);
  res.json({ ...(await serializeOneUser(user)), sessionToken });
});

// ── PATCH /auth/profile ──────────────────────────────────────────
router.patch("/auth/profile", requireAuth, async (req, res): Promise<void> => {
  const userId = (req as AuthedRequest).authedUser!.id;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "Usuário não encontrado." });
    return;
  }
  const { name, email, currentPassword, newPassword } = req.body as {
    name?: string; email?: string; currentPassword?: string; newPassword?: string;
  };
  if (newPassword) {
    if (!currentPassword) {
      res.status(403).json({ error: "Senha atual obrigatória para alterar a senha." });
      return;
    }
    if (!user.passwordHash || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      res.status(403).json({ error: "Senha atual incorreta." });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: "Nova senha deve ter ao menos 8 caracteres." });
      return;
    }
  }
  const updates: Record<string, unknown> = {};
  if (name?.trim()) updates.name = name.trim();
  if (email?.trim()) updates.email = email.trim().toLowerCase();
  if (newPassword) {
    updates.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    updates.passwordMustReset = false;
  }
  const [updated] = await db.update(usersTable).set(updates).where(eq(usersTable.id, userId)).returning();
  res.json(await serializeOneUser(updated));
});

router.get("/admin/users", requireAdminRole, async (_req, res): Promise<void> => {
  const users = await db.select().from(usersTable).where(eq(usersTable.active, true)).orderBy(usersTable.name);
  res.json(await serializeUsers(users));
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

router.post("/admin/users", requireAdminRole, async (req, res): Promise<void> => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const name = parsed.data.name.trim();
  const email = parsed.data.email.trim().toLowerCase();
  const password = parsed.data.password;

  if (name.length < 2) { res.status(400).json({ error: "Nome deve ter ao menos 2 caracteres." }); return; }
  if (!validateEmail(email)) { res.status(400).json({ error: "E-mail inválido." }); return; }
  if (password.length < 8) { res.status(400).json({ error: "Senha deve ter ao menos 8 caracteres." }); return; }

  const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email));
  if (existing.length > 0) { res.status(409).json({ error: "E-mail já cadastrado." }); return; }

  const [profile] = await db
    .select()
    .from(accessProfilesTable)
    .where(eq(accessProfilesTable.id, parsed.data.profileId))
    .limit(1);
  if (!profile) { res.status(400).json({ error: "Perfil de acesso inválido.", code: "INVALID_PROFILE" }); return; }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const [user] = await db.insert(usersTable).values({
    name,
    email,
    // `role` é só um espelho para auditoria; o acesso vem do perfil.
    role: legacyRoleFor(profile),
    profileId: profile.id,
    passwordHash,
    passwordMustReset: false,
    active: true,
  }).returning();

  res.status(201).json(await serializeOneUser(user));
});

router.post("/admin/users/bulk-delete", requireAdminRole, async (req, res): Promise<void> => {
  const parsed = BulkDeleteUsersBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const ids = parsed.data.ids;
  const currentUserId = (req as AuthedRequest).authedUser!.id;
  if (ids.includes(currentUserId)) {
    res.status(409).json({ error: "Você não pode excluir a própria conta." });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ACCESS_MANAGEMENT_LOCK_ID})`);
      const targets = await tx
        .select()
        .from(usersTable)
        .where(and(inArray(usersTable.id, ids), eq(usersTable.active, true)));

      if (targets.length !== ids.length) {
        return { error: "Um ou mais usuários não foram encontrados.", status: 404 } as const;
      }

      const managersBefore = await countActiveManagers(tx);
      const deactivated = await tx
        .update(usersTable)
        .set({ active: false })
        .where(and(inArray(usersTable.id, ids), eq(usersTable.active, true)))
        .returning();
      await assertStillManaged(tx, managersBefore, "Não é possível excluir todos os administradores ativos.");
      return { users: deactivated } as const;
    });

    if ("error" in result) { res.status(result.status ?? 500).json({ error: result.error }); return; }
    res.json(await serializeUsers(result.users));
  } catch (err) {
    if (err instanceof ManagerLossError) { res.status(409).json({ error: err.message, code: "LAST_MANAGER" }); return; }
    throw err;
  }
});

router.put("/admin/users/:id", requireAdminRole, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido." }); return; }

  const parsed = UpdateUserBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const updates: Partial<typeof usersTable.$inferInsert> = {};

  if (parsed.data.name !== undefined) {
    const name = parsed.data.name.trim();
    if (name.length < 2) { res.status(400).json({ error: "Nome deve ter ao menos 2 caracteres." }); return; }
    updates.name = name;
  }

  if (parsed.data.email !== undefined) {
    const email = parsed.data.email.trim().toLowerCase();
    if (!validateEmail(email)) { res.status(400).json({ error: "E-mail inválido." }); return; }
    const existing = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email));
    if (existing.length > 0 && existing[0].id !== id) { res.status(409).json({ error: "E-mail já em uso." }); return; }
    updates.email = email;
  }

  if (parsed.data.active === false) {
    res.status(400).json({ error: "Use a ação Excluir para remover o acesso de um usuário." });
    return;
  }
  if (parsed.data.active === true) updates.active = true;

  if (parsed.data.password !== undefined) {
    if (parsed.data.password.length < 8) { res.status(400).json({ error: "Senha deve ter ao menos 8 caracteres." }); return; }
    updates.passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_ROUNDS);
    // Admin setting a new password clears the forced-reset flag.
    updates.passwordMustReset = false;
  }

  const newProfileId = parsed.data.profileId;

  if (Object.keys(updates).length === 0 && newProfileId === undefined) {
    res.status(400).json({ error: "Nenhum campo para atualizar." });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ACCESS_MANAGEMENT_LOCK_ID})`);
      const [current] = await tx.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
      if (!current) return { error: "Usuário não encontrado.", status: 404 } as const;

      const changes: Partial<typeof usersTable.$inferInsert> = { ...updates };
      let profileChanged = false;
      if (newProfileId !== undefined) {
        const [profile] = await tx
          .select()
          .from(accessProfilesTable)
          .where(eq(accessProfilesTable.id, newProfileId))
          .limit(1);
        if (!profile) return { error: "Perfil de acesso inválido.", status: 400, code: "INVALID_PROFILE" } as const;
        changes.profileId = profile.id;
        // `role` é só um espelho para auditoria; o acesso vem do perfil.
        changes.role = legacyRoleFor(profile);
        profileChanged = current.profileId !== profile.id;
      }

      const managersBefore = await countActiveManagers(tx);
      const [user] = await tx.update(usersTable).set(changes).where(eq(usersTable.id, id)).returning();
      if (profileChanged && current.active) {
        await assertStillManaged(tx, managersBefore, "Não é possível remover o perfil do último administrador ativo.");
      }
      return { user } as const;
    });

    if ("error" in result) {
      res.status(result.status ?? 500).json({ error: result.error, ..."code" in result ? { code: result.code } : {} });
      return;
    }
    if (!result.user) { res.status(404).json({ error: "Usuário não encontrado." }); return; }

    res.json(await serializeOneUser(result.user));
  } catch (err) {
    if (err instanceof ManagerLossError) { res.status(409).json({ error: err.message, code: "LAST_MANAGER" }); return; }
    throw err;
  }
});

router.delete("/admin/users/:id", requireAdminRole, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido." }); return; }

  const currentUserId = (req as AuthedRequest).authedUser!.id;
  if (id === currentUserId) {
    res.status(409).json({ error: "Você não pode excluir a própria conta." });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ACCESS_MANAGEMENT_LOCK_ID})`);
      const [target] = await tx.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
      if (!target || !target.active) return { error: "Usuário não encontrado.", status: 404 } as const;

      const managersBefore = await countActiveManagers(tx);
      const [user] = await tx.update(usersTable)
        .set({ active: false })
        .where(and(eq(usersTable.id, id), eq(usersTable.active, true)))
        .returning();
      if (!user) return { error: "Usuário não encontrado.", status: 404 } as const;

      await assertStillManaged(tx, managersBefore, "Não é possível excluir o último administrador ativo.");
      return { user } as const;
    });

    if ("error" in result) { res.status(result.status ?? 500).json({ error: result.error }); return; }
    res.json(await serializeOneUser(result.user));
  } catch (err) {
    if (err instanceof ManagerLossError) { res.status(409).json({ error: err.message, code: "LAST_MANAGER" }); return; }
    throw err;
  }
});

router.get("/admin/connectors", requireAuth, async (_req, res): Promise<void> => {
  res.json(MOCK_CONNECTORS);
});

// ── Catálogo: Serviços ─────────────────────────────────────────
router.get("/admin/catalogos/servicos", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(servicosCatalogo).orderBy(servicosCatalogo.nome);
  res.json(rows);
});

router.post("/admin/catalogos/servicos", requireAuth, async (req, res): Promise<void> => {
  const { nome, descricao } = req.body as { nome?: string; descricao?: string };
  if (!nome?.trim()) { res.status(400).json({ error: "nome é obrigatório" }); return; }
  const [row] = await db.insert(servicosCatalogo).values({ nome: nome.trim(), descricao: descricao?.trim() || null }).returning();
  res.status(201).json(row);
});

router.patch("/admin/catalogos/servicos/:id", requireAuth, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const { nome, descricao, ativo } = req.body as { nome?: string; descricao?: string; ativo?: boolean };
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (nome !== undefined) update.nome = nome.trim();
  if (descricao !== undefined) update.descricao = descricao?.trim() || null;
  if (ativo !== undefined) update.ativo = ativo;
  const [row] = await db.update(servicosCatalogo).set(update).where(eq(servicosCatalogo.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Não encontrado" }); return; }
  res.json(row);
});

router.delete("/admin/catalogos/servicos/:id", requireAdminRole, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(servicosCatalogo).where(eq(servicosCatalogo.id, id));
  res.status(204).send();
});

// ── Catálogo: Instrumentos ─────────────────────────────────────
router.get("/admin/catalogos/instrumentos", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(instrumentosCatalogo).orderBy(instrumentosCatalogo.nome);
  res.json(rows);
});

router.post("/admin/catalogos/instrumentos", requireAuth, async (req, res): Promise<void> => {
  const { nome, descricao } = req.body as { nome?: string; descricao?: string };
  if (!nome?.trim()) { res.status(400).json({ error: "nome é obrigatório" }); return; }
  const [row] = await db.insert(instrumentosCatalogo).values({ nome: nome.trim(), descricao: descricao?.trim() || null }).returning();
  res.status(201).json(row);
});

router.patch("/admin/catalogos/instrumentos/:id", requireAuth, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  const { nome, descricao, ativo } = req.body as { nome?: string; descricao?: string; ativo?: boolean };
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (nome !== undefined) update.nome = nome.trim();
  if (descricao !== undefined) update.descricao = descricao?.trim() || null;
  if (ativo !== undefined) update.ativo = ativo;
  const [row] = await db.update(instrumentosCatalogo).set(update).where(eq(instrumentosCatalogo.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Não encontrado" }); return; }
  res.json(row);
});

router.delete("/admin/catalogos/instrumentos/:id", requireAdminRole, async (req, res): Promise<void> => {
  const id = paramId(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "ID inválido" }); return; }
  await db.delete(instrumentosCatalogo).where(eq(instrumentosCatalogo.id, id));
  res.status(204).send();
});

const TABLE_MAP: Record<string, unknown> = {
  access_profiles: accessProfilesTable,
  users: usersTable,
  courses: coursesTable,
  classes: classesTable,
  enrollments: enrollmentsTable,
  knowledge_items: knowledgeItemsTable,
  prompts: promptsTable,
  conversations,
  messages,
};

const VALID_TABLES = Object.keys(TABLE_MAP);

const RESTORE_ORDER = [
  "access_profiles",
  "users",
  "courses",
  "knowledge_items",
  "prompts",
  "classes",
  "enrollments",
  "conversations",
  "messages",
];

type RestoreTableResult = { table: string; rows: number; status: "ok" | "error"; error?: string; code?: string };

const ACCESS_MANAGEMENT_TABLES = new Set(["access_profiles", "users"]);
const RESTORE_LAST_MANAGER_MESSAGE =
  "A restauração deixaria a plataforma sem nenhum usuário ativo que possa gerenciar perfis e usuários. Nada foi alterado em perfis e usuários.";

/**
 * Restaura uma tabela (insere ou atualiza pelo id). Cada tabela roda num ponto
 * de salvamento próprio: se uma falhar, as outras da mesma transação continuam.
 */
async function restoreOneTable(
  executor: Pick<typeof db, "transaction">,
  tableName: string,
  rows: Record<string, unknown>[],
): Promise<RestoreTableResult> {
  if (rows.length === 0) return { table: tableName, rows: 0, status: "ok" };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const table = TABLE_MAP[tableName] as any;
    const cols = getTableColumns(table);

    // Columns excluded from the ON CONFLICT … DO UPDATE set vary by table:
    // - always skip "id" (it's the conflict target)
    // - for users: skip passwordHash (backups intentionally omit it, so the
    //   excluded.* value would be NULL and wipe existing bcrypt hashes) and
    //   passwordMustReset (we set it deliberately on insert, see below)
    const skipOnConflict = new Set<string>(["id"]);
    if (tableName === "users") {
      skipOnConflict.add("passwordHash");
      skipOnConflict.add("passwordMustReset");
      // Backups antigos não trazem o perfil: restaurar não deve apagar o perfil atual dos usuários.
      if (!rows.some(row => "profileId" in row)) skipOnConflict.add("profileId");
    }

    const updateSet: Record<string, unknown> = {};
    for (const [jsKey, col] of Object.entries(cols)) {
      if (!skipOnConflict.has(jsKey)) {
        updateSet[jsKey] = sql.raw(`excluded."${(col as { name: string }).name}"`);
      }
    }

    // For users restored without a password hash, mark them for forced reset
    // so they cannot log in until an admin sets a new password.
    const insertValues = tableName === "users"
      ? rows.map(r => ({ ...r, passwordMustReset: true }))
      : rows;

    await executor.transaction(async (savepoint) => {
      await savepoint
        .insert(table)
        .values(insertValues)
        .onConflictDoUpdate({ target: table.id, set: updateSet });
    });

    return { table: tableName, rows: rows.length, status: "ok" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { table: tableName, rows: 0, status: "error", error: message };
  }
}

// Protegido pela mesma sessão de admin de todas as outras rotas /admin — não
// mais por uma chave ADMIN_SECRET à parte. Continua exigindo papel de
// administrador: a exportação inclui users/conversations/messages.
router.get("/admin/backup", requireAdminRole, async (req, res): Promise<void> => {
  const actor = (req as AuthedRequest).authedUser!;
  const tablesParam = typeof req.query.tables === "string" ? req.query.tables : "all";
  const requested = tablesParam === "all"
    ? VALID_TABLES
    : tablesParam.split(",").map(t => t.trim()).filter(t => VALID_TABLES.includes(t));

  if (requested.length === 0) {
    res.status(400).json({ error: "Nenhuma tabela válida selecionada." });
    return;
  }

  const backup: Record<string, unknown> = {
    _meta: {
      timestamp: new Date().toISOString(),
      version: "1.0",
      tables: requested,
    },
  };

  const rowCounts: Record<string, number> = {};

  for (const tableName of requested) {
    const table = TABLE_MAP[tableName];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await db.select().from(table as any);
    rowCounts[tableName] = rows.length;

    // Strip password_hash from user rows so a backup file never contains
    // password material — even bcrypt hashes should not circulate in files
    // sent by email, stored on drives, or shared via messaging apps.
    if (tableName === "users") {
      backup[tableName] = rows.map((r: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { passwordHash: _ph, ...rest } = r as typeof usersTable.$inferSelect;
        return rest;
      });
    } else {
      backup[tableName] = rows;
    }
  }

  const filename = `soundos-backup-${new Date().toISOString().slice(0, 16).replace(":", "-")}.json`;

  // Audit log: who exported, when, what tables, how many rows each
  console.log(
    `[AUDIT] BACKUP_EXPORT user_id=${actor.id} email=${actor.email} ` +
    `tables=${requested.join(",")} rows=${JSON.stringify(rowCounts)} ` +
    `file=${filename} at=${new Date().toISOString()}`
  );

  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/json");
  res.json(backup);
});

// Idem — e aqui o risco é maior, porque a restauração sobrescreve dados.
router.post("/admin/restore", requireAdminRole, async (req, res): Promise<void> => {
  const actor = (req as AuthedRequest).authedUser!;
  const body = req.body as Record<string, unknown>;

  const meta = body._meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== "object" || meta.version !== "1.0") {
    res.status(400).json({ error: "Formato de backup inválido. O arquivo deve ter sido gerado por esta aplicação." });
    return;
  }

  const tablesToRestore = RESTORE_ORDER.filter(t => t in body && Array.isArray(body[t]));
  if (tablesToRestore.length === 0) {
    res.status(400).json({ error: "Nenhuma tabela válida encontrada no arquivo de backup." });
    return;
  }

  const results: RestoreTableResult[] = [];

  // Perfis e usuários mudam quem consegue gerenciar o acesso: são restaurados
  // juntos, numa transação sob a mesma trava das telas de Usuários e Perfis, e
  // desfeitos se a plataforma ficasse sem nenhum gestor ativo. As demais tabelas
  // seguem independentes, como sempre.
  const managementTables = tablesToRestore.filter(name => ACCESS_MANAGEMENT_TABLES.has(name));
  if (managementTables.length > 0) {
    try {
      const restored = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${ACCESS_MANAGEMENT_LOCK_ID})`);
        const managersBefore = await countActiveManagers(tx);
        const inTransaction: RestoreTableResult[] = [];
        for (const tableName of managementTables) {
          inTransaction.push(await restoreOneTable(tx, tableName, body[tableName] as Record<string, unknown>[]));
        }
        await assertStillManaged(tx, managersBefore, RESTORE_LAST_MANAGER_MESSAGE);
        return inTransaction;
      });
      results.push(...restored);
    } catch (err) {
      if (!(err instanceof ManagerLossError)) throw err;
      for (const tableName of managementTables) {
        results.push({ table: tableName, rows: 0, status: "error", error: err.message, code: "LAST_MANAGER" });
      }
    }
  }

  for (const tableName of tablesToRestore) {
    if (ACCESS_MANAGEMENT_TABLES.has(tableName)) continue;
    results.push(await restoreOneTable(db, tableName, body[tableName] as Record<string, unknown>[]));
  }
  results.sort((left, right) => tablesToRestore.indexOf(left.table) - tablesToRestore.indexOf(right.table));

  // Audit log: who restored, when, which tables were affected and outcome
  const auditSummary = results.map(r => `${r.table}:${r.status}(${r.rows})`).join(",");
  console.log(
    `[AUDIT] BACKUP_RESTORE user_id=${actor.id} email=${actor.email} ` +
    `tables=${tablesToRestore.join(",")} results=${auditSummary} ` +
    `at=${new Date().toISOString()}`
  );

  res.json({ results });
});

export default router;
