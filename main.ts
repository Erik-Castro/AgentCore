/**
 * Demo do harness ReAct contra um LLM local (Ollama).
 *
 * Espelha a API atual do harness v1 (src/): `run()` como gerador assíncrono
 * de eventos (com o `TExecutionResult` no `return`), self-healing (§C), gestão
 * de contexto por tokens com poda por LLM (§B) e HITL com aprovação humana (§D).
 *
 * Uso:
 *   deno task dev -- "Que horas são? Depois apague o registro 42."
 *
 * Pré-requisitos: Ollama em http://localhost:11434 e um modelo de raciocínio
 * (default: nemotron-3-nano:30b-cloud), selecionado via OPENAI_MODEL.
 */
import {
  ReAct,
  createClient,
  createLLMSummarizer,
  loadRuntimeConfig,
  type ResponsesCall,
  type TExecutionResult,
  type Tool,
} from "./src/mod.ts";
import type { Responses } from "openai/resources/responses";
import { z } from "zod";

const prompt = Deno.args.join(" ") ??
  "Que horas são agora? Depois, apague o registro 42 do banco.";
const model = Deno.env.get("OPENAI_MODEL") ?? "nemotron-3-nano:30b-cloud";

const currentTimeTool: Tool = {
  name: "current_time",
  description: "Retorna a data e a hora atuais em formato ISO 8601.",
  parameters: z.object({}).strict(),
  execute: () => new Date().toISOString(),
};

const deleteRecordTool: Tool = {
  name: "delete_record",
  description: "Apaga um registro informando o id (requer aprovação humana).",
  parameters: z.object({ id: z.number().int().describe("Id do registro") }).strict(),
  execute: ({ id }) => `Registro ${id} apagado.`,
  sensitive: true, // HITL (§D): o loop pausa até resume(true|false)
};

// Transporte compartilhado: o loop ReAct E o sumarizador (§B) usam o mesmo
// provider real (Ollama via SDK), para a poda por LLM reusar o modelo.
const client = createClient(loadRuntimeConfig());
const responses: ResponsesCall = (request) =>
  client.responses.create(
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

const agent = new ReAct(
  {
    model,
    thinking: "max",
    system_prompt:
      `Você é um assistente ReAct direto. Use current_time para saber a hora 
      atual e delete_record somente quando pedirem para apagar algo.`,
    maxRounds: 6,
  },
  {
    responses,                                       // provider real (Ollama)
    maxContextTokens: 32_768,                        // janela: condensa acima de ~80% (§B)
    summarizer: createLLMSummarizer(responses),      // poda do histórico por LLM (§B, opt-in)
    approvalTimeoutMs: 30_000,                       // HITL: sem resposta, auto-recusa (§D)
  },
);
agent.registryTool(currentTimeTool);
agent.registryTool(deleteRecordTool);

console.log(`\x1b[36m[user]\x1b[0m ${prompt}\n\x1b[36m[agent]\x1b[0m `);

// run() é um gerador assíncrono: emite eventos em tempo real e, no `done`,
// devolve o TExecutionResult (tokens, tempo, rounds, calls, summaries).
const generator = agent.run(prompt);
let result: TExecutionResult | undefined;
for (;;) {
  const { done, value } = await generator.next();
  if (done) {
    result = value;
    break;
  }
  switch (value.type) {
    case "reasoning":
      Deno.stdout.writeSync(new TextEncoder().encode(`\x1b[32m${value.token}\x1b[0m`));
      break;

    case "reasoning.done":
      Deno.stdout.writeSync(new TextEncoder().encode("\n"));
      break;

    case "content":
      Deno.stdout.writeSync(new TextEncoder().encode(value.token));
      break;

    case "content.done":
      Deno.stdout.writeSync(new TextEncoder().encode("\n"));
      break;

    case "tool_call":
      console.log(`\x1b[33m[chamando] ${value.tool}(${value.args})\x1b[0m`);
      break;

    case "tool_result":
      if (value.ok) {
        console.log(`\x1b[32m[resultado] ${value.output}\x1b[0m`);
      } else {
        // Falha volta ao contexto como mensagem de sistema (self-healing §C).
        console.log(`\x1b[31m[falha] ${value.output}\x1b[0m`);
      }
      break;

    case "tool_interrupt":
      // HITL (§D): o agente pausou (agent.state === "paused"). A decisão
      // desbloqueia via resume(true|false) — aqui vem do terminal (confirm).
      console.log(`\x1b[35m[aprovação] ${value.tool}(${value.args})\x1b[0m`);
      agent.resume(confirm(`Permitir ${value.tool}(${value.args})?`));
      break;

    case "tool_denied":
      console.log(`\x1b[31m[recusada] ${value.tool} (motivo: ${value.reason})\x1b[0m`);
      break;

    case "error":
      console.error("\x1b[31m[erro]\x1b[0m", value.error);
      break;

    case "aborted":
      console.log("\x1b[31m[abortado por cancel()]\x1b[0m");
      break;
  }
}

console.log(
  `\n\n\x1b[36m[resumo]\x1b[0m estado=${agent.state} rounds=${agent.rounds} ` +
    `calls=${agent.toolCalls} summaries=${agent.summaries}`,
);
console.log(JSON.stringify(result, null, 2));