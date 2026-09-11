# AGENTS.md

## What this repo is

A **study/planning repo** (pt-BR docs), not an application. The goal is designing a ReAct agent "harness" for local LLMs (Ollama + OpenAI-compatible SDK, Deno runtime) to later feed improvements into the external project [OllamaTask](https://github.com/Erik-Castro/OllamaTask). The actionable deliverables are the docs, not the code.

## High-signal gotchas

- **`planejamento/main.ts` does not compile on purpose.** It's a hand-written planning sketch: it has a syntax error (`cancler` on line 75), typos (`contructor`, `thinkinkg`, `ExxecutionResult`), and references an undefined `_messages`. `deno check planejamento/main.ts` fails. Do **not** treat it as broken production code — do not silently "fix" it. If you need corrected reference types, use `spec.md` (it fixes every typo from the sketch).
- **The real harness lives in `src/`** (implemented; see "Implementation notes" below). `planejamento/` is just the original planning sketch.
- **`deno task dev` works from the repo root**: it runs `deno run --allow-net --allow-env --watch main.ts`. `deno task check` runs `deno check main.ts src/mod.ts`; `deno task test` runs `deno test` (all tests are offline, no network — they inject a fake `responses` provider).
- **Not a git repository.** No commits, branches, or PR workflows here.
- **Docs are in Brazilian Portuguese** (`spec.md`, `suggests.md`, `planejamento/main.ts` header). Keep any doc edits in pt-BR to stay consistent.

## Environment & runtime facts (keep consistent in any code)

- Deno 2.x, TypeScript, single dependency: `npm:openai@^7.15.0` (via `deno.json` `imports`, imported as `import OpenAI from "openai"`).
- Defaults when env vars are absent: `OPENAI_BASE_URL=http://localhost:11434/v1`, `OPENAI_API_KEY=ollama`; client uses `maxRetries: 5`.
- Streaming-first via `client.responses.create({ stream: true })` + `signal`. **Real SDK v7 stream events** (spec §4 names are fictional): `response.reasoning_summary_text.delta/.done`, `response.reasoning_text.delta/.done`, `response.output_text.delta/.done`, `response.output_item.added/.done`, `response.function_call_arguments.delta`, `response.completed` (holds `usage`), `error`/`response.failed`/`response.incomplete`.

## Implementation notes (harness v1, in `src/`)

- `ReAct.run(prompt)` is an **async generator** `AsyncGenerator<AgentEvent, TExecutionResult, void>` (suggests.md §3A) with the spec §5 callbacks (`onToolCalling`, `onToolResponse`, `onReasoning`, `onContent`) as a thin façade. Scope: core loop + self-healing tool calling (§C) + simple deterministic context pruning (§B reduced). LLM summarization is deferred.
- Provider is injectable (`ReActOptions.responses`) for offline tests; `cancel()` aborts via `AbortController`; `reset()` clears history; `maxRounds` + `prune()` (splice oldest, min 2 kept, bounded by `maxContextItems`/`maxContextChars`) prevent unbounded loops.
- Self-healing: `ToolRegistry.executeSafe` never throws — returns `{ok:false,error}` for unknown tools/malformed JSON/non-object args/schema violations; the loop injects a system message with the error and continues.
- **HITL (suggests.md §D) is active**: a `Tool` with `sensitive: true` makes `run()` yield `tool_interrupt` and pause (`state === "paused"`) until `resume(true|false)`. `true` executes normally; `false` does NOT execute, injects a `function_call_output` with the denial (keeps history consistent, same shape as §C) and yields `tool_denied`. `cancel()` while paused resolves the pending approval as denied → generator ends with `aborted`, no deadlock. `resume()` with no pending approval throws. Deviations: no param override on approval and no decision timeout (both documented as upgrade path).
- **Deviations from the docs** (deliberate): real delta event names replace spec §4's hypothetical ones; `Tool.execute` receives a *parsed* params object (not JSON string); env vars validated manually (no Zod — documented as an upgrade path); `system_prompt` is sent via the `instructions` request param (keeps it out of message history); `TExecutionResult` is additive-extended with `rounds` and `toolCalls`; errors become `error` events (never thrown through the generator).
- **Type-import rule**: use `import type { Responses } from "openai/resources/responses"` and qualify with `Responses.` directly. A local type alias (`type R = Responses`) CANNOT be used for qualified names (`R.ResponseStreamEvent` fails). Same applies to `OpenAI.Responses` via alias.

## Workflow conventions

- Design docs (`spec.md`, `suggests.md`) are user-provided content. Don't rewrite their substance; treat `spec.md` as the authoritative spec for anything that needs to be implemented.
- If asked to implement the harness, build from `spec.md`, not from the sketch in `planejamento/main.ts`.