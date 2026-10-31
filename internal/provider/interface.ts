import type { Message, ToolDefinition } from "../schema/message.js";

export interface LLMProvider {
  generate(
    signal: AbortSignal,
    messages: readonly Message[],
    availableTools: readonly ToolDefinition[],
  ): Promise<Message>;
}
