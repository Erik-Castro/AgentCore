/**
 * Barrel do harness ReAct — API pública do futuro core do OllamaTask.
 *
 * Ponto único de importação: tipos, config, cliente, eventos, ferramentas,
 * a classe {@link ReAct} e a poda por LLM (`createLLMSummarizer`).
 *
 * @example Uso de alto nível (Ollama local):
 * ```ts
 * import {
 *   ReAct,
 *   createLLMSummarizer,
 *   type AgentEvent,
 *   type TExecutionResult,
 *   type Tool,
 * } from "./src/mod.ts";
 *
 * const sumTool: Tool = {
 *   name: "sum",
 *   description: "Soma dois números inteiros.",
 *   parameters: {
 *     type: "object",
 *     properties: { a: { type: "integer" }, b: { type: "integer" } },
 *     required: ["a", "b"],
 *   },
 *   execute: ({ a, b }) => String(Number(a) + Number(b)),
 * };
 *
 * const agent = new ReAct({
 *   model: "qwen3:4b",
 *   system_prompt: "Use a ferramenta sum quando precisar somar.",
 *   maxRounds: 4,
 * }, {
 *   summarizer: createLLMSummarizer(callLLM), // poda por LLM (§B) — opcional
 * });
 * agent.registryTool(sumTool);
 *
 * const events: AgentEvent[] = [];
 * let result: TExecutionResult;
 * for (;;) {
 *   const { done, value } = await agent.run("Quanto é 21 + 21?").next();
 *   if (done) { result = value; break; }
 *   events.push(value);
 * }
 * console.log(result.content.content, result.toolCalls);
 * ```
 * @module mod
 */
export * from "./types.ts";
export * from "./config.ts";
export * from "./client.ts";
export * from "./events.ts";
export * from "./tools.ts";
export {
  ReAct,
  type ReActOptions,
  type ResponsesCall,
  type ResponsesCallRequest,
} from "./react.ts";
export {
  createLLMSummarizer,
  SUMMARIZER_INSTRUCTIONS,
  type SummarizeContext,
  type Summarizer,
} from "./summarizer.ts";