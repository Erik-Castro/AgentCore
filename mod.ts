/**
 * Entrypoint do harness ReAct como **biblioteca local** (a raiz do pacote).
 *
 * Reexporta toda a API pública de `src/` num único ponto de importação.
 * Para usar em outro módulo do repositório (ou de fora, via caminho):
 *
 * ```ts
 * import { ReAct, createLLMSummarizer } from "agentcore";
 *
 * const agent = new ReAct({
 *   model: "qwen3:4b",
 *   system_prompt: "Você é um assistente.",
 *   maxRounds: 6,
 * });
 *
 * const result = await collect(agent.run("Olá!"));
 * ```
 *
 * O `deno.json` mapeia o bare specifier `agentcore` para este arquivo e
 * declara `name`/`version`/`exports`, pronto para publicação futura.
 *
 * @module agentcore
 */
export * from "./src/mod.ts";