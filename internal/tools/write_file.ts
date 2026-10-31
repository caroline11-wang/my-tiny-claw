import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue, ToolDefinition } from "../schema/message.js";
import type { BaseTool } from "./registry.js";

export class WriteFileTool implements BaseTool {
  constructor(private readonly workDir: string) {}

  name(): string {
    return "write_file";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "创建或覆盖写入一个文件。如果目录不存在会自动创建。请提供相对于工作区的相对路径。",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "要写入的文件路径，如 src/main.ts",
          },
          content: { type: "string", description: "要写入的完整文件内容" },
        },
        required: ["path", "content"],
      },
    };
  }

  async execute(signal: AbortSignal, args: JsonValue): Promise<string> {
    if (
      args === null ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      !("path" in args) ||
      typeof args.path !== "string" ||
      args.path.trim() === "" ||
      !("content" in args) ||
      typeof args.content !== "string"
    ) {
      throw new Error("参数解析失败: path 必须是非空字符串，content 必须是字符串");
    }

    signal.throwIfAborted();
    const fullPath = join(this.workDir, args.path);
    try {
      await mkdir(dirname(fullPath), { recursive: true, mode: 0o755 });
    } catch (error) {
      throw new Error(
        `创建父目录失败: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    signal.throwIfAborted();
    try {
      await writeFile(fullPath, args.content, { mode: 0o644, signal });
    } catch (error) {
      throw new Error(
        `写入文件失败: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return `成功将内容写入到文件: ${args.path}`;
  }
}
