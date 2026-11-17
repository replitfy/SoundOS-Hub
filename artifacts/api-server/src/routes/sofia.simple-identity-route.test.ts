// Modo simples: identificação antes do LLM, CONTEXTO do Prompt 2 e
// atualizar_ficha em silêncio (aplica, conflito sem sobrescrever, rejeita
// CPF/saúde/null, nada grava em conversa anônima). Critérios 11–14 e 16.
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";

process.env.NODE_ENV = "test";
process.env.SOFIA_MODE = "simple";

const modelMocks = vi.hoisted(() => ({ chatCreate: vi.fn(), responsesCreate: vi.fn() }));
const catalogMock = vi.hoisted(() => ({ getOfficialEventCatalog: vi.fn() }));

vi.mock("../middlewares/roleAuth", () => ({
  requireAuth: (req: { authedUser?: unknown }, _res: unknown, next: () => void) => {
    req.authedUser = { id: "staff-test", name: "Equipe Teste", role: "admin" };
    next();
  },
  requireAdminRole: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: modelMocks.chatCreate } },
    responses: { create: modelMocks.responsesCreate },
  },
}));

vi.mock("../services/sofiaEventCatalog", async importOriginal => ({
  ...(await importOriginal<typeof import("../services/sofiaEventCatalog")>()),
  getOfficialEventCatalog: catalogMock.getOfficialEventCatalog,
}));

const { db, conversations, decisionRuns, messages, pessoaEvidencias, pessoasTable } = await import("@workspace/db");
const { default: sofiaRouter } = await import("./sofia");
const { installScript, parseSse, systemPromptOf } = await import("./testing/sofiaScriptedModel");

const app = express();
app.use(express.json());
app.use("/api", sofiaRouter);

const marker = randomUUID().slice(0, 8);
const URL_AGUA = "https://www.soundfulness.online/event-details/ciclo-agua-id";
const telefones: string[] = [];
const conversationIds: number[] = [];
const personIds: number[] = [];

function novoCelular(): string {
  const numero = String(randomInt(10_000_000, 99_999_999));
  const celular = `(11) 9${numero.slice(0, 4)}-${numero.slice(4)}`;
  telefones.push(celular);
  return celular;
}

async function inserirPessoa(nome: string, celular: string, extra: Record<string, unknown> = {}): Promise<number> {
  const [p] = await db.insert(pessoasTable).values({ codigo: `SIMPLES-${marker}-${personIds.length}`, nome, celular, ...extra })
    .returning({ id: pessoasTable.id });
  personIds.push(p!.id);
  return p!.id;
}

async function chat(body: Record<string, unknown>) {
  const res = await request(app).post("/api/sofia/chat").send(body);
  const parsed = parseSse(res.text);
  if (parsed.done?.conversationId && !body.conversationId) conversationIds.push(parsed.done.conversationId);
  return parsed;
}

async function pessoaDaConversa(id: number): Promise<number | null> {
  const [c] = await db.select({ pessoaId: conversations.pessoaId }).from(conversations).where(eq(conversations.id, id));
  return c?.pessoaId ?? null;
}

function toolOutputs(params: Record<string, unknown>): string[] {
  const input = (params.input ?? params.messages) as Array<{ type?: string; role?: string; output?: string; content?: string }>;
  return input.filter(i => i.type === "function_call_output" || i.role === "tool").map(i => i.output ?? i.content ?? "");
}

