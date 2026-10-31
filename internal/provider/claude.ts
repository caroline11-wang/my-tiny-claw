import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import type { JsonValue, Message, ToolCall, ToolDefinition } from "../schema/message.js";
import { RoleAssistant, RoleSystem, RoleUser } from "../schema/message.js";
import type { LLMProvider } from "./interface.js";

export interface ClaudeProviderConfig {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
  readonly fetch?: typeof fetch;
  readonly maxTokens?: number;
}

export class ClaudeProvider implements LLMProvider {
  private readonly client: Anthropic;

  constructor(private readonly config: ClaudeProviderConfig) {
    this.client = new Anthropic({
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
    const system = messages
      .filter((message) => message.role === RoleSystem)
      .map((message) => message.content)
      .join("\n\n");
    const requestMessages: MessageParam[] = messages.flatMap(
      (message): MessageParam[] => {
        if (message.role === RoleSystem) return [];
        if (message.role === RoleUser && message.toolCallId) {
          const content: ContentBlockParam[] = [{
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: message.content,
          }];
          return [{ role: "user", content }];
        }
        if (message.role === RoleUser) {
          return [{ role: "user", content: message.content }];
        }

        const content: ContentBlockParam[] = [];
        if (message.content) {
          content.push({ type: "text", text: message.content });
        }
        for (const call of message.toolCalls ?? []) {
          content.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: asObject(call.arguments),
          });
        }
        return content.length ? [{ role: "assistant", content }] : [];
      },
    );
    const tools: Tool[] = availableTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        ...tool.inputSchema,
        type: "object",
      },
    }));

    const response = await this.client.messages.create(
      {
        model: this.config.model,
        max_tokens: this.config.maxTokens ?? 4096,
        messages: requestMessages,
        ...(system ? { system } : {}),
        ...(tools.length ? { tools } : {}),
      },
      { signal },
    );

    const content = response.content.reduce(
      (text, block) => block.type === "text" ? text + block.text : text,
      "",
    );
    const toolCalls: ToolCall[] = response.content.flatMap((block) => {
      if (block.type !== "tool_use") return [];
      return [{
        id: block.id,
        name: block.name,
        arguments: asObject(block.input),
      }];
    });

    return {
      role: RoleAssistant,
      content,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }
}

function asObject(value: JsonValue | unknown): {
  readonly [key: string]: JsonValue;
} {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Tool input must be a JSON object");
  }
  return value as { readonly [key: string]: JsonValue };
}
