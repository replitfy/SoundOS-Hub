import { describe, expect, it, vi } from "vitest";
import { SofiaGenerationError, runSofiaAgentLoop, type SofiaToolCall } from "./sofiaModels";

type Turn = { text?: string; calls?: Array<{ name: string; args?: Record<string, unknown> }> };

function chatClient(turns: Turn[]) {
  const roteiro = [...turns];
  const create = vi.fn(async () => {
    const turn = roteiro.shift();
    if (!turn) throw new Error("roteiro esgotado");
    return {
      async *[Symbol.asyncIterator]() {
        if (turn.text) yield { choices: [{ delta: { content: turn.text } }] };
        for (const [index, call] of (turn.calls ?? []).entries()) {
          yield { choices: [{ delta: { tool_calls: [{ index, id: `c${index}`, function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] } }] };
        }
      },
    };
  });
  return { client: { chat: { completions: { create } }, responses: { create: vi.fn() } }, create };
}

function responsesClient(turns: Turn[]) {
  const roteiro = [...turns];
  let n = 0;
  const create = vi.fn(async () => {
    const turn = roteiro.shift();
    if (!turn) throw new Error("roteiro esgotado");
    const id = `r${++n}`;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "response.created", response: { id } };
        if (turn.text) yield { type: "response.output_text.delta", delta: turn.text };
        for (const [index, call] of (turn.calls ?? []).entries()) {
          yield { type: "response.output_item.done", output_index: index, item: { type: "function_call", call_id: `c${index}`, name: call.name, arguments: JSON.stringify(call.args ?? {}) } };
        }
        yield { type: "response.completed", response: { id } };
      },
    };
  });
  return { client: { chat: { completions: { create: vi.fn() } }, responses: { create } }, create };
}

const tools = [{ type: "function" as const, function: { name: "proximo_evento", parameters: { type: "object", properties: {} } } }];

describe("runSofiaAgentLoop (Chat Completions)", () => {
  it("executa todas as tool calls da rodada e devolve só o texto final", async () => {
    const { client, create } = chatClient([
      { text: "Deixa eu ver... ", calls: [{ name: "proximo_evento" }, { name: "video_do_evento", args: { evento: "x" } }] },
      { text: "Resposta final." },
    ]);
    const executeTool = vi.fn(async (call: SofiaToolCall) => JSON.stringify({ ok: call.function.name }));
    const r = await runSofiaAgentLoop({ client, model: "gpt-5.4", messages: [{ role: "user", content: "oi" }], tools, executeTool });
    expect(r.text).toBe("Resposta final.");
    expect(r.text).not.toContain("Deixa eu ver");
    expect(r.rounds).toBe(2);
    expect(executeTool.mock.calls.map(([c]) => c.function.name)).toEqual(["proximo_evento", "video_do_evento"]);
    const segunda = (create.mock.calls[1] as unknown as [{ messages: Array<{ role: string; tool_call_id?: string }> }])[0];
    expect(segunda.messages.filter(m => m.role === "tool").map(m => m.tool_call_id)).toEqual(["c0", "c1"]);
    expect((create.mock.calls[0] as unknown as [{ parallel_tool_calls: boolean }])[0].parallel_tool_calls).toBe(true);
  });

  it("falha de tool volta ao modelo como {erro} curto, sem derrubar o turno", async () => {
    const { client, create } = chatClient([{ calls: [{ name: "proximo_evento" }] }, { text: "Confirmo com o time interno." }]);
    const r = await runSofiaAgentLoop({
      client, model: "gpt-5.4", messages: [], tools, executeTool: async () => { throw new Error("db down"); },
    });
    expect(r.text).toBe("Confirmo com o time interno.");
    const tool = (create.mock.calls[1] as unknown as [{ messages: Array<{ role: string; content: string }> }])[0].messages.find(m => m.role === "tool");
    expect(JSON.parse(tool!.content)).toHaveProperty("erro");
  });

  it("esgotadas as rodadas com tools, faz uma rodada final sem tools", async () => {
    const { client, create } = chatClient([
      { calls: [{ name: "proximo_evento" }] },
      { calls: [{ name: "proximo_evento" }] },
      { text: "Final sem tools." },
    ]);
    const r = await runSofiaAgentLoop({ client, model: "gpt-5.4", messages: [], tools, executeTool: async () => "{}", maxRounds: 2 });
    expect(r).toMatchObject({ text: "Final sem tools.", rounds: 3, exhausted: true });
    expect((create.mock.calls[2] as unknown as [{ tools?: unknown }])[0].tools).toBeUndefined();
  });
});

describe("runSofiaAgentLoop (Responses, Sol/Terra)", () => {
  it("encadeia previous_response_id e devolve todas as saídas da rodada", async () => {
    const { client, create } = responsesClient([
      { calls: [{ name: "proximo_evento" }, { name: "atualizar_ficha", args: { campos: { cidade: "Recife" } } }] },
      { text: "Pronto." },
    ]);
    const r = await runSofiaAgentLoop({
      client, model: "openai/gpt-5.6-sol", messages: [{ role: "user", content: "oi" }], tools,
      executeTool: async call => JSON.stringify({ tool: call.function.name }), reasoningEffort: "low",
    });
    expect(r).toMatchObject({ text: "Pronto.", rounds: 2, transport: "responses" });
    const [primeira, segunda] = create.mock.calls.map(c => (c as unknown as [Record<string, unknown>])[0]);
    expect(primeira).toMatchObject({ model: "gpt-5.6-sol", reasoning: { effort: "low" }, parallel_tool_calls: true });
    expect(segunda).toMatchObject({ previous_response_id: "r1" });
    expect((segunda!.input as Array<{ call_id: string }>).map(i => i.call_id)).toEqual(["c0", "c1"]);
  });

  it("falha fechado quando o stream termina sem response.completed", async () => {
    const create = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() { yield { type: "response.output_text.delta", delta: "meio" }; },
    }));
    await expect(runSofiaAgentLoop({
      client: { chat: { completions: { create: vi.fn() } }, responses: { create } },
      model: "openai/gpt-5.6-sol", messages: [], tools, executeTool: async () => "{}",
    })).rejects.toBeInstanceOf(SofiaGenerationError);
  });
});