describe("Sofia modo simples — identificação e ficha", () => {
  beforeEach(() => {
    catalogMock.getOfficialEventCatalog.mockResolvedValue({
      source: { tables: ["cursos_inscricao", "classes", "courses"], fetchedAt: new Date().toISOString(), policy: "public_event_agenda" },
      items: [{
        eventId: 902, slug: "ciclo-agua", name: "CICLO ÁGUA - Sound Healing Individual", description: "Primeiro ciclo.",
        startDate: "2027-03-15", endDate: null, location: "São Paulo", nucleus: "education", eventType: "CURSO",
        classId: null, courseId: null, modality: null, workload: null, price: 2800, sourceUrl: URL_AGUA,
      }],
    });
  });

  afterAll(async () => {
    // Deixa terminar a auditoria em background antes de limpar.
    await new Promise(resolve => setTimeout(resolve, 500));
    const criadas = telefones.length > 0
      ? await db.select({ id: pessoasTable.id }).from(pessoasTable).where(inArray(pessoasTable.celular, telefones))
      : [];
    const ids = [...new Set([...personIds, ...criadas.map(p => p.id)])];
    if (conversationIds.length > 0) {
      await db.delete(decisionRuns).where(inArray(decisionRuns.conversationId, conversationIds));
      await db.delete(conversations).where(inArray(conversations.id, conversationIds));
    }
    if (ids.length > 0) {
      await db.delete(decisionRuns).where(inArray(decisionRuns.pessoaId, ids));
      await db.delete(conversations).where(inArray(conversations.pessoaId, ids));
      await db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL app.allow_evidencia_cascade_delete = 'on'`);
        await tx.delete(pessoasTable).where(inArray(pessoasTable.id, ids));
      });
    }
  });

  it("nome + celular novos criam a ficha e o CONTEXTO diz 'ficha: nova'", async () => {
    const celular = novoCelular();
    const script = installScript(modelMocks, [{ text: "Oi, Ana! Como posso ajudar?" }]);
    const { done } = await chat({ message: "Oi", pessoaNome: `Ana Teste${marker}`, pessoaCelular: celular });
    const pessoaId = await pessoaDaConversa(done!.conversationId!);
    expect(pessoaId).toBeTypeOf("number");
    const system = systemPromptOf(script.requests[0]);
    expect(system).toContain("ficha: nova");
    expect(system).toContain("nome: Ana");
  });

  it.each([
    ["sem nome", null],
    ["nome placeholder", "Nathalia"],
  ])("%s: não cria ficha e a conversa segue anônima", async (_caso, nome) => {
    const celular = novoCelular();
    const script = installScript(modelMocks, [{ text: "Oi! Como posso ajudar?" }]);
    const { done } = await chat({ message: "Oi", ...(nome ? { pessoaNome: nome } : {}), pessoaCelular: celular });
    expect(await pessoaDaConversa(done!.conversationId!)).toBeNull();
    expect(await db.select().from(pessoasTable).where(eq(pessoasTable.celular, celular))).toHaveLength(0);
    expect(systemPromptOf(script.requests[0])).toContain("ficha: nenhuma");
  });

  it("pessoa conhecida: CONTEXTO traz primeiro nome e assunto anterior; nome divergente fica anônimo sem vazar", async () => {
    const celular = novoCelular();
    const pessoaId = await inserirPessoa(`Bruna Teste${marker}`, celular, { cidade: `Campinas${marker}` });
    const [anterior] = await db.insert(conversations).values({ title: "anterior", pessoaId }).returning({ id: conversations.id });
    conversationIds.push(anterior!.id);
    await db.insert(messages).values([
      { conversationId: anterior!.id, role: "user", content: `Queria saber das datas do Ciclo Água ${marker}` },
      { conversationId: anterior!.id, role: "assistant", content: "A próxima turma é em março." },
    ]);

    const conhecida = installScript(modelMocks, [{ text: "Oi, Bruna! Que bom te ver de novo." }]);
    const primeira = await chat({ message: "Oi de novo", pessoaNome: `Bruna Teste${marker}`, pessoaCelular: celular });
    expect(await pessoaDaConversa(primeira.done!.conversationId!)).toBe(pessoaId);
    const system = systemPromptOf(conhecida.requests[0]);
    expect(system).toContain("ficha: conhecida");
    expect(system).toContain("nome: Bruna");
    expect(system).toContain(`Ciclo Água ${marker}`);
    expect(system).toContain(`cidade=Campinas${marker}`);

    const divergente = installScript(modelMocks, [{ text: "Oi! Como posso ajudar?" }]);
    const segunda = await chat({ message: "Oi", pessoaNome: "Carlos Diferente", pessoaCelular: celular });
    expect(await pessoaDaConversa(segunda.done!.conversationId!)).toBeNull();
    const systemAnonimo = systemPromptOf(divergente.requests[0]);
    expect(systemAnonimo).toContain("ficha: nenhuma");
    // Valores com marcador: o texto do prompt ativo pode citar "Campinas" como exemplo.
    expect(systemAnonimo).not.toContain("nome: Bruna");
    expect(systemAnonimo).not.toContain(`Campinas${marker}`);
    expect(systemAnonimo).not.toContain(marker);
  });

  it("celular compartilhado: duas fichas compatíveis → anônima; só uma compatível → reconhece essa", async () => {
    const celular = novoCelular();
    await inserirPessoa(`Diana Souza${marker}`, celular);
    await inserirPessoa(`Diana Souza${marker}`, celular);
    const script = installScript(modelMocks, [{ text: "Oi, Diana! Como posso ajudar?" }]);
    const { done } = await chat({ message: "Oi", pessoaNome: `Diana Souza${marker}`, pessoaCelular: celular });
    expect(await pessoaDaConversa(done!.conversationId!)).toBeNull();
    expect(systemPromptOf(script.requests[0])).toContain("ficha: nenhuma");

    const outro = novoCelular();
    const mae = await inserirPessoa(`Gilda Ramos${marker}`, outro);
    await inserirPessoa(`Heitor Ramos${marker}`, outro);
    installScript(modelMocks, [{ text: "Oi, Gilda!" }]);
    const reconhecida = await chat({ message: "Oi", pessoaNome: `Gilda Ramos${marker}`, pessoaCelular: outro });
    expect(await pessoaDaConversa(reconhecida.done!.conversationId!)).toBe(mae);
  });

  it("evento + vídeo + ficha no mesmo turno; depois conflito preserva o valor antigo", async () => {
    const celular = novoCelular();
    const pessoaId = await inserirPessoa(`Elisa Teste${marker}`, celular);
    const script = installScript(modelMocks, [
      { toolCalls: [
        { name: "detalhes_evento", args: { nome: "Ciclo Água" } },
        { name: "video_do_evento", args: { evento: "Ciclo Água" } },
        { name: "atualizar_ficha", args: { pessoaId: 1, campos: { idade: 41, cidade: "Campinas", profissao: "Professora" } } },
      ] },
      { text: `Que legal, Elisa! O Ciclo Água começa em 15/03/2027: ${URL_AGUA}` },
    ]);
    const primeira = await chat({
      message: "Tenho 41 anos, moro em Campinas e sou professora. Me conta do Ciclo Água e tem vídeo?",
      pessoaNome: `Elisa Teste${marker}`, pessoaCelular: celular,
    });
    const convId = primeira.done!.conversationId!;
    const saidas = toolOutputs(script.requests[1]!.params);
    expect(saidas).toHaveLength(3);
    expect(JSON.parse(saidas[2]!)).toMatchObject({ aplicados: expect.arrayContaining(["idade", "cidade", "profissao"]), conflitos: [] });
    expect(primeira.content).not.toMatch(/anotei|registrei|ficha|cadastro/i);

    const [ficha] = await db.select().from(pessoasTable).where(eq(pessoasTable.id, pessoaId));
    expect(ficha).toMatchObject({ idadeDeclarada: 41, cidade: "Campinas", profissao: "Professora" });
    expect(ficha?.dataNascimento ?? null).toBeNull();
    const evidencias = await db.select().from(pessoaEvidencias)
      .where(and(eq(pessoaEvidencias.pessoaId, pessoaId), eq(pessoaEvidencias.campo, "cidade")));
    expect(evidencias.map(e => [e.origem, e.tipoEvidencia, e.aplicada])).toContainEqual([`sofia:conversa:${convId}`, "declarada", "sim"]);

    const conflito = installScript(modelMocks, [
      { toolCalls: [{ name: "atualizar_ficha", args: { campos: { cidade: "Santos" } } }] },
      { text: "Entendi! Em que posso ajudar hoje?" },
    ]);
    const segunda = await chat({ message: "Agora estou morando em Santos", pessoaNome: `Elisa Teste${marker}`, pessoaCelular: celular });
    const resultado = JSON.parse(toolOutputs(conflito.requests[1]!.params)[0]!) as { conflitos: unknown[] };
    expect(resultado.conflitos).toEqual([{ campo: "cidade", valor_atual_existe: true }]);
    expect(JSON.stringify(resultado)).not.toContain("Campinas");
    const [depois] = await db.select({ cidade: pessoasTable.cidade }).from(pessoasTable).where(eq(pessoasTable.id, pessoaId));
    expect(depois?.cidade).toBe("Campinas");
    const negada = await db.select().from(pessoaEvidencias).where(and(
      eq(pessoaEvidencias.pessoaId, pessoaId), eq(pessoaEvidencias.campo, "cidade"),
      eq(pessoaEvidencias.origem, `sofia:conversa:${segunda.done!.conversationId!}`),
    ));
    expect(negada.map(e => [e.valor, e.aplicada])).toEqual([["Santos", "nao"]]);
  });

  it("CPF, saúde e null são rejeitados; conversa sem dados pessoais não grava nada", async () => {
    const celular = novoCelular();
    const pessoaId = await inserirPessoa(`Fabia Teste${marker}`, celular);
    const script = installScript(modelMocks, [
      { toolCalls: [{ name: "atualizar_ficha", args: { campos: { cpf: "12345678900", condicao_saude: "ansiedade", cidade: null } } }] },
      { text: "Claro! Em que posso ajudar?" },
    ]);
    await chat({ message: "Oi", pessoaNome: `Fabia Teste${marker}`, pessoaCelular: celular });
    const resultado = JSON.parse(toolOutputs(script.requests[1]!.params)[0]!) as { aplicados: string[]; rejeitados: Array<{ campo: string }> };
    expect(resultado.aplicados).toEqual([]);
    expect(resultado.rejeitados.map(r => r.campo).sort()).toEqual(["cidade", "condicao_saude", "cpf"]);

    installScript(modelMocks, [{ text: "Oi! Posso te contar dos próximos eventos?" }]);
    const { content } = await chat({ message: "Quais eventos vocês têm?", pessoaNome: `Fabia Teste${marker}`, pessoaCelular: celular });
    expect(content).not.toMatch(/qual (é )?(o )?seu|me (diz|conta) (sua|seu)/i);
    const evidencias = await db.select().from(pessoaEvidencias)
      .where(and(eq(pessoaEvidencias.pessoaId, pessoaId), sql`${pessoaEvidencias.origem} LIKE 'sofia:conversa:%'`));
    expect(evidencias).toHaveLength(0);
  });

  it("conversa anônima: atualizar_ficha não grava e orienta a não dizer que anotou", async () => {
    const script = installScript(modelMocks, [
      { toolCalls: [{ name: "atualizar_ficha", args: { campos: { cidade: "Recife" } } }] },
      { text: "Que bom! Posso te ajudar com algum evento?" },
    ]);
    await chat({ message: "Moro em Recife" });
    const resultado = JSON.parse(toolOutputs(script.requests[1]!.params)[0]!) as { aplicados: string[]; instrucao?: string; rejeitados: Array<{ motivo: string }> };
    expect(resultado.aplicados).toEqual([]);
    expect(resultado.rejeitados).toEqual([{ campo: "cidade", motivo: "conversa_sem_ficha" }]);
    expect(resultado.instrucao).toMatch(/Não diga que anotou/);
  });
});
