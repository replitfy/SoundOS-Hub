import {
  SOFIA_MODEL_IDS,
  DEFAULT_SOFIA_MODEL_ID,
  isSofiaModelId,
  toSofiaProviderModel,
  type SofiaModelId,
} from "@workspace/sofia-models";

export { DEFAULT_SOFIA_MODEL_ID, SOFIA_MODEL_IDS, type SofiaModelId };

export function isSupportedSofiaModel(model: string): model is SofiaModelId {
  return isSofiaModelId(model);
}

export function toProviderSofiaModel(model: string): string {
  return toSofiaProviderModel(model);
}

type ChatTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type SofiaToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type SofiaToolRound = {
  text: string;
  toolCalls: SofiaToolCall[];
  responseId: string | null;
  transport: "chat_completions" | "responses";
};

export class SofiaGenerationError extends Error {
  readonly code = "SOFIA_GENERATION_FAILED";

  constructor() {
    super("Sofia generation failed");
    this.name = "SofiaGenerationError";
  }
}

export function usesResponsesApiForSofiaTools(model: string): boolean {
  const providerModel = toProviderSofiaModel(model);
  return providerModel === "gpt-5.6-sol" || providerModel === "gpt-5.6-terra";
}

type SofiaGenerationClient = {
  // Keep the client boundary structural so both the overloaded OpenAI SDK
  // methods and small deterministic test doubles can implement it.
  chat: { completions: { create: (...args: any[]) => any } };
  responses: { create: (...args: any[]) => any };
};

function toResponseTools(tools: ChatTool[]): Array<Record<string, unknown>> {
  return tools.map(tool => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters ?? { type: "object", properties: {} },
    strict: false,
  }));
}

async function collectChatToolRound(stream: AsyncIterable<unknown>): Promise<SofiaToolRound> {
  let text = "";
  const toolCalls: SofiaToolCall[] = [];
  for await (const rawChunk of stream) {
    const chunk = rawChunk as {
      choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{
        index: number; id?: string; function?: { name?: string; arguments?: string };
      }> } }>;
    };
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) text += delta.content;
    for (const call of delta?.tool_calls ?? []) {
      toolCalls[call.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
      const accumulated = toolCalls[call.index]!;
      if (call.id) accumulated.id += call.id;
      if (call.function?.name) accumulated.function.name += call.function.name;
      if (call.function?.arguments) accumulated.function.arguments += call.function.arguments;
    }
  }
  return { text, toolCalls, responseId: null, transport: "chat_completions" };
}

async function collectResponsesToolRound(stream: AsyncIterable<unknown>): Promise<SofiaToolRound> {
  let text = "";
  let responseId: string | null = null;
  let completed = false;
  const callsByIndex = new Map<number, SofiaToolCall>();
  for await (const rawEvent of stream) {
    const event = rawEvent as {
      type?: string;
      delta?: string;
      arguments?: string;
      output_index?: number;
      item?: { type?: string; call_id?: string; name?: string; arguments?: string };
      response?: { id?: string };
    };
    if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
      throw new SofiaGenerationError();
    }
    if (event.type === "response.created" && event.response?.id) responseId = event.response.id;
    if (event.type === "response.completed") completed = true;
    if (event.type === "response.output_text.delta" && event.delta) text += event.delta;
    if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
      callsByIndex.set(event.output_index ?? callsByIndex.size, {
        id: event.item.call_id ?? "",
        type: "function",
        function: { name: event.item.name ?? "", arguments: event.item.arguments ?? "" },
      });
    }
    if (event.type === "response.function_call_arguments.delta" && event.delta) {
      const call = callsByIndex.get(event.output_index ?? -1);
      if (call) call.function.arguments += event.delta;
    }
    if (event.type === "response.function_call_arguments.done" && typeof event.arguments === "string") {
      const call = callsByIndex.get(event.output_index ?? -1);
      if (call) call.function.arguments = event.arguments;
    }
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      callsByIndex.set(event.output_index ?? callsByIndex.size, {
        id: event.item.call_id ?? "",
        type: "function",
        function: { name: event.item.name ?? "", arguments: event.item.arguments ?? "" },
      });
    }
  }
  if (!completed) throw new SofiaGenerationError();
  const toolCalls = [...callsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call);
  if (toolCalls.some(call => !call.id || !call.function.name)) throw new SofiaGenerationError();
  return {
    text,
    toolCalls,
    responseId,
    transport: "responses",
  };
}

