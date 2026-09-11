/**
 * Registro e execução segura de ferramentas (spec §6.1/§6.3).
 *
 * `executeSafe` nunca lança: retorna `ToolResult` com `ok:false` + mensagem,
 * o que alimenta a camada de auto-correção (suggests.md §C). A validação de
 * parâmetros é um JSON Schema mínimo sem dependências (Zod fica como upgrade).
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

/** Valida um valor contra um JSON Schema; retorna os problemas encontrados. */
export function validateParams(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = [];
  evaluate(value, schema, "$", errors);
  return errors;
}

/** Converte uma Tool do harness para o formato do SDK (FunctionTool). */
export function toOpenAITool(tool: Tool): Responses.Tool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? null,
    strict: false,
  };
}

export class ToolRegistry {
  private readonly _tools = new Map<string, Tool>();

  /** Registra uma ferramenta (spec §5 `registryTool`). Lança em duplicata. */
  register(tool: Tool): this {
    if (this._tools.has(tool.name)) {
      throw new Error(`Ferramenta já registrada: "${tool.name}"`);
    }
    this._tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this._tools.get(name);
  }

  list(): Tool[] {
    return [...this._tools.values()];
  }

  names(): string[] {
    return [...this._tools.keys()];
  }

  /**
   * Executa com sandboxing: parse de JSON, validação de schema e try/catch.
   * Nunca lança — falhas viram `{ ok:false, error }` para o self-healing.
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