export const RoleSystem = "system" as const;
export const RoleUser = "user" as const;
export const RoleAssistant = "assistant" as const;

export type Role =
  | typeof RoleSystem
  | typeof RoleUser
  | typeof RoleAssistant;

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface Message {
  readonly role: Role;
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonValue;
}

export interface ToolResult {
  readonly toolCallId: string;
  readonly output: string;
  readonly isError: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly [key: string]: JsonValue };
}