export async function runSofiaToolRound(params: {
  client: SofiaGenerationClient;
  model: string;
  messages: unknown[];
  tools: ChatTool[];
}): Promise<SofiaToolRound> {
  const providerModel = toProviderSofiaModel(params.model);
  if (usesResponsesApiForSofiaTools(params.model)) {
    const stream = await params.client.responses.create({
      model: providerModel,
      max_output_tokens: 8192,
      input: params.messages,
      tools: toResponseTools(params.tools),
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: "medium" },
      stream: true,
    });
    return collectResponsesToolRound(stream);
  }
  const stream = await params.client.chat.completions.create({
    model: providerModel,
    max_completion_tokens: 8192,
    messages: params.messages,
    tools: params.tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
    stream: true,
  });
  return collectChatToolRound(stream);
}

export async function runSofiaFinalRound(params: {
  client: SofiaGenerationClient;
  model: string;
  messages: unknown[];
  firstRound: SofiaToolRound;
  toolCall: SofiaToolCall;
  toolOutput: string;
}): Promise<string> {
  if (params.firstRound.transport === "responses") {
    if (!params.firstRound.responseId) throw new Error("Sofia response chain unavailable");
    const stream = await params.client.responses.create({
      model: toProviderSofiaModel(params.model),
      max_output_tokens: 8192,
      previous_response_id: params.firstRound.responseId,
      input: [{
        type: "function_call_output",
        call_id: params.toolCall.id,
        output: params.toolOutput,
      }],
      reasoning: { effort: "medium" },
      stream: true,
    });
    return (await collectResponsesToolRound(stream)).text;
  }
  const stream = await params.client.chat.completions.create({
    model: toProviderSofiaModel(params.model),
    max_completion_tokens: 8192,
    messages: [
      ...params.messages,
      { role: "assistant", content: null, tool_calls: params.firstRound.toolCalls },
      { role: "tool", tool_call_id: params.toolCall.id, content: params.toolOutput },
    ],
    stream: true,
  });
  return (await collectChatToolRound(stream)).text;
}

export type SofiaReasoningEffort = "none" | "low" | "medium";

export type SofiaAgentToolResult = { call: SofiaToolCall; output: string };

export type SofiaAgentLoopResult = {
  text: string;
  rounds: number;
  toolResults: SofiaAgentToolResult[];
  /** true quando as rodadas com tools acabaram e foi preciso uma rodada final sem tools. */
  exhausted: boolean;
  transport: "chat_completions" | "responses";
};

function toolFailureOutput(): string {
  return JSON.stringify({ erro: "A ferramenta falhou agora. Não invente o dado: diga que confirma com o time interno." });
}

async function executeAll(
  calls: SofiaToolCall[],
  executeTool: (call: SofiaToolCall) => Promise<string>,
): Promise<SofiaAgentToolResult[]> {
  const results: SofiaAgentToolResult[] = [];
  // Sequencial: tools podem gravar na ficha sob lock de linha.
  for (const call of calls) {
    let output: string;
    try {
      output = await executeTool(call);
    } catch {
      output = toolFailureOutput();
    }
    results.push({ call, output });
  }
  return results;
}

/**
 * Loop multi-tool do modo simples. Executa todas as tool calls de cada rodada,
 * devolve os resultados ao modelo e repete até `maxRounds` rodadas com tools;
 * se ainda houver tool call na última, faz uma rodada final sem tools. Só o
 * texto da rodada final é devolvido (texto pré-tool não é concatenado).
 * Não altera runSofiaToolRound/runSofiaFinalRound (testes de paridade do legado).
 */
