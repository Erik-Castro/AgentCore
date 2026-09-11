/**
 * Registro e execução segura de ferramentas (spec §6.1/§6.3).
 *
 * `executeSafe` nunca lança: retorna `ToolResult` com `ok:false` + mensagem,
 * o que alimenta a camada de auto-correção (suggests.md §C). A validação de
 * parâmetros é um JSON Schema mínimo sem dependências (Zod fica como upgrade).
 *
 * @module tools
 */
import type { Responses } from "openai/resources/responses";
import type { JsonSchema, Tool, ToolResult } from "./types.ts";

function typeMatches(value: unknown, type: string | undefined): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

function evaluate(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: string[],
): void {
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${path}: tipo inválido (esperado ${schema.type})`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: valor fora do enum permitido`);
  }
  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    value.forEach((element, index) => {
      evaluate(element, schema.items as JsonSchema, `${path}[${index}]`, errors);
    });
  }
  if (
    schema.type === "object" &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const record = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!(required in record)) {
        errors.push(`${path}.${required}: obrigatório`);
      }
    }
    for (const [name, sub] of Object.entries(schema.properties ?? {})) {
      if (record[name] === undefined) continue;
      evaluate(record[name], sub, `${path}.${name}`, errors);
    }
  }
}

/**
 * Valida um valor contra um JSON Schema; retorna os problemas encontrados.
 *
 * Função pura: não executa nada além da validação recursiva (tipos, enum,
 * required, arrays com `items` e objetos com `properties`).
 *
 * @param schema Schema a aplicar (veja {@link JsonSchema}).
 * @param value Valor a validar.
 * @returns Lista de mensagens de erro; vazia significa valor válido.
 * @example
 * ```ts
 * const schema = {
 *   type: "object",
 *   properties: { nome: { type: "string" }, idade: { type: "integer" } },
 *   required: ["nome"],
 * };
 *
 * validateParams(schema, { nome: "Ana" }); // []
 * validateParams(schema, { idade: 30 });   // ["$.nome: obrigatório"]
 * validateParams(schema, { nome: "Ana", idade: "trinta" });
 * // ["$.idade: tipo inválido (esperado integer)"]
 * ```
 */
export function validateParams(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = [];
  evaluate(value, schema, "$", errors);
  return errors;
}

/**
 * Converte uma `Tool` do harness para o formato do SDK (FunctionTool).
 *
 * Usada pelo loop ReAct para anunciar as ferramentas ao modelo via
 * `tools` na chamada de cada round.
 *
 * @param tool Ferramenta do harness (veja {@link Tool}).
 * @returns Tool no formato `Responses.Tool` (type `"function"`).
 * @example
 * ```ts
 * toOpenAITool(uppercaseTool);
 * // {
 * //   type: "function",
 * //   name: "uppercase",
 * //   description: "Converte texto para maiúsculas.",
 * //   parameters: { type: "object", ... },
 * //   strict: false,
 * // }
 * ```
 */
export function toOpenAITool(tool: Tool): Responses.Tool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? null,
    strict: false,
  };
}

/**
 * Registro de ferramentas do harness (spec §5 `registryTool`).
 *
 * Encapsula um `Map<string, Tool>` por nome. A instância exposta pelo
 * `ReAct` é privada; as ferramentas entram via `ReAct.registryTool(...)`.
 *
 * @example
 * ```ts
 * const registry = new ToolRegistry();
 * registry.register(uppercaseTool); // encadeável
 * registry.names();                 // ["uppercase"]
 * ```
 */
export class ToolRegistry {
  private readonly _tools = new Map<string, Tool>();

  /**
   * Registra uma ferramenta (spec §5 `registryTool`).
   *
   * @param tool Ferramenta a registrar.
   * @returns O próprio registro (encadeamento).
   * @throws {Error} Se já existir uma ferramenta com o mesmo nome.
   * @example
   * ```ts
   * const registry = new ToolRegistry();
   * registry.register({ name: "a", description: "", execute: () => "ok" });
   * registry.register({ name: "a", description: "", execute: () => "ok" });
   * // throws Error: Ferramenta já registrada: "a"
   * ```
   */
  register(tool: Tool): this {
    if (this._tools.has(tool.name)) {
      throw new Error(`Ferramenta já registrada: "${tool.name}"`);
    }
    this._tools.set(tool.name, tool);
    return this;
  }

  /**
   * Obtém uma ferramenta registrada por nome.
   *
   * @param name Nome da ferramenta.
   * @returns A `Tool` ou `undefined` se não registrada.
   */
  get(name: string): Tool | undefined {
    return this._tools.get(name);
  }

  /**
   * Lista todas as ferramentas registradas (ordem de inserção).
   *
   * @returns Array com as ferramentas.
   * @example
   * ```ts
   * registry.list().map((t) => t.name); // ["uppercase", "delete_record"]
   * ```
   */
  list(): Tool[] {
    return [...this._tools.values()];
  }

  /**
   * Lista os nomes das ferramentas registradas.
   *
   * @returns Nomes em ordem de inserção.
   */
  names(): string[] {
    return [...this._tools.keys()];
  }

  /**
   * Executa com sandboxing: parse de JSON, validação de schema e try/catch.
   * Nunca lança — falhas viram `{ ok:false, error }` para o self-healing (§C).
   *
   * Fluxo de validação:
   * 1. Tool existe? (senão `Ferramenta desconhecida`)
   * 2. `argsJson` parseia como objeto? (senão `Argumentos JSON inválidos`)
   * 3. Params passam no JSON Schema? (senão lista de erros)
   * 4. `tool.execute(params)` não lança? (senão `Falha ao executar`)
   *
   * @param name Nome da ferramenta registrada.
   * @param argsJson Argumentos em JSON string (ex.: `'{"text":"oi"}'`).
   * @returns `{ ok:true, output }` ou `{ ok:false, error }`.
   * @example
   * ```ts
   * const ok = await registry.executeSafe("uppercase", '{"text":"oi"}');
   * // { ok: true, output: "OI" }
   *
   * const badJson = await registry.executeSafe("uppercase", "{nope");
   * // { ok: false, error: "Argumentos JSON inválidos: ..." }
   *
   * const badSchema = await registry.executeSafe("uppercase", '{"text":123}');
   * // { ok: false, error: "$.text: tipo inválido (esperado string)" }
   * ```
   */
  async executeSafe(name: string, argsJson: string): Promise<ToolResult> {
    const tool = this._tools.get(name);
    if (!tool) {
      const names = this.names();
      const available = names.length === 0
        ? "nenhuma"
        : names.join(", ");
      const plural = names.length === 1 ? "Disponível" : "Disponíveis";
      return {
        ok: false,
        error: `Ferramenta desconhecida "${name}". ${plural}: ${available}`,
      };
    }

    let params: Record<string, unknown>;
    try {
      params = JSON.parse(argsJson);
    } catch (cause) {
      return { ok: false, error: `Argumentos JSON inválidos: ${(cause as Error).message}` };
    }
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return { ok: false, error: "Os argumentos devem ser um objeto JSON" };
    }

    const problems = validateParams(tool.parameters ?? {}, params);
    if (problems.length > 0) {
      return { ok: false, error: problems.join("; ") };
    }

    try {
      const output = await tool.execute(params);
      return { ok: true, output };
    } catch (cause) {
      return {
        ok: false,
        error: `Falha ao executar: ${(cause as Error).message}`,
      };
    }
  }
}