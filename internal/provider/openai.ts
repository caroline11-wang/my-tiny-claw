import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  JsonValue,
  Message,
  ToolCall,
  ToolDefinition,
} from "../schema/message.js";
import { RoleAssistant, RoleSystem, RoleUser } from "../schema/message.js";
import type { LLMProvider } from "./interface.js";

export interface OpenAIProviderConfig {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
  readonly fetch?: typeof fetch;
}

export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;

  constructor(private readonly config: OpenAIProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      fetch: config.fetch,
      maxRetries: 0,
    });
  }

  async generate(
    signal: AbortSignal,
    messages: readonly Message[],
    availableTools: readonly ToolDefinition[],
  ): Promise<Message> {
    const requestMessages: ChatCompletionMessageParam[] = messages.map(
      (message): ChatCompletionMessageParam => {
        if (message.role === RoleSystem) {
          return { role: "system", content: message.content };
        }
        if (message.role === RoleUser && message.toolCallId) {
          return {
            role: "tool",
            tool_call_id: message.toolCallId,
            content: message.content,
          };
        }
        if (message.role === RoleUser) {
          return { role: "user", content: message.content };
        }
        return {
          role: "assistant",
          content: message.content || null,
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                })),
              }
            : {}),
        };
      },
    );
    const tools: ChatCompletionTool[] = availableTools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const response = await this.client.chat.completions.create(
      {
        model: this.config.model,
        messages: requestMessages,
        ...(tools.length ? { tools } : {}),
      },
      { signal },
    );
    const choice = response.choices[0];
    if (!choice) {
      throw new Error("OpenAI-compatible API returned no completion choices");
    }

    const toolCalls: ToolCall[] = [];
    for (const call of choice.message.tool_calls ?? []) {
      if (call.type !== "function") {
        throw new Error(`Unsupported OpenAI tool call type: ${call.type}`);
      }
      toolCalls.push({
        id: call.id,
        name: call.function.name,
        arguments: parseArguments(call.function.arguments),
      });
    }

    return {
      role: RoleAssistant,
      content: choice.message.content ?? "",
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }
}

function parseArguments(value: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Tool call arguments contain invalid JSON", {
      cause: error,
    });
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Tool call arguments must be a JSON object");
  }
  return parsed as { readonly [key: string]: JsonValue };
}
