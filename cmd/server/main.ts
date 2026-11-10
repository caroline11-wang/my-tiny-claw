// 服务化入口：把 AgentEngine 包一层 HTTP，部署到阿里云 AgentRun（高代码模式）。
//
// 与 cmd/claw/main.ts（CLI 入口）共用同一套 internal/* 组件：
//   Provider（百炼/OpenAI 兼容/Mock）+ ToolRegistry（read_file/write_file/bash/edit_file）+ AgentEngine（ReAct Main Loop）
// 区别只在入口：
//   CLI：while 循环读 stdin → engine.run() → 打印 stdout
//   HTTP：POST /v1/chat/completions → engine.run() → JSON 响应
//
// AgentRun 平台约定：
//   - 监听 0.0.0.0（不能用 127.0.0.1）
//   - 端口从 AGENT_PORT 环境变量读取（控制台配置的启动端口会注入到这里）
//   - 实现兼容 OpenAI Chat Completions 协议的接口，供平台"调试工具"调用
//   - 提供 /health 健康检查（供控制台健康检查配置）
//
// 启动：node dist/cmd/server/main.js（无需 .env，环境变量由平台注入）
// 本地试用：LLM_PROVIDER=mock node --import tsx cmd/server/main.ts

import http from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { AgentEngine } from "../../internal/engine/loop.js";
import { GlobalSessionMgr, type Session } from "../../internal/context/session.js";
import { ClaudeProvider } from "../../internal/provider/claude.js";
import type { LLMProvider } from "../../internal/provider/interface.js";
import { OpenAIProvider } from "../../internal/provider/openai.js";
import { OllamaProvider } from "../../internal/provider/ollama.js";
import type { Message } from "../../internal/schema/message.js";
import { BashTool } from "../../internal/tools/bash.js";
import { EditFileTool } from "../../internal/tools/edit_file.js";
import { ReadFileTool } from "../../internal/tools/read_file.js";
import { ToolRegistry } from "../../internal/tools/registry.js";
import { WriteFileTool } from "../../internal/tools/write_file.js";

// ---------- Provider 工厂（与 cmd/claw/main.ts 相同的装配逻辑，服务化入口独立持有） ----------
function createProvider(providerName: string): LLMProvider {
  // 大小写不敏感：控制台环境变量曾出现 MOCK 大写导致 500，统一归一化
  const normalized = providerName.trim().toLowerCase();
  if (normalized === "mock") {
    return new MockServerProvider();
  }
  const apiKey = process.env.LLM_API_KEY?.trim() || "";
  const model = process.env.LLM_MODEL?.trim() || "";
  const baseURL = process.env.LLM_BASE_URL?.trim() || "";
  const protocol = process.env.LLM_API_PROTOCOL ?? "openai-compatible";

  if (normalized === "local-ollama") {
    return new OllamaProvider({ model, baseURL, apiKey: apiKey || "ollama" });
  }
  if (normalized !== "bailian") {
    throw new Error(`Unsupported LLM_PROVIDER "${providerName}" (supported: mock / bailian / local-ollama)`);
  }
  if (!apiKey || !model || !baseURL) {
    throw new Error("bailian provider requires LLM_API_KEY / LLM_MODEL / LLM_BASE_URL");
  }
  if (protocol === "anthropic-compatible") {
    return new ClaudeProvider({ apiKey, baseURL, model });
  }
  return new OpenAIProvider({ apiKey, baseURL, model });
}

// Mock Provider：服务端形态的演示用模型（读 a/b/c.txt 三文件演示并发工具调用）。
// 本地无 Key 验证部署链路时使用：LLM_PROVIDER=mock
class MockServerProvider implements LLMProvider {
  async generate(
    _signal: AbortSignal,
    messages: readonly Message[],
    availableTools: readonly object[],
  ): Promise<Message> {
    if (availableTools.length === 0) {
      return { role: "assistant", content: "【推理中】我将并发读取工作区内所有 txt 文件。" };
    }
    const observations = messages.filter((m) => m.toolCallId !== undefined);
    if (observations.length === 0) {
      return {
        role: "assistant",
        content: "",
        toolCalls: ["a.txt", "b.txt", "c.txt"].map((path) => ({
          id: `call_read_${path}`,
          name: "read_file",
          arguments: { path },
        })),
      };
    }
    return {
      role: "assistant",
      content:
        `[Mock] 我是部署在 AgentRun 上的 my-tiny-claw。刚完成了 ${observations.length} 次并发工具调用：\n` +
        observations.map((o) => `- ${o.toolCallId?.replace("call_read_", "")}: ${o.content.trim()}`).join("\n"),
    };
  }
}

