# AgentCore

Motor (harness) para agentes **ReAct** com **LLMs locais** — planejado e implementado neste estudo para servir de núcleo do projeto externo [OllamaTask](https://github.com/Erik-Castro/OllamaTask).

> Este é um **repositório de estudo/planejamento**, não uma aplicação final. Os entregáveis são as especificações de arquitetura e uma implementação de referência para validar as ideias (a "v1" em `src/`).

## O que se trata este estudo

O objetivo é desenhar e validar um harness enxuto que explore os pontos fortes de modelos locais (Ollama) e o padrão **ReAct** (Pensar → Agir → Observar) usando a **Responses API** via SDK `openai` compatível, executado em **Deno**. O resultado alimenta melhorias arquiteturais no OllamaTask com base em evidência (código + testes), não em achismo.

### Stack
- **Deno 2.x** + TypeScript
- **`npm:openai@^7.15.0`** como única dependência de runtime
- **Ollama** como backend local (streaming-first via `client.responses.create({ stream: true })`)

### Por que baseado em spec?
A arquitetura está documentada em dois artefatos de design:

| Documento | Papel |
|---|---|
| [`spec.md`](spec.md) | Spec autoritativa: tipos, ciclo de vida, callbacks e modelo de streaming |
| [`suggests.md`](suggests.md) | Propostas de melhoria: geradores assíncronos, poda de contexto, self-healing e HITL |
| [`planejamento/main.ts`](planejamento/main.ts) | Esboço original de planejamento (intencionalmente não compila — use `spec.md` como referência) |

## Implementação v1 (`src/`)

A `src/` é uma implementação funcional da spec que valida as propostas:

- **`ReAct.run(prompt)`** é um *async generator*: emite `AgentEvent` em tempo real (raciocínio, conteúdo, chamadas de tool) e retorna `TExecutionResult` (uso de tokens, tempo, rounds, calls).
- **Self-healing (§C)**: falha de tool (JSON inválido, schema violado, tool desconhecida) nunca quebra o agente — o erro volta ao contexto como mensagem de sistema e o modelo tenta de novo.
- **Gestão de contexto (§B)**: limites determinísticos de itens/caracteres impedem contexto infinito; **opt-in** para condensar o histórico antigo por LLM (`ReActOptions.summarizer`) mantendo as últimas interações intactas, com a poda determinística como *safety net*.
- **HITL (§D)**: tools marcadas `sensitive: true` pausam o agente (`state === "paused"`) emitindo `tool_interrupt`; a decisão chega via `resume(true|false)`. Com `approvalTimeoutMs` configurado, a decisão expira sozinha (`tool_denied` com `reason: "timeout"`) — consumidor sumido não trava o agente. `resume(true, params)` aprova com parâmetros ajustados (override revalidado pelo schema).
- **`cancel()`** (AbortController) e **`reset()`** para lifecycle gracioso.
- **Provider injetável**: os testes rodam 100% offline com um provider fake, sem rede.

### Exemplo de uso

```ts
import { ReAct } from "./src/mod.ts";

const agent = new ReAct({
  model: "qwen3:4b",
  system_prompt: "Você é um assistente de operações.",
  maxRounds: 6,
});

agent.registryTool({
  name: "current_time",
  description: "Retorna a hora atual.",
  execute: () => new Date().toISOString(),
});

for await (const event of agent.run("Qual a hora agora?")) {
  if (event.type === "content") process.stdout.write(event.token);
}
```

Com HITL (aprovação humana):

```ts
const agent = new ReAct(
  { model: "qwen3:4b", system_prompt: "...", maxRounds: 6 },
  { approvalTimeoutMs: 30_000 }, // sem resposta, auto-recusa (§D avançado)
);

for await (const event of agent.run("Apague o registro 42")) {
  if (event.type === "tool_interrupt") {
    const ok = confirm(`Permitir ${event.tool}(${event.args})?`);
    if (ok) {
      const alvo = prompt("Alvo alterado? (Enter mantém)") ?? "";
      agent.resume(true, alvo ? { target: alvo } : undefined); // override
    } else {
      agent.resume(false);
    }
  }
}
```

Com poda de contexto por LLM (opt-in):

```ts
import { ReAct, createLLMSummarizer } from "./src/mod.ts";

const agent = new ReAct(
  { model: "qwen3:4b", system_prompt: "...", maxRounds: 8 },
  { summarizer: createLLMSummarizer(responses) }, // condensa o histórico antigo (§B)
);
```

## Como rodar

```bash
deno task dev     # demo interativa contra o Ollama local (main.ts)
deno task check   # typecheck de main.ts + src/mod.ts
deno task test    # suíte offline (37 testes): eventos, tools, loop ReAct e summarizer
```

Defaults sem env: `OPENAI_BASE_URL=http://localhost:11434/v1`, `OPENAI_API_KEY=ollama`, retries 5.

## Roadmap (próximas fases)

- **Trigger por tokens reais**: hoje a poda usa itens/caracteres como proxy (não há tokenizador offline)
- **Validação com Zod** (hoje a validação é manual)
- **Testes de integração** com Ollama local de ponta a ponta

## Referências

- [OllamaTask](https://github.com/Erik-Castro/OllamaTask) — projeto que este estudo pretende melhorar
- [`AGENTS.md`](AGENTS.md) — notas operacionais e deviações deliberadas da implementação