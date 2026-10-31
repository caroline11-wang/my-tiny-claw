import { spawn } from "node:child_process";
import type { JsonValue, ToolDefinition } from "../schema/message.js";
import type { BaseTool } from "./registry.js";

export class BashTool implements BaseTool {
  constructor(private readonly workDir: string) {}

  name(): string {
    return "bash";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "在当前工作区执行任意的 bash 命令。支持链式命令(如 &&)。返回标准输出(stdout)和标准错误(stderr)。",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 bash 命令" },
        },
        required: ["command"],
      },
    };
  }

  async execute(signal: AbortSignal, args: JsonValue): Promise<string> {
    if (
      args === null ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      !("command" in args) ||
      typeof args.command !== "string" ||
      args.command.trim() === ""
    ) {
      throw new Error("参数解析失败: command 必须是非空字符串");
    }

    signal.throwIfAborted();
    const command = args.command;
    return new Promise<string>((resolve, reject) => {
      // Merge stderr in bash so both streams retain their write order.
      const child = spawn("bash", ["-c", `exec 2>&1\n${command}\n`], {
        cwd: this.workDir,
        signal,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const maxLen = 8000;
      const chunks: Buffer[] = [];
      let length = 0;
      let truncated = false;
      let timedOut = false;
      let executionError: Error | undefined;

      const collect = (chunk: Buffer): void => {
        const remaining = maxLen - length;
        if (chunk.length > remaining) truncated = true;
        if (remaining > 0) {
          const prefix = chunk.subarray(0, remaining);
          chunks.push(Buffer.from(prefix));
          length += prefix.length;
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", (error) => { executionError = error; });
      const closePipes = (): void => {
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const onAbort = (): void => {
        child.kill("SIGKILL");
        closePipes();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
        closePipes();
      }, 30_000);

      child.on("close", (code, exitSignal) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        if (executionError) {
          reject(new Error(`命令启动或执行失败: ${executionError.message}`, {
            cause: executionError,
          }));
          return;
        }
        let output = Buffer.concat(chunks).toString("utf8");
        if (truncated) {
          output += `\n\n...[终端输出过长，已截断至前 ${maxLen} 字节]...`;
        }
        if (timedOut) {
          resolve(`${output}\n[警告: 命令执行超时(30s)，已被系统强制终止。]`);
        } else if (code !== 0) {
          resolve(`执行报错: ${exitSignal ? `signal ${exitSignal}` : `exit status ${code}`}\n输出:\n${output}`);
        } else {
          resolve(output === "" ? "命令执行成功，无终端输出。" : output);
        }
      });
    });
  }
}
