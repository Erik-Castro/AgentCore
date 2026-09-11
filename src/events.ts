/**
 * Camada de tradução entre o stream real do SDK (OpenAI Responses API) e os
 * eventos do harness (spec §4, com os nomes reais de delta).
 *
 * Mapeamento (spec → real):
 *   thinking            → response.reasoning_summary_text.delta
 *                           (alguns modelos expõem response.reasoning_text.delta)
 *   thinking.end        → response.reasoning_summary_text.done (ou reasoning_text.done)
 *   content             → response.output_text.delta
 *   content.end         → response.output_text.done
 *   chamada de tool     → response.output_item.added/.done (item "function_call")
 *                         + response.function_call_arguments.delta (acúmulo por output_index)
 *   métricas de tokens  → response.completed (response.usage)
 *
 * Esta função é pura: não faz rede, apenas consome um iterável de eventos.
 */
import type { Responses } from "openai/resources/responses";
import type { AgentEvent, TokenUsage, ToolCall } from "./types.ts";



/** Mapeia ResponseUsage do SDK para TokenUsage do harness. */
export function mapUsage(usage: Responses.ResponseUsage | null | undefined): TokenUsage | null {
  if (!usage) return null;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
  };
}

/** Resumo do processamento de um round completo (o valor de retorno do gerador). */
export interface RoundOutcome {
  reasoning: string;
  content: string;
  /** Itens emitidos (mensagem/function_call/reasoning) — para reencaminhar no próximo round. */
  items: Responses.ResponseOutputItem[];
  calls: ToolCall[];
  usage: TokenUsage | null;
  aborted: boolean;
  errored: unknown;
}

export async function* mapResponseStream(
  stream: AsyncIterable<Responses.ResponseStreamEvent>,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent, RoundOutcome, void> {
  let reasoning = "";
  let content = "";
  const items: Responses.ResponseOutputItem[] = [];
  const calls: ToolCall[] = [];
  // Acúmulo de argumentos por output_index (as deltas chegam picadas).
  const pendingArgs = new Map<number, string>();
  let usage: TokenUsage | null = null;
  let errored: unknown = null;

  const aborted = (): boolean => signal?.aborted === true;

  try {
    for await (const event of stream) {
      if (aborted()) break;

      switch (event.type) {
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          reasoning += event.delta;
          yield { type: "reasoning", token: event.delta };
          break;

        case "response.reasoning_summary_text.done":
        case "response.reasoning_text.done":
          yield { type: "reasoning.done" };
          break;

        case "response.output_text.delta":
          content += event.delta;
          yield { type: "content", token: event.delta };
          break;

        case "response.output_text.done":
          yield { type: "content.done" };
          break;

        case "response.output_item.added":
          if (event.item.type === "function_call") {
            pendingArgs.set(event.output_index, event.item.arguments ?? "");
          }
          break;

        case "response.function_call_arguments.delta":
          pendingArgs.set(
            event.output_index,
            (pendingArgs.get(event.output_index) ?? "") + event.delta,
          );
          break;

        case "response.output_item.done":
          items.push(event.item);
          if (event.item.type === "function_call") {
            const call: ToolCall = {
              id: event.item.id ?? "",
              call_id: event.item.call_id,
              name: event.item.name,
              args: event.item.arguments ?? pendingArgs.get(event.output_index) ?? "",
            };
            calls.push(call);
            yield { type: "tool_call", tool: call.name, args: call.args };
          }
          break;

        case "response.completed":
          usage = mapUsage(event.response.usage);
          break;

        case "error":
          errored = event;
          break;

        case "response.failed":
        case "response.incomplete":
          errored = event;
          break;
      }
    }
  } catch (cause) {
    errored = aborted() ? null : cause;
  }

  return {
    reasoning,
    content,
    items,
    calls,
    usage,
    aborted: aborted(),
    errored,
  };
}