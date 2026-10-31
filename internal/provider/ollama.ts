import type { Message, ToolDefinition } from "../schema/message.js";
import type { LLMProvider } from "./interface.js";
import { OpenAIProvider } from "./openai.js";

export interface OllamaProviderConfig {
  readonly model: string;
  readonly baseURL: string;
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
}

export class OllamaProvider implements LLMProvider {
  private readonly provider: OpenAIProvider;

  constructor(config: OllamaProviderConfig) {
    if (!config.model.trim()) {
      throw new Error("Ollama model must not be empty");
    }
    let url: URL;
    try {
      url = new URL(config.baseURL);
    } catch {
      throw new Error("Ollama baseURL must be an absolute HTTP localhost URL");
    }
    const isLoopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    if (
      url.protocol !== "http:" ||
      !isLoopback ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Ollama baseURL must be an HTTP localhost URL without credentials, query, or fragment");
    }
    this.provider = new OpenAIProvider({
      model: config.model.trim(),
      baseURL: url.toString().replace(/\/+$/u, ""),
      // The OpenAI SDK requires a key; local Ollama does not validate it.
      apiKey: config.apiKey?.trim() || "ollama",
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  }

  generate(
    signal: AbortSignal,
    messages: readonly Message[],
    availableTools: readonly ToolDefinition[],
  ): Promise<Message> {
    return this.provider.generate(signal, messages, availableTools);
  }
}
