import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue, ToolDefinition } from "../schema/message.js";
import type { BaseTool } from "./registry.js";

export class EditFileTool implements BaseTool {
  constructor(private readonly workDir: string) {}

  name(): string {
    return "edit_file";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "对现有文件进行局部的字符串替换。这比重写整个文件更安全、更快速。请提供足够的 old_text 上下文以确保匹配的唯一性。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "要修改的文件路径" },
          old_text: {
            type: "string",
            description: "文件中原有的文本。必须包含足够的上下文，以确保在文件中的唯一性。",
          },
          new_text: {
            type: "string",
            description: "要替换成的新文本",
          },
        },
        required: ["path", "old_text", "new_text"],
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
      !("old_text" in args) ||
      typeof args.old_text !== "string" ||
      args.old_text.trim() === "" ||
      !("new_text" in args) ||
      typeof args.new_text !== "string"
    ) {
      throw new Error(
        "参数解析失败: path 和 old_text 必须是非空字符串，new_text 必须是字符串",
      );
    }

    const fullPath = join(this.workDir, args.path);
    let originalContent: string;
    try {
      originalContent = await readFile(fullPath, { encoding: "utf8", signal });
    } catch (error) {
      throw new Error(
        `读取文件失败，请确认路径是否正确: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const updatedContent = fuzzyReplace(originalContent, args.old_text, args.new_text);
    try {
      await writeFile(fullPath, updatedContent, { encoding: "utf8", signal });
    } catch (error) {
      throw new Error(
        `写回文件失败: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    return `✅ 成功修改文件: ${args.path}`;
  }
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(search, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + search.length;
  }
}

function replaceOnce(content: string, search: string, replacement: string): string {
  const index = content.indexOf(search);
  return `${content.slice(0, index)}${replacement}${content.slice(index + search.length)}`;
}

function fuzzyReplace(
  originalContent: string,
  oldText: string,
  newText: string,
): string {
  const exactCount = countOccurrences(originalContent, oldText);
  if (exactCount === 1) return replaceOnce(originalContent, oldText, newText);
  if (exactCount > 1) {
    throw new Error(
      `old_text 匹配到了 ${exactCount} 处，请提供更多的上下文代码以确保唯一性`,
    );
  }

  const normalizedContent = originalContent.replaceAll("\r\n", "\n");
  const normalizedOld = oldText.replaceAll("\r\n", "\n");
  const normalizedCount = countOccurrences(normalizedContent, normalizedOld);
  if (normalizedCount === 1) {
    return replaceOnce(normalizedContent, normalizedOld, newText);
  }

  const trimmedOld = normalizedOld.trim();
  if (trimmedOld !== "") {
    const trimmedCount = countOccurrences(normalizedContent, trimmedOld);
    if (trimmedCount === 1) {
      return replaceOnce(normalizedContent, trimmedOld, newText);
    }
  }

  return replaceLineBlock(normalizedContent, trimmedOld, newText);
}

function replaceLineBlock(
  content: string,
  oldText: string,
  newText: string,
): string {
  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n").map((line) => line.trim());
  if (oldLines.length === 0 || contentLines.length < oldLines.length) {
    throw new Error("找不到该代码片段");
  }

  let matchCount = 0;
  let matchStartIndex = -1;
  let matchEndIndex = -1;
  for (let start = 0; start <= contentLines.length - oldLines.length; start += 1) {
    const matches = oldLines.every(
      (line, index) => contentLines[start + index]?.trim() === line,
    );
    if (matches) {
      matchCount += 1;
      matchStartIndex = start;
      matchEndIndex = start + oldLines.length;
    }
  }

  if (matchCount === 0) {
    throw new Error("在文件中未找到 old_text，请检查内容和缩进");
  }
  if (matchCount > 1) {
    throw new Error(`模糊匹配到了 ${matchCount} 处代码，请提供更多上下文以定位`);
  }

  return [
    ...contentLines.slice(0, matchStartIndex),
    ...newText.split("\n"),
    ...contentLines.slice(matchEndIndex),
  ].join("\n");
}
