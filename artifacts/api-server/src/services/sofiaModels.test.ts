import { describe, expect, it, vi } from "vitest";
import {
  SOFIA_MODEL_IDS,
  SofiaModelUnavailableError,
  assertSofiaModelAvailable,
  isSupportedSofiaModel,
  runSofiaFinalRound,
  runSofiaToolRound,
  toProviderSofiaModel,
  usesResponsesApiForSofiaTools,
} from "./sofiaModels";

describe("Sofia model aliases", () => {
  it("accepts Terra, Sol and all existing selector models", () => {
    for (const model of SOFIA_MODEL_IDS) {
      expect(isSupportedSofiaModel(model)).toBe(true);
    }
  });

  it("rejects unknown models before they can be persisted", () => {
    expect(isSupportedSofiaModel("openai/unknown-model")).toBe(false);
    expect(isSupportedSofiaModel("gpt-5.6-terra-preview")).toBe(false);
  });

  it("preserves aliases in storage but maps them for the provider", () => {
    expect(toProviderSofiaModel("openai/gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(toProviderSofiaModel("openai/gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(toProviderSofiaModel("gpt-5.4")).toBe("gpt-5.4");
  });

  it("routes only Sol and Terra tool rounds through Responses API", () => {
    expect(usesResponsesApiForSofiaTools("openai/gpt-5.6-sol")).toBe(true);
    expect(usesResponsesApiForSofiaTools("openai/gpt-5.6-terra")).toBe(true);
    expect(usesResponsesApiForSofiaTools("gpt-5.4")).toBe(false);
    expect(usesResponsesApiForSofiaTools("gpt-5-mini")).toBe(false);
  });
});

async function* events<T>(items: T[]) {
  for (const item of items) yield item;
}

describe("Sofia tool transport parity", () => {
  const messages = [{ role: "user", content: "busque água" }];
  const tools = [{
    type: "function" as const,
    function: { name: "search", description: "Busca", parameters: { type: "object", properties: {} } },
  }];

  it("normalizes Chat Completions and Responses into the same tool call", async () => {
    const chatCreate = vi.fn().mockResolvedValue(events([
      { choices: [{ delta: { content: "Antes. " } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: "{\"q\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"agua\"}" } }] } }] },
    ]));
    const responsesCreate = vi.fn().mockResolvedValue(events([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "Antes. " },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "search" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"q\":" },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: "\"agua\"}" },
      { type: "response.completed", response: { id: "resp_1" } },
    ]));
    const client = {
      chat: { completions: { create: chatCreate } },
      responses: { create: responsesCreate },
    };

    const legacy = await runSofiaToolRound({ client, model: "gpt-5.4", messages, tools });
    const migrated = await runSofiaToolRound({ client, model: "openai/gpt-5.6-terra", messages, tools });

    expect(migrated.text).toBe(legacy.text);
    expect(migrated.toolCalls).toEqual(legacy.toolCalls);
    expect(responsesCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.6-terra",
      reasoning: { effort: "medium" },
      parallel_tool_calls: false,
      stream: true,
    }));
  });

  it("preserves second-phase output while chaining Responses with the tool result", async () => {
    const responsesCreate = vi.fn()
      .mockResolvedValueOnce(events([
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "search" } },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" },
        { type: "response.completed", response: { id: "resp_1" } },
      ]))
      .mockResolvedValueOnce(events([
        { type: "response.created", response: { id: "resp_2" } },
        { type: "response.output_text.delta", delta: "Resultado seguro." },
        { type: "response.completed", response: { id: "resp_2" } },
      ]));
    const client = {
      chat: { completions: { create: vi.fn() } },
      responses: { create: responsesCreate },
    };
    const firstRound = await runSofiaToolRound({
      client, model: "openai/gpt-5.6-sol", messages, tools,
    });
    const text = await runSofiaFinalRound({
      client,
      model: "openai/gpt-5.6-sol",
      messages,
      firstRound,
      toolCall: firstRound.toolCalls[0]!,
      toolOutput: "{\"ok\":true}",
    });

    expect(text).toBe("Resultado seguro.");
    expect(responsesCreate).toHaveBeenLastCalledWith(expect.objectContaining({
      previous_response_id: "resp_1",
      input: [{ type: "function_call_output", call_id: "call_1", output: "{\"ok\":true}" }],
      reasoning: { effort: "medium" },
    }));
  });

  it("produces the same second-phase text on legacy and Responses transports", async () => {
    const chatCreate = vi.fn()
      .mockResolvedValueOnce(events([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: "{}" } }] } }] },
      ]))
      .mockResolvedValueOnce(events([
        { choices: [{ delta: { content: "Resultado seguro." } }] },
      ]));
    const responsesCreate = vi.fn()
      .mockResolvedValueOnce(events([
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "search", arguments: "{}" } },
        { type: "response.completed", response: { id: "resp_1" } },
      ]))
      .mockResolvedValueOnce(events([
        { type: "response.created", response: { id: "resp_2" } },
        { type: "response.output_text.delta", delta: "Resultado seguro." },
        { type: "response.completed", response: { id: "resp_2" } },
      ]));
    const client = {
      chat: { completions: { create: chatCreate } },
      responses: { create: responsesCreate },
    };
    const legacyFirst = await runSofiaToolRound({ client, model: "gpt-5.4", messages, tools });
    const legacyText = await runSofiaFinalRound({
      client, model: "gpt-5.4", messages, firstRound: legacyFirst,
      toolCall: legacyFirst.toolCalls[0]!, toolOutput: "{\"ok\":true}",
    });
    const migratedFirst = await runSofiaToolRound({
      client, model: "openai/gpt-5.6-terra", messages, tools,
    });
    const migratedText = await runSofiaFinalRound({
      client, model: "openai/gpt-5.6-terra", messages, firstRound: migratedFirst,
      toolCall: migratedFirst.toolCalls[0]!, toolOutput: "{\"ok\":true}",
    });

    expect(migratedText).toBe(legacyText);
  });

  it.each(["error", "response.failed", "response.incomplete"])(
    "fails closed on terminal Responses event %s",
    async type => {
      const client = {
        chat: { completions: { create: vi.fn() } },
        responses: { create: vi.fn().mockResolvedValue(events([
          { type: "response.created", response: { id: "resp-sensitive" } },
          { type, error: { message: "provider secret diagnostic" } },
        ])) },
      };

      await expect(runSofiaToolRound({
        client, model: "openai/gpt-5.6-sol", messages, tools,
      })).rejects.toMatchObject({
        name: "SofiaGenerationError",
        code: "SOFIA_GENERATION_FAILED",
        message: "Sofia generation failed",
      });
    },
  );

  it("fails closed when the Responses stream ends without completion", async () => {
    const client = {
      chat: { completions: { create: vi.fn() } },
      responses: { create: vi.fn().mockResolvedValue(events([
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.output_text.delta", delta: "resposta parcial" },
      ])) },
    };

    await expect(runSofiaToolRound({
      client, model: "openai/gpt-5.6-terra", messages, tools,
    })).rejects.toMatchObject({ code: "SOFIA_GENERATION_FAILED" });
  });
});

