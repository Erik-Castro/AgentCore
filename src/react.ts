/**
 * Classe principal do harness ReAct (spec §5) com a API de gerador do
 * suggests.md §3A: `run()` é `async *run(prompt)` que emite `AgentEvent` em
 * tempo real e retorna `TExecutionResult` ao final.
 *
 * - Loop ReAct: pensamento/ação/observação via stream (spec §4).
 * - Tool calling: itens `function_call` do round são executados e devolvidos
 *   como `function_call_output` no histórico (self-healing incluso, §C).
 * - Poda de contexto determinística simples (§B reduzida) via limites de
 *   itens/caracteres (sumarização por LLM fica para depois).
 * - `cancel()` via AbortSignal habilita graceful shutdown (spec §4).
 *
 * O transport é injetável (`responses`): tests offline usam um provider fake;
 * o default chama `client.responses.create({ stream:true })` contra o Ollama.
 */
import type OpenAI from "openai";
import type { Responses } from "openai/resources/responses";
import type {
  AgentEvent,
  TAgent,
  TExecutionResult,
  ThinkingLevel,
  Tool,
} from "./types.ts";
import { mapResponseStream, type RoundOutcome } from "./events.ts";
import { ToolRegistry, toOpenAITool } from "./tools.ts";
import { createClient } from "./client.ts";
import { loadRuntimeConfig } from "./config.ts";

const DEFAULT_MAX_ROUNDS = 6;
const DEFAULT_MAX_CONTEXT_ITEMS = 40;
const DEFAULT_MAX_CONTEXT_CHARS = 120_000;

/** Requisição de um único round ao provider (modelo de baixo nível). */
export interface ResponsesCallRequest {
  model: string;
  instructions: string;
  input: Responses.ResponseInputItem[];
  tools: Responses.Tool[];
  reasoning?: { effort?: ThinkingLevel | null };
  signal: AbortSignal;
}

/** Provider do transport: retorna o iterável de eventos do stream. */
export type ResponsesCall = (
  request: ResponsesCallRequest,
) => Promise<AsyncIterable<Responses.ResponseStreamEvent>>;

function defaultResponsesCall(client: OpenAI): ResponsesCall {
  return async (request) => {
    const stream = await client.responses.create(
      {
        model: request.model,
        instructions: request.instructions,
        input: request.input as unknown as Responses.ResponseInput,
        tools: request.tools,
        reasoning: request.reasoning ?? undefined,
        stream: true,
      },
      { signal: request.signal },
    );
    return stream;
  };
}

export interface ReActOptions {
  /** Provider injetado (tests offline). Default: cliente OpenAI real. */
  responses?: ResponsesCall;
  /** Cliente OpenAI injetado (alternativa ao provider). Default: criado de env. */
  client?: OpenAI;
  maxContextItems?: number;
  maxContextChars?: number;
}

/**
 * Harness ReAct (spec §5):
 *   private _messages/_system_prompt/_rounds/_callings/_maxRounds/_think_level/_model/_tools
 */
export class ReAct {
  private _messages: Array<Responses.ResponseInputItem | Responses.ResponseOutputItem> = [];
  private readonly _system_prompt: string;
  private _rounds = 0;
  private _callings = 0;
  private readonly _maxRounds: number;
  private readonly _think_level?: ThinkingLevel;
  private readonly _model: string;
  private readonly _registry = new ToolRegistry();
  private readonly _responses: ResponsesCall;
  private readonly _maxContextItems: number;
  private readonly _maxContextChars: number;
  private _ac: AbortController | null = null;
  private _state: "idle" | "running" | "paused" = "idle";
  private _pendingApproval: {
    call_id: string;
    resolve: (approved: boolean) => void;
  } | null = null;

  private get pendingApproval(): {
    call_id: string;
    resolve: (approved: boolean) => void;
  } | null {
    return this._pendingApproval;
  }

  // Callbacks da spec §5 (façade sobre o fluxo de eventos do generator).
  private _toolCallingCb?: (name: string, params: string) => void;
  private _toolResponseCb?: (name: string, response: string) => void;
  private _reasoningCb?: (token: string) => void;
  private _contentCb?: (token: string) => void;

  constructor(config: TAgent, options: ReActOptions = {}) {
    this._model = config.model;
    this._system_prompt = config.system_prompt;
    this._maxRounds = config.maxRounds;
    this._think_level = config.thinking;
    this._responses = options.responses ??
      defaultResponsesCall(options.client ?? createClient(loadRuntimeConfig()));
    this._maxContextItems = options.maxContextItems ?? DEFAULT_MAX_CONTEXT_ITEMS;
    this._maxContextChars = options.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  }

  // ---- Event listeners (spec §5) -----------------------------------------

  public onToolCalling(cb: (name: string, params: string) => void): void {
    this._toolCallingCb = cb;
  }

  public onToolResponse(cb: (name: string, response: string) => void): void {
    this._toolResponseCb = cb;
  }

  public onReasoning(cb: (token: string) => void): void {
    this._reasoningCb = cb;
  }

  public onContent(cb: (token: string) => void): void {
    this._contentCb = cb;
  }

  /** Injeção de ferramentas (spec §5). */
  public registryTool(tool: Tool): void {
    this._registry.register(tool);
  }

  /** Encerramento gracioso do round em curso (spec §4 `cancel()`). */
  public cancel(): void {
    const pending = this._pendingApproval;
    if (pending) {
      this._pendingApproval = null;
      pending.resolve(false);
    }
    this._ac?.abort();
  }

  /** Estado do motor: `paused` significa aguardando `resume(...)` (§D). */
  public get state(): "idle" | "running" | "paused" {
    return this._state;
  }

