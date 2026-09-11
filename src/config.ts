/**
 * Configuração de ambiente (spec §2) com fallbacks locais e validação manual
 * (sem dependência extra; Zod fica documentado como caminho de upgrade).
 *
 * As variáveis lidas são:
 * - `OPENAI_BASE_URL`    — URL base da API compatível com a OpenAI (default: `http://localhost:11434/v1`)
 * - `OPENAI_API_KEY`     — chave de API (default: `ollama`, o valor que o Ollama aceita)
 * - `OPENAI_MAX_RETRIES` — tentativas do cliente HTTP (default: `5`, inteiro >= 0)
 *
 * @module config
 */

const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_API_KEY = "ollama";
const DEFAULT_MAX_RETRIES = 5;

/**
 * Configuração do runtime derivada do ambiente.
 *
 * Consumida por {@link createClient} para montar o cliente OpenAI.
 *
 * @example
 * ```ts
 * const config: RuntimeConfig = {
 *   baseURL: "http://localhost:11434/v1",
 *   apiKey: "ollama",
 *   maxRetries: 5,
 * };
 * ```
 */
export interface RuntimeConfig {
  /** URL base da API (ex.: `http://localhost:11434/v1` do Ollama). */
  baseURL: string;
  /** Chave de API. O Ollama aceita qualquer valor, por isso o default é `ollama`. */
  apiKey: string;
  /** Número de tentativas do cliente HTTP diante de falhas transientes. */
  maxRetries: number;
}

/**
 * Lê e valida as variáveis de ambiente.
 * Aceita um objeto de env injetado para testes (default: `Deno.env`).
 *
 * Validações aplicadas:
 * - `OPENAI_BASE_URL` precisa ser uma URL `http`/`https` válida.
 * - `OPENAI_API_KEY` não vazia (trim).
 * - `OPENAI_MAX_RETRIES` inteiro >= 0; ausente ou vazia usa o default `5`.
 *
 * @param env Mapa de variáveis de ambiente. Omita para usar `Deno.env`.
 * @returns Configuração validada pronta para o cliente.
 * @throws {Error} Se `OPENAI_BASE_URL` não for uma URL http/https ou
 *                 `OPENAI_MAX_RETRIES` não for um inteiro válido.
 * @example Como usar com o cliente (sem injeção, usa `Deno.env`):
 * ```ts
 * import { loadRuntimeConfig } from "./src/config.ts";
 * const runtime = loadRuntimeConfig();
 * console.log(runtime.baseURL); // "http://localhost:11434/v1" (default)
 * ```
 *
 * @example Teste com env injetado:
 * ```ts
 * const config = loadRuntimeConfig({
 *   OPENAI_BASE_URL: "https://api.openai.com/v1",
 *   OPENAI_API_KEY: "sk-...",
 *   OPENAI_MAX_RETRIES: "2",
 * });
 * assertEquals(config.maxRetries, 2);
 * ```
 */
export function loadRuntimeConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): RuntimeConfig {
  const baseURL = env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error(`OPENAI_BASE_URL inválida: "${baseURL}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`OPENAI_BASE_URL deve usar http/https: "${baseURL}"`);
  }

  const apiKey = env.OPENAI_API_KEY?.trim() || DEFAULT_API_KEY;

  const rawRetries = env.OPENAI_MAX_RETRIES?.trim();
  let maxRetries = DEFAULT_MAX_RETRIES;
  if (rawRetries) {
    const value = Number(rawRetries);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`OPENAI_MAX_RETRIES inválida: "${rawRetries}" (esperado inteiro >= 0)`);
    }
    maxRetries = value;
  }

  return { baseURL, apiKey, maxRetries };
}