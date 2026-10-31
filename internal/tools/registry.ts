import type {
  JsonValue,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../schema/message.js";

export interface BaseTool {
  name(): string;
  definition(): ToolDefinition;
  execute(signal: AbortSignal, args: JsonValue): Promise<string>;
}

export interface Registry {
  getAvailableTools(): readonly ToolDefinition[];
  execute(signal: AbortSignal, call: ToolCall): Promise<ToolResult>;
}

export class ToolRegistry implements Registry {
  private readonly tools = new Map<string, BaseTool>();

  register(tool: BaseTool): void {
    const name = tool.name();
    if (this.tools.has(name)) {
      console.error(`[Warning] 工具 '${name}' 已经被注册，将被覆盖。`);
    }
    this.tools.set(name, tool);
    console.error(`[Registry] 成功挂载工具: ${name}`);
  }

  getAvailableTools(): readonly ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition());
  }

  async execute(signal: AbortSignal, call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        toolCallId: call.id,
        output: `Error: 系统中不存在名为 '${call.name}' 的工具。`,
        isError: true,
      };
    }

    try {
      const output = await tool.execute(signal, call.arguments);
      return { toolCallId: call.id, output, isError: false };
    } catch (error) {
      return {
        toolCallId: call.id,
        output: `Error executing ${call.name}: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }
}
