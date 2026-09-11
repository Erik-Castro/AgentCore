/**
 * Configuração de ambiente (spec §2) com fallbacks locais e validação manual
 * (sem dependência extra; Zod fica documentado como caminho de upgrade).
 */

const DEFAULT_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_API_KEY = "ollama";
const DEFAULT_MAX_RETRIES = 5;

/** Configuração do runtime derivada do ambiente. */
export interface RuntimeConfig {
  baseURL: string;
  apiKey: string;
  maxRetries: number;
}

/**
 * Lê e valida as variáveis de ambiente.
 * Aceita um objeto de env injetado para testes (default: Deno.env).
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