# AgentCore

Motor (harness) para agentes **ReAct** com **LLMs locais** — planejado e implementado neste estudo para servir de núcleo do projeto externo [OllamaTask](https://github.com/Erik-Castro/OllamaTask).

> Este é um **repositório de estudo/planejamento**, não uma aplicação final. Os entregáveis são as especificações de arquitetura e uma implementação de referência para validar as ideias (a "v1" em `src/`).

## O que se trata este estudo

O objetivo é desenhar e validar um harness enxuto que explore os pontos fortes de modelos locais (Ollama) e o padrão **ReAct** (Pensar → Agir → Observar) usando a **Responses API** via SDK `openai` compatível, executado em **Deno**. O resultado alimenta melhorias arquiteturais no OllamaTask com base em evidência (código + testes), não em achismo.

### Stack
- **Deno 2.x** + TypeScript
- **`npm:openai@^7.15.0`** (SDK compatível) e **`npm:zod@^4`** (validação) como dependências de runtime
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
- **Gestão de contexto (§B)**: limites determinísticos de itens/caracteres impedem contexto infinito; **opt-in** para condensar o histórico antigo por LLM (`ReActOptions.summarizer`) mantendo as últimas interações intactas, com a poda determinística como *safety net*. **Trigger por tokens** (`maxContextTokens`): usa o `usage.input_tokens` real do provider (fallback: estimativa `~4 chars/token` injetável) e dispara aos ~80% da janela (`contextTokenRatio`).
- **Paralelismo orquestrado (§C)**: request leva `parallel_tool_calls` (default `true`); tools **não sensíveis** de um round rodam em lote (`Promise.all`), resultados cacheados por `call_id` e aplicados na **passada sequencial** — ordem/eventos determinísticos por construção, não por `flock`. Sensitive/HITL seguem sequenciais (§D). (**Gotcha validado por probe neste runtime**: `Deno.open({ lock:true })` **não** serializa duas aberturas do mesmo arquivo dentro do mesmo processo — o flock é *advisory*/best-effort entre processos. A ordem determinística vem do harness, não do lock.)
- **Workspace persistente (§E)**: opcional `ReActOptions.workspaceDir` — cada `run()` cria subdir efêmero `0o700` (`src/env.ts`: `createWorkspace`/`createRunWorkspace`/`withFileLock`/`appendLineLocked`) e grava `run.log` (JSON por linha, com flock + newline) registrando cada execução de ferramenta; o caminho do workspace sai como `TExecutionResult.workspace`. Offline: os testes de FS usam workspaces reais (`src/env_test.ts`, offline) e recursos nativos (`Deno.makeTempDir({mode})`, flock).
- **Validação por Zod**: `Tool.parameters` é um schema Zod (v4) tipado — o `executeSafe` valida com `safeParse`, o `toOpenAITool` converte para JSON Schema via `z.toJSONSchema()` e o `loadRuntimeConfig` também valida o env (coercion, trim e `http/https`).
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
  {
    summarizer: createLLMSummarizer(responses), // condensa o histórico antigo (§B)
    maxContextTokens: 32_768, // janela do modelo: condensa ao passar de ~80%
  },
);
```

## Como rodar

```bash
deno task dev       # demo interativa contra o Ollama local (main.ts)
deno task check     # typecheck de main.ts + mod.ts + src/mod.ts
deno task test      # suíte offline (56 testes): eventos, tools, loop ReAct, tokens, config e summarizer
deno task test:int  # integração E2E contra o Ollama local (precisa servidor + modelo)
```

Defaults sem env: `OPENAI_BASE_URL=http://localhost:11434/v1`, `OPENAI_API_KEY=ollama`, retries 5.
Os testes de integração (`test:int`) usam o modelo `nemotron-3-nano:30b-cloud` por
default — troque com `OPENAI_MODEL`. Sem Ollama de pé ou sem o modelo instalado,
eles falham com uma mensagem clara (não falham "no susto").

## Uso como biblioteca local

O entrypoint é o `mod.ts` na raiz (mapeado pelo `deno.json` como `agentcore`,
já com `name`/`version`/`exports` para publicação futura):

```ts
import { ReAct, createLLMSummarizer } from "agentcore";

const agent = new ReAct({
  model: "qwen3:4b",
  system_prompt: "Você é um assistente.",
  maxRounds: 6,
});
```

## Roadmap (próximas fases)

Fases planejadas concluídas: gerador assíncrono, self-healing, poda de contexto
(com trigger por tokens), HITL, validação Zod e testes de integração com Ollama
local de ponta a ponta. Próximos passos possíveis: levar o harness ao OllamaTask
com base no que foi validado aqui.

## Referências

- [OllamaTask](https://github.com/Erik-Castro/OllamaTask) — projeto que este estudo pretende melhorar
- [`AGENTS.md`](AGENTS.md) — notas operacionais e deviações deliberadas da implementação