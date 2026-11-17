// Modelo roteirizado para testes de rota do modo simples da Sofia.
// Cada chamada com `stream: true` consome um turno do roteiro e devolve um
// stream fiel ao transporte (Chat Completions ou Responses), com várias tool
// calls por rodada quando o turno pedir. Chamadas sem stream (título,
// classifyDecision em background) recebem uma resposta curta e não consomem
// o roteiro.
import type { Mock } from "vitest";

export type ScriptedTurn = {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
};

export type ScriptedRequest = { transport: "chat" | "responses"; params: Record<string, unknown> };

type ModelMocks = { chatCreate: Mock; responsesCreate: Mock };

let responseCounter = 0;

function chatStream(turn: ScriptedTurn) {
  return {
    async *[Symbol.asyncIterator]() {
      if (turn.text) yield { choices: [{ delta: { content: turn.text } }] };
      for (const [index, call] of (turn.toolCalls ?? []).entries()) {
        yield { choices: [{ delta: { tool_calls: [{ index, id: `call_${index}_${call.name}`, function: { name: call.name, arguments: "" } }] } }] };
        yield { choices: [{ delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(call.args) } }] } }] };
      }
      yield { choices: [{ delta: {}, finish_reason: turn.toolCalls?.length ? "tool_calls" : "stop" }] };
    },
  };
}

function responsesStream(turn: ScriptedTurn) {
  const id = `resp_test_${++responseCounter}`;
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "response.created", response: { id } };
      if (turn.text) yield { type: "response.output_text.delta", delta: turn.text };
      for (const [index, call] of (turn.toolCalls ?? []).entries()) {
        const item = { type: "function_call", call_id: `call_${index}_${call.name}`, name: call.name, arguments: "" };
        yield { type: "response.output_item.added", output_index: index + 1, item };
        yield { type: "response.function_call_arguments.delta", output_index: index + 1, delta: JSON.stringify(call.args) };
        yield { type: "response.output_item.done", output_index: index + 1, item: { ...item, arguments: JSON.stringify(call.args) } };
      }
      yield { type: "response.completed", response: { id } };
    },
  };
}

/** Instala o roteiro nos mocks do cliente OpenAI. Devolve as requisições recebidas. */
export function installScript(mocks: ModelMocks, turns: ScriptedTurn[]): { requests: ScriptedRequest[]; remaining: () => number } {
  const roteiro = [...turns];
  const requests: ScriptedRequest[] = [];
  const proximo = (transport: ScriptedRequest["transport"], params: Record<string, unknown>) => {
    requests.push({ transport, params });
    const turn = roteiro.shift();
    if (!turn) throw new Error("roteiro do modelo esgotado");
    return turn;
  };
  mocks.chatCreate.mockReset();
  mocks.responsesCreate.mockReset();
  mocks.chatCreate.mockImplementation(async (params: Record<string, unknown>) => {
    if (params.stream !== true) {
      return { choices: [{ message: { content: JSON.stringify({ nbaCategoria: "conversar", nbaJustificativa: "teste", nivelConfianca: "baixa" }) } }] };
    }
    return chatStream(proximo("chat", params));
  });
  mocks.responsesCreate.mockImplementation(async (params: Record<string, unknown>) => responsesStream(proximo("responses", params)));
  return { requests, remaining: () => roteiro.length };
}

export type SseEvent = {
  content?: string; done?: boolean; conversationId?: number; error?: string; code?: string;
  handoffTriggered?: boolean; handoffReason?: string; handoffSummary?: Record<string, unknown>;
  handoffActive?: boolean;
};

export function parseSse(text: string): { events: SseEvent[]; content: string; done: SseEvent | undefined } {
  const events = text.split("\n")
    .filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)) as SseEvent);
  return {
    events,
    content: events.map(e => e.content ?? "").join(""),
    done: events.find(e => e.done),
  };
}

/** Texto do system prompt enviado na primeira rodada (Chat ou Responses). */
export function systemPromptOf(request: ScriptedRequest | undefined): string {
  const lista = (request?.params.messages ?? request?.params.input) as Array<{ role?: string; content?: string }> | undefined;
  return lista?.find(m => m.role === "system")?.content ?? "";
}

/** Nomes das tools oferecidas numa requisição. */
export function toolNamesOf(request: ScriptedRequest | undefined): string[] {
  const tools = (request?.params.tools ?? []) as Array<{ name?: string; function?: { name?: string } }>;
  return tools.map(t => t.name ?? t.function?.name ?? "");
}