describe("Sofia model availability", () => {
  it("checks Chat Completions with a fictitious function tool", async () => {
    const chatCreate = vi.fn().mockResolvedValue({ choices: [] });
    const responsesCreate = vi.fn();

    await assertSofiaModelAvailable(
      {
        chat: { completions: { create: chatCreate } },
        responses: { create: responsesCreate },
      },
      "gpt-5.4",
    );

    expect(chatCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "Responda apenas OK." }],
        max_completion_tokens: 16,
        tools: [expect.objectContaining({
          type: "function",
          function: expect.objectContaining({ name: "confirmar_compatibilidade" }),
        })],
        tool_choice: "auto",
        parallel_tool_calls: false,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it("checks Responses with the provider model and a fictitious function tool", async () => {
    const chatCreate = vi.fn();
    const responsesCreate = vi.fn().mockResolvedValue({ id: "resp_1" });

    await assertSofiaModelAvailable(
      {
        chat: { completions: { create: chatCreate } },
        responses: { create: responsesCreate },
      },
      "openai/gpt-5.6-terra",
    );

    expect(responsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-terra",
        input: [{ role: "user", content: "Responda apenas OK." }],
        max_output_tokens: 16,
        tools: [expect.objectContaining({
          type: "function",
          name: "confirmar_compatibilidade",
        })],
        tool_choice: "auto",
        parallel_tool_calls: false,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it.each(["chat", "responses"] as const)(
    "returns a stable, credential-safe error when the %s provider endpoint rejects the tool",
    async transport => {
      const rejectedCreate = vi.fn().mockRejectedValue(
        new Error("401 using secret sk-sensitive-value"),
      );
      const unusedCreate = vi.fn();

      await expect(
        assertSofiaModelAvailable(
          {
            chat: { completions: { create: transport === "chat" ? rejectedCreate : unusedCreate } },
            responses: { create: transport === "responses" ? rejectedCreate : unusedCreate },
          },
          transport === "responses" ? "openai/gpt-5.6-sol" : "gpt-5.4",
        ),
      ).rejects.toEqual(expect.objectContaining({
        name: "SofiaModelUnavailableError",
        code: "SOFIA_MODEL_UNAVAILABLE",
        message: "O modelo selecionado está temporariamente indisponível. Tente novamente.",
      } satisfies Partial<SofiaModelUnavailableError>));
      expect(unusedCreate).not.toHaveBeenCalled();
    },
  );
});