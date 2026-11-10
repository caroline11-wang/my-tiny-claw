import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { AgentEngine } from "../../internal/engine/loop.js";
import { GlobalSessionMgr } from "../../internal/context/session.js";
import { ClaudeProvider } from "../../internal/provider/claude.js";
import type { LLMProvider } from "../../internal/provider/interface.js";
import { OpenAIProvider } from "../../internal/provider/openai.js";
import { OllamaProvider } from "../../internal/provider/ollama.js";
import {
  RoleAssistant,
  type Message,
  type ToolDefinition,
} from "../../internal/schema/message.js";
import { BashTool } from "../../internal/tools/bash.js";
import { EditFileTool } from "../../internal/tools/edit_file.js";
import { ReadFileTool } from "../../internal/tools/read_file.js";
import { ToolRegistry } from "../../internal/tools/registry.js";
import { WriteFileTool } from "../../internal/tools/write_file.js";

function formatLogTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

class MockProvider implements LLMProvider {
  async generate(
    _signal: AbortSignal,
    messages: readonly Message[],
    availableTools: readonly ToolDefinition[],
  ): Promise<Message> {
    if (availableTools.length === 0) {
      return {
        role: RoleAssistant,
        content:
          "【推理中】a.txt、b.txt、c.txt 的读取互相独立，可以在同一轮发起三个工具调用。",
      };
    }

    const observations = messages.filter(
      (message) => message.toolCallId !== undefined,
    );
    if (observations.length === 0) {
      return {
        role: RoleAssistant,
        content: "我将同时读取 a.txt、b.txt、c.txt。",
        toolCalls: ["a.txt", "b.txt", "c.txt"].map((path) => ({
          id: `call_read_${path}`,
          name: "read_file",
          arguments: { path },
        })),
      };
    }

    return {
      role: RoleAssistant,
      content: observations.map((observation) =>
        `${observation.toolCallId?.replace("call_read_", "")}：${observation.content.trim()}`,
      ).join("\n"),
    };
  }
}

function createProvider(providerName: string): LLMProvider {
  if (providerName === "mock") return new MockProvider();
  if (providerName !== "bailian" && providerName !== "local-ollama") {
    throw new Error(
      `Unsupported LLM_PROVIDER "${providerName}"; supported values are bailian, local-ollama, and mock`,
    );
  }

  const apiKey =
    process.env.LLM_API_KEY?.trim() ||
    (providerName === "local-ollama" ? "ollama" : "");
  if (!apiKey) {
    throw new Error("LLM_API_KEY is required when LLM_PROVIDER=bailian");
  }
  const model = process.env.LLM_MODEL?.trim();
  if (!model) {
    throw new Error(`LLM_MODEL is required when LLM_PROVIDER=${providerName}`);
  }

  const protocol = process.env.LLM_API_PROTOCOL ?? "openai-compatible";
  if (
    protocol !== "openai-compatible" &&
    protocol !== "anthropic-compatible"
  ) {
    throw new Error(
      "LLM_API_PROTOCOL must be openai-compatible or anthropic-compatible",
    );
  }
  if (providerName === "local-ollama" && protocol !== "openai-compatible") {
    throw new Error("local-ollama currently requires openai-compatible protocol");
  }
  if (providerName === "local-ollama") {
    return new OllamaProvider({
      model,
      baseURL: process.env.LLM_BASE_URL ?? "",
      ...(apiKey ? { apiKey } : {}),
    });
  }
  const baseURL = validateBaseURL(
    process.env.LLM_BASE_URL ?? "",
  );

  if (protocol === "openai-compatible") {
    return new OpenAIProvider({
      apiKey,
      baseURL,
      model,
    });
  }
  if (protocol === "anthropic-compatible") {
    return new ClaudeProvider({
      apiKey,
      baseURL,
      model,
    });
  }
  throw new Error(`Unsupported LLM_API_PROTOCOL: ${protocol}`);
}

function validateBaseURL(
  value: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "LLM_BASE_URL must be set to an absolute URL",
    );
  }
  const hasCredentials = url.username.length > 0 || url.password.length > 0;
  const allowedHost =
    url.hostname.endsWith(".maas.aliyuncs.com") ||
    url.hostname === "dashscope.aliyuncs.com" ||
    url.hostname.endsWith(".dashscope.aliyuncs.com");
  if (url.protocol !== "https:" || !allowedHost || hasCredentials) {
    throw new Error(
      "LLM_BASE_URL must use an Alibaba Bailian HTTPS endpoint",
    );
  }
  return url.toString().replace(/\/+$/u, "");
}

async function main(): Promise<void> {
  console.log("🚀 欢迎来到 go-tiny-claw 引擎启动序列");

  try {
    const providerName = process.env.LLM_PROVIDER?.trim();
    if (!providerName) {
      throw new Error("LLM_PROVIDER must be set in .env");
    }
    const provider = createProvider(providerName);
    console.error(
      `[LLM] 当前连接: provider=${providerName}, model=${providerName === "mock" ? "mock" : process.env.LLM_MODEL?.trim()}`,
    );
    const workDir = join(process.cwd(), "workspace");
    let gitRoot: string;
    try {
      gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: workDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      throw new Error("请先按 README 准备 workspace 并初始化独立 Git 仓库", { cause: error });
    }
    if (realpathSync(gitRoot) !== realpathSync(workDir)) {
      throw new Error("workspace 必须是独立 Git 仓库，不能使用父目录的主项目仓库");
    }
    const registry = new ToolRegistry();
    registry.register(new ReadFileTool(workDir));
    registry.register(new WriteFileTool(workDir));
    registry.register(new BashTool(workDir));
    registry.register(new EditFileTool(workDir));
    const engine = new AgentEngine(provider, registry, true);
    const session = GlobalSessionMgr.getOrCreate("terminal", workDir);
    session.append({
      role: "user",
      content: `请在当前工作区新建 ping.ts，用 TypeScript 提供一个简单的 HTTP ping 接口。
写完之后，帮我把本次任务的代码用 Git 提交一下；不要提交无关文件，也不要推送远端。
如果文件已存在，请先读取再决定是否修改。`,
    });
    await engine.run(new AbortController().signal, session);
  } catch (error) {
    console.error(
      `${formatLogTimestamp(new Date())} 引擎崩溃:`,
      error,
    );
    process.exitCode = 1;
  }
}

void main();
