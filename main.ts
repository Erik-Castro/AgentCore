/**
 * Demo do harness ReAct contra um LLM local (Ollama).
 *
 * Uso:
 *   deno task dev -- "O que é um agente ReAct?"   (com Ollama rodando)
 *
 * Pré-requisitos: Ollama em http://localhost:11434 e um modelo de raciocínio
 * (ex.: qwen3:4b, chamado via OPENAI_MODEL ou o default abaixo).
 */
import { ReAct, type Tool } from "./src/mod.ts";

const prompt = Deno.args[0] ??
  "Explique, em uma frase, o que é um agente ReAct e por que o streaming importa.";
const model = Deno.env.get("OPENAI_MODEL") ?? "qwen3:4b";

const currentTimeTool: Tool = {
  name: "current_time",
  description: "Retorna a data e a hora atuais em formato ISO 8601.",
  parameters: {
    type: "object",
    properties: {},
  },
  execute: () => new Date().toISOString(),
};

const agent = new ReAct({
  model,
  thinking: "low",
  system_prompt:
    "Você é um assistente ReAct direto. Sempre que precisar da hora atual, " +
    "use a ferramenta current_time antes de responder.",
  maxRounds: 4,
});
agent.registryTool(currentTimeTool);

agent.onReasoning((token) => {
  Deno.stdout.writeSync(new TextEncoder().encode(`\x1b[90m${token}\x1b[0m`));
});
agent.onContent((token) => {
  Deno.stdout.writeSync(new TextEncoder().encode(token));
});

console.log(`\x1b[36m[user]\x1b[0m ${prompt}\n\x1b[36m[agent]\x1b[0m `);

const result = await agent.run(prompt);

console.log(`\n\n\x1b[36m[resumo]\x1b[0m`);
console.log(JSON.stringify(result, null, 2));