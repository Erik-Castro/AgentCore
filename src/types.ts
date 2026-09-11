/**
 * Tipos públicos do harness ReAct (futuro core do OllamaTask).
 * Fonte: spec.md (§1–§3) e suggests.md (§3A — eventos via geradores assíncronos).
 *
 * Desvios documentados em relação à spec:
 * - `TExecutionResult` ganha os campos aditivos `rounds`, `toolCalls` e `summaries`.
 * - `TAgent.thinking` é opcional: valores fora do suporte do modelo são
 *   simplesmente ignorados pelo provider (passthrough de reasoning.effort).
 * - `Tool.execute` recebe os parâmetros já parseados (objeto), não a string JSON.
 */

/** Resposta final do modelo, separando conteúdo e raciocínio. */
export interface TContent {
  content: string;
  reasoning: string;
}

/** Token de uso de uma execução (mapeado de ResponseUsage). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Resultado consolidado de uma execução completa do agente (spec §3). */
export interface TExecutionResult {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timeExecution: number;
  content: TContent;
  rounds: number;
  toolCalls: number;
  /** Quantas vezes o histórico foi condensado por LLM (§B). */
  summaries: number;
}

/** Nível de raciocínio (spec §3) — passthrough de `reasoning.effort`. */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Configuração primária do motor (spec §3). */
export interface TAgent {
  model: string;
  thinking?: ThinkingLevel;
  system_prompt: string;
  maxRounds: number;
}

/** JSON Schema enxuto usado na validação de parâmetros das ferramentas. */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  additionalProperties?: boolean;
  [keyword: string]: unknown;
}

/** Contrato de ferramenta (spec §6.3): nome + descrição + JSON Schema. */
export interface Tool {
  name: string;
  description: string;
  parameters?: JsonSchema;
  execute: (params: Record<string, unknown>) => string | Promise<string>;
  /** HITL (suggests.md §D): exige aprovação humana via `resume(true|false)`. */
  sensitive?: boolean;
}

/** Resultado de uma execução de ferramenta (ok=false alimenta o self-healing). */
export interface ToolResult {
  ok: boolean;
  output?: string;
  error?: string;
}

/** Chamada de ferramenta detectada no stream. */
export interface ToolCall {
  id: string;
  call_id: string;
  name: string;
  args: string;
}

/**
 * Eventos emitidos pelo `run()` (gera a API de run gerador do suggests.md §3A).
 * `reasoning`/`content` transportam deltas em tempo real; `reasoning.done`/
 * `content.done` são marcadores de fim (spec §4 pensava em `thinking.end`/
 * `content.end` emitindo `\n` — agora é decisão do consumidor).
 * `tool_interrupt` (HITL §D): o agente aguarda `resume(true|false)` antes de
 * executar uma tool sensível; `tool_denied` sinaliza a recusa do usuário
 * (`reason: "timeout"` quando `approvalTimeoutMs` esgotar sem decisão).
 */
export type AgentEvent =
  | { type: "reasoning"; token: string }
  | { type: "reasoning.done" }
  | { type: "content"; token: string }
  | { type: "content.done" }
  | { type: "tool_call"; tool: string; args: string }
  | { type: "tool_result"; tool: string; ok: boolean; output: string }
  | { type: "tool_interrupt"; tool: string; args: string; call_id: string }
  | { type: "tool_denied"; tool: string; args: string; reason: "user" | "timeout" }
  | { type: "error"; error: unknown }
  | { type: "aborted" };