  /**
   * HITL (suggests.md §D): decide a aprovação pendente emitida via
   * `tool_interrupt`. `true` executa a tool sensível; `false` injeta a recusa
   * do usuário no contexto e emite `tool_denied`.
   */
  public resume(approved: boolean): void {
    if (!this._pendingApproval) {
      throw new Error("resume() sem tool_interrupt pendente.");
    }
    const { resolve } = this._pendingApproval;
    this._pendingApproval = null;
    resolve(approved);
    if (this._state === "paused") this._state = "running";
  }

  public get rounds(): number {
    return this._rounds;
  }

  public get toolCalls(): number {
    return this._callings;
  }

  /** Limpa o histórico da conversa (nova sessão no mesmo motor). */
  public reset(): void {
    this._messages = [];
    this._rounds = 0;
    this._callings = 0;
  }

  private toUserItem(prompt: string): Responses.ResponseInputItem {
    return { role: "user", content: [{ type: "input_text", text: prompt }] };
  }

  /** Poda determinística simple (§B): descarta os itens mais antigos primeiro. */
  private prune(): void {
    const excess = this._messages.length - this._maxContextItems;
    if (excess > 0) this._messages.splice(0, excess);
    if (this._maxContextChars > 0) {
      while (
        JSON.stringify(this._messages).length > this._maxContextChars &&
        this._messages.length > 2
      ) {
        this._messages.shift();
      }
    }
  }

  /**
   * Loop ReAct (spec §5 `run`, redefinido como gerador pelo suggests.md §3A):
   * emite eventos em tempo real e retorna o `TExecutionResult` no final.
   */
  public async *run(prompt: string): AsyncGenerator<AgentEvent, TExecutionResult, void> {
    const started = performance.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let finalReasoning = "";
    let finalContent = "";
    this._rounds = 0;
    this._ac = new AbortController();
    const signal = this._ac.signal;
    this._state = "running";
    this._pendingApproval = null;
    this._messages.push(this.toUserItem(prompt));

    const finish = (): TExecutionResult => ({
      inputTokens,
      outputTokens,
      totalTokens,
      timeExecution: performance.now() - started,
      content: { content: finalContent, reasoning: finalReasoning },
      rounds: this._rounds,
      toolCalls: this._callings,
    });

    try {
      for (;;) {
        if (this._rounds >= this._maxRounds) break;
        this._rounds++;
        this.prune();

        const stream = await this._responses({
          model: this._model,
          instructions: this._system_prompt,
          input: this._messages as Responses.ResponseInputItem[],
          tools: this._registry.list().map(toOpenAITool),
          reasoning: this._think_level ? { effort: this._think_level } : undefined,
          signal,
        });

        const mapper = mapResponseStream(stream, signal);
        let outcome: RoundOutcome;
        for (;;) {
          const { done, value } = await mapper.next();
          if (done) {
            outcome = value;
            break;
          }
          switch (value.type) {
            case "reasoning":
              finalReasoning += value.token;
              this._reasoningCb?.(value.token);
              break;
            case "content":
              finalContent += value.token;
              this._contentCb?.(value.token);
              break;
            case "tool_call":
              this._toolCallingCb?.(value.tool, value.args);
              break;
            case "reasoning.done":
            case "content.done":
            case "tool_result":
            case "error":
            case "aborted":
              break;
          }
          yield value;
        }

        if (outcome.usage) {
          inputTokens += outcome.usage.inputTokens;
          outputTokens += outcome.usage.outputTokens;
          totalTokens += outcome.usage.totalTokens;
        }
        if (outcome.aborted) {
          yield { type: "aborted" };
          return finish();
        }
        if (outcome.errored) {
          yield { type: "error", error: outcome.errored };
          return finish();
        }

        this._messages.push(
          ...outcome.items as Responses.ResponseInputItem[],
        );

        if (outcome.calls.length === 0) break;

        for (const call of outcome.calls) {
          const tool = this._registry.get(call.name);
          if (tool?.sensitive) {
            // HITL (§D): pausa e aguarda decisão humana via resume().
            this._state = "paused";
            const approval = new Promise<boolean>((resolve) => {
              this._pendingApproval = { call_id: call.call_id, resolve };
            });
            yield {
              type: "tool_interrupt",
              tool: call.name,
              args: call.args,
              call_id: call.call_id,
            };
            const approved = await approval;
            if (signal.aborted) {
              yield { type: "aborted" };
              return finish();
            }
            this._state = "running";
            if (!approved) {
              const output =
                `Ação recusada pelo usuário. Não execute a ferramenta "${call.name}".`;
              this._messages.push({
                type: "function_call_output",
                call_id: call.call_id,
                output,
              });
              yield { type: "tool_denied", tool: call.name, args: call.args };
              continue;
            }
          }

          const res = await this._registry.executeSafe(call.name, call.args);
          const output = res.ok ? (res.output as string) : (res.error as string);
          this._messages.push({
            type: "function_call_output",
            call_id: call.call_id,
            output,
          });
          this._callings++;
          this._toolResponseCb?.(call.name, output);
          yield { type: "tool_result", tool: call.name, ok: res.ok, output };

          if (!res.ok) {
            // Self-healing (§C): o erro volta ao contexto para o modelo corrigir.
            this._messages.push({
              role: "system",
              content:
                `Erro na ferramenta "${call.name}": ${res.error}. ` +
                "Corrija os parâmetros e tente novamente.",
            });
          }
        }
      }
    } catch (cause) {
      if (signal.aborted) {
        yield { type: "aborted" };
      } else {
        yield { type: "error", error: cause };
      }
    } finally {
      this.pendingApproval?.resolve(false);
      this._pendingApproval = null;
      this._ac = null;
      this._state = "idle";
    }

    return finish();
  }
}