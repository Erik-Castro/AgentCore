/**
 * Fábrica do cliente OpenAI (spec §2) — única dependência do projeto.
 * Comunica com APIs compatíveis com a OpenAI (ex.: Ollama em /v1/responses).
 */
import OpenAI from "openai";
import type { RuntimeConfig } from "./config.ts";
export type { RuntimeConfig };

export function createClient(config: RuntimeConfig): OpenAI {
  return new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    maxRetries: config.maxRetries,
  });
}