export async function runSofiaAgentLoop(params: {
  client: SofiaGenerationClient;
  model: string;
  messages: unknown[];
  tools: ChatTool[];
  executeTool: (call: SofiaToolCall) => Promise<string>;
  maxRounds?: number;
  reasoningEffort?: SofiaReasoningEffort;
}): Promise<SofiaAgentLoopResult> {
  const maxRounds = Math.max(1, params.maxRounds ?? 4);
  const providerModel = toProviderSofiaModel(params.model);
  const effort = params.reasoningEffort ?? "medium";
  const toolResults: SofiaAgentToolResult[] = [];
  let lastNonEmptyText = "";

  if (usesResponsesApiForSofiaTools(params.model)) {
    let previousResponseId: string | null = null;
    let pendingOutputs: SofiaAgentToolResult[] = [];
    for (let round = 1; round <= maxRounds + 1; round++) {
      const finalWithoutTools = round > maxRounds;
      const input = previousResponseId
        ? pendingOutputs.map(result => ({ type: "function_call_output", call_id: result.call.id, output: result.output }))
        : params.messages;
      const stream = await params.client.responses.create({
        model: providerModel,
        max_output_tokens: 8192,
        input,
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        ...(finalWithoutTools ? {} : {
          tools: toResponseTools(params.tools),
          tool_choice: "auto",
          parallel_tool_calls: true,
        }),
        reasoning: { effort },
        stream: true,
      });
      const result = await collectResponsesToolRound(stream);
      if (result.text.trim()) lastNonEmptyText = result.text;
      if (result.toolCalls.length === 0 || finalWithoutTools) {
        return {
          text: result.text.trim() ? result.text : lastNonEmptyText,
          rounds: round,
          toolResults,
          exhausted: finalWithoutTools,
          transport: "responses",
        };
      }
      if (!result.responseId) throw new SofiaGenerationError();
      previousResponseId = result.responseId;
      pendingOutputs = await executeAll(result.toolCalls, params.executeTool);
      toolResults.push(...pendingOutputs);
    }
    throw new SofiaGenerationError();
  }

  const conversation: unknown[] = [...params.messages];
  for (let round = 1; round <= maxRounds + 1; round++) {
    const finalWithoutTools = round > maxRounds;
    const stream = await params.client.chat.completions.create({
      model: providerModel,
      max_completion_tokens: 8192,
      messages: conversation,
      ...(finalWithoutTools ? {} : { tools: params.tools, tool_choice: "auto", parallel_tool_calls: true }),
      stream: true,
    });
    const result = await collectChatToolRound(stream);
    if (result.text.trim()) lastNonEmptyText = result.text;
    if (result.toolCalls.length === 0 || finalWithoutTools) {
      return {
        text: result.text.trim() ? result.text : lastNonEmptyText,
        rounds: round,
        toolResults,
        exhausted: finalWithoutTools,
        transport: "chat_completions",
      };
    }
    const calls = result.toolCalls.filter(Boolean);
    const outputs = await executeAll(calls, params.executeTool);
    toolResults.push(...outputs);
    conversation.push({ role: "assistant", content: result.text || null, tool_calls: calls });
    for (const output of outputs) {
      conversation.push({ role: "tool", tool_call_id: output.call.id, content: output.output });
    }
  }
  throw new SofiaGenerationError();
}

type ModelRetriever = {
  // Structural boundary for the overloaded OpenAI SDK methods and test doubles.
  chat: { completions: { create: (...args: any[]) => any } };
  responses: { create: (...args: any[]) => any };
};

const MODEL_COMPATIBILITY_TOOL: ChatTool = {
  type: "function",
  function: {
    name: "confirmar_compatibilidade",
    description: "Função fictícia usada somente para validar compatibilidade do modelo.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
};

export class SofiaModelUnavailableError extends Error {
  readonly code = "SOFIA_MODEL_UNAVAILABLE";

  constructor() {
    super("O modelo selecionado está temporariamente indisponível. Tente novamente.");
    this.name = "SofiaModelUnavailableError";
  }
}

export async function assertSofiaModelAvailable(
  client: ModelRetriever,
  model: string,
  timeoutMs = 5_000,
): Promise<void> {
  if (!isSupportedSofiaModel(model)) {
    throw new SofiaModelUnavailableError();
  }

  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const providerModel = toProviderSofiaModel(model);
    if (usesResponsesApiForSofiaTools(model)) {
      await client.responses.create(
        {
          model: providerModel,
          input: [{ role: "user", content: "Responda apenas OK." }],
          max_output_tokens: 16,
          tools: toResponseTools([MODEL_COMPATIBILITY_TOOL]),
          tool_choice: "auto",
          parallel_tool_calls: false,
        },
        { signal },
      );
    } else {
      await client.chat.completions.create(
        {
          model: providerModel,
          messages: [{ role: "user", content: "Responda apenas OK." }],
          max_completion_tokens: 16,
          tools: [MODEL_COMPATIBILITY_TOOL],
          tool_choice: "auto",
          parallel_tool_calls: false,
        },
        { signal },
      );
    }
  } catch {
    throw new SofiaModelUnavailableError();
  }
}