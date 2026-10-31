import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue, ToolDefinition } from "../schema/message.js";
import type { BaseTool } from "./registry.js";

export class ReadFileTool implements BaseTool {
  constructor(private readonly workDir: string) {}

  name(): string {
    return "read_file";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description: "读取指定路径的文件内容。请提供相对工作区的路径。",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "要读取的文件路径，如 cmd/claw/main.ts",
          },
        },
        required: ["path"],
      },
    };
  }

  async execute(signal: AbortSignal, args: JsonValue): Promise<string> {
    if (
      args === null ||
      Array.isArray(args) ||
      typeof args !== "object" ||
      !("path" in args) ||
      typeof args.path !== "string" ||
      args.path.trim() === ""
    ) {
      throw new Error("参数解析失败: path 必须是非空字符串");
    }

    const fullPath = join(this.workDir, args.path);
    let content: Buffer;
    try {
      content = await readFile(fullPath, { signal });
    } catch (error) {
      throw new Error(
        `读取文件内容失败: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const maxLen = 8000;
    if (content.length > maxLen) {
      return `${content.subarray(0, maxLen).toString("utf8")}\n\n...[由于内容过长，已被系统截断至前 ${maxLen} 字节]...`;
    }
    return content.toString("utf8");
  }
}
