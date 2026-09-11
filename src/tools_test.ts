/**
 * Testes do registro e execução segura de ferramentas (src/tools.ts) — offline.
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { ToolRegistry, validateParams } from "./tools.ts";
import type { Tool } from "./types.ts";

const echo: Tool = {
  name: "echo",
  description: "Repete o texto.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string" },
      times: { type: "integer" },
      loud: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      level: { type: "string", enum: ["low", "high"] },
    },
    required: ["text"],
  },
  execute: (params) => params["text"] as string,
};

Deno.test("registra e lista ferramentas", () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  assertEquals(registry.list().map((t) => t.name), ["echo"]);
  assertEquals(registry.get("echo"), echo);
});

Deno.test("rejeita registro duplicado", () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  assertThrows(() => registry.register(echo), Error, "já registrada");
});

Deno.test("executeSafe: ferramenta desconhecida não lança", async () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  const res = await registry.executeSafe("nope", "{}");
  assertEquals(res.ok, false);
  assertEquals(res.error?.includes("Ferramenta desconhecida"), true);
});

Deno.test("executeSafe: JSON malformado vira erro estruturado", async () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  const res = await registry.executeSafe("echo", "{nao-e-json");
  assertEquals(res.ok, false);
  assertEquals(res.error?.includes("JSON inválido"), true);
});

Deno.test("executeSafe: parâmetros fora de objeto JSON", async () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  assertEquals((await registry.executeSafe("echo", '"texto"')).ok, false);
  assertEquals((await registry.executeSafe("echo", "42")).ok, false);
  assertEquals((await registry.executeSafe("echo", "null")).ok, false);
});

Deno.test("executeSafe: validação de schema (required/tipos/enum)", async () => {
  const registry = new ToolRegistry();
  registry.register(echo);

  const missing = await registry.executeSafe("echo", "{}");
  assertEquals(missing.ok, false);
  assertEquals(missing.error?.includes("$.text: obrigatório"), true);

  const wrongType = await registry.executeSafe("echo", '{"text": 42}');
  assertEquals(wrongType.ok, false);
  assertEquals(wrongType.error?.includes("tipo inválido"), true);

  const badEnum = await registry.executeSafe("echo", '{"text": "a", "level": "x"}');
  assertEquals(badEnum.ok, false);
  assertEquals(badEnum.error?.includes("fora do enum"), true);
});

Deno.test("executeSafe: execução bem-sucedida com params parseados", async () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  const ok = await registry.executeSafe("echo", '{"text":"oi"}');
  assertEquals(ok, { ok: true, output: "oi" });
});

Deno.test("executeSafe: erro de execução vira erro estruturado", async () => {
  const flaky: Tool = {
    name: "flaky",
    description: "Falha sempre.",
    execute: () => {
      throw new Error("boom da tool");
    },
  };
  const registry = new ToolRegistry();
  registry.register(flaky);
  const res = await registry.executeSafe("flaky", "{}");
  assertEquals(res.ok, false);
  assertEquals(res.error?.includes("boom da tool"), true);
});

Deno.test("validateParams: validação de arrays aninhados", () => {
  const problems = validateParams(
    { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } },
    { tags: [1, "ok"] },
  );
  assertEquals(problems, ["$.tags[0]: tipo inválido (esperado string)"]);
});