// ---------- 组装 Agent：Provider + Registry + Engine（依赖注入，与 CLI 完全一致） ----------
// 会话按 sessionId 复用：同一会话的多次请求命中 GlobalSessionMgr 中的同一个 Session，历史得以延续。
// AgentRun 平台会保证相同 X-AgentRun-Session-ID 的请求路由到同一实例（会话亲和），
// 因此进程内存 Map 在多实例场景下也是安全的。
function createEngine(sessionId: string): { engine: AgentEngine; session: Session } {
  const providerName = process.env.LLM_PROVIDER?.trim() || "mock";
  const provider = createProvider(providerName);

  // 工作区默认取进程目录（AgentRun 上即 zip 解压后的 /code，部署包内可直接携带工作文件）。
  // 可用 AGENT_WORK_DIR 覆盖。
  const workDir = process.env.AGENT_WORK_DIR?.trim() || process.cwd();
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

  const registry = new ToolRegistry();
  registry.register(new ReadFileTool(workDir));
  registry.register(new WriteFileTool(workDir));
  registry.register(new BashTool(workDir));
  registry.register(new EditFileTool(workDir));

  const enableThinking = process.env.ENABLE_THINKING === "true";
  return {
    engine: new AgentEngine(provider, registry, enableThinking),
    session: GlobalSessionMgr.getOrCreate(sessionId, workDir),
  };
}

// ---------- OpenAI Chat Completions 兼容层 ----------
interface ChatCompletionRequestBody {
  messages?: Array<{ role: string; content?: string }>;
  stream?: boolean;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function jsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

const PORT = Number(process.env.AGENT_PORT || process.env.PORT || 9000);

const server = http.createServer(async (req, res) => {
  // 记录所有进入的请求（排错用：定位平台实际调用的方法与路径）
  console.log(`[Server] <-- ${req.method} ${req.url}`);

  // 健康检查：对应控制台"健康检查"配置路径
  if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
    return jsonResponse(res, 200, { status: "ok" });
  }

  // Agent 调试接口：AgentRun"代码与调试 → 调试"面板实测 POST 到根路径 "/"；
  // 同时兼容 OpenAI 风格路径变体（带/不带 /v1 前缀、尾部斜杠），供 curl/SDK 直接调用。
  const isChatPath =
    req.url === "/" || /^\/(v1\/)?chat\/completions\/?$/.test(req.url ?? "");
  if (req.method === "POST" && isChatPath) {
    try {
      const rawBody = await readBody(req);
      // 记录请求体（截断），用于定位平台实际发送的协议字段
      console.log(`[Server] <-- 请求体(前500字符): ${rawBody.slice(0, 500)}`);
      const body: ChatCompletionRequestBody = JSON.parse(rawBody || "{}");
      const messages = body.messages ?? [];
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const userPrompt = lastUser?.content?.trim();
      if (!userPrompt) {
        return jsonResponse(res, 400, { error: { message: "缺少 user 消息" } });
      }

      // 会话 ID：优先用平台传入的 X-AgentRun-Session-ID（调试面板的「会话 ID」即此值，
      // 且平台按该值做会话亲和路由到同一实例）；header 缺失时兜底生成一次性会话。
      const headerSessionId = req.headers["x-agentrun-session-id"]?.toString().trim();
      const sessionId = headerSessionId || randomUUID();
      console.log(`[Server] session=${sessionId} (${headerSessionId ? "来自平台 header" : "header 缺失，临时生成"})`);

      const { engine, session } = createEngine(sessionId);
      session.append({ role: "user", content: userPrompt });
      const reply = await engine.run(new AbortController().signal, session);

      const responseId = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const modelName = process.env.LLM_MODEL || "my-tiny-claw";

      // 流式（SSE）响应：平台调试面板可能以 stream:true 请求，OpenAI 分块协议返回
      if (body.stream === true) {
        console.log(`[Server] --> 以 SSE 流式响应返回 (${reply.length} 字符)`);
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const chunk = (delta: Record<string, unknown>, finishReason: string | null): string =>
          `data: ${JSON.stringify({
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: modelName,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`;
        res.write(chunk({ role: "assistant", content: reply }, null));
        res.write(chunk({}, "stop"));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      console.log(`[Server] --> 以 JSON 响应返回 (${reply.length} 字符)`);
      return jsonResponse(res, 200, {
        id: responseId,
        object: "chat.completion",
        created,
        model: modelName,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: reply },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (error) {
      console.error("[Server] 处理请求失败:", error);
      return jsonResponse(res, 500, { error: { message: String(error) } });
    }
  }

  console.warn(`[Server] 404 未匹配路由: ${req.method} ${req.url}`);
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Not Found: ${req.method} ${req.url}`);
});

// AgentRun 硬性要求：监听 0.0.0.0，端口读 AGENT_PORT
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Server] my-tiny-claw HTTP 服务已启动: 0.0.0.0:${PORT}`);
  console.log(`[Server] POST /v1/chat/completions ← Agent 入口（OpenAI 协议）`);
  console.log(`[Server] GET  /health             ← 健康检查`);
});
