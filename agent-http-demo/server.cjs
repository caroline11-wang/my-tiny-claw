// 服务化 Agent Demo —— 把 AgentEngine 包一层 HTTP 入口
//
// 结构对应 my-tiny-claw：
//   provider  → mockProvider（真实项目换成百炼/OpenAI SDK）
//   tools     → registry（get_time 工具）
//   engine    → runAgent（ReAct Main Loop）
//   入口      → HTTP 服务（对应 cmd/claw/main.ts 里的终端循环）
//
// CLI 形态：入口是 stdin/stdout + while 循环
// 服务化形态：入口是 HTTP POST /api/chat，每条消息是一个请求

const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------- 工具层（对应 internal/tools/registry.ts） ----------
const registry = {
  get_time: {
    description: "获取当前时间",
    run: () => new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
  },
};

function executeTool(name, args) {
  const tool = registry[name];
  if (!tool) return `错误：未知工具 ${name}`;
  return tool.run(args ?? {});
}

// ---------- Provider 层（对应 internal/provider/interface.ts） ----------
// Mock Provider：演示用，不调真实模型。
// 行为：第一轮请求工具 get_time，拿到工具结果后给出最终回复。
function mockProvider(messages) {
  const last = messages[messages.length - 1];
  const hasToolResult = messages.some((m) => m.role === "tool");

  if (!hasToolResult) {
    // 模型决策：需要调用工具
    return {
      role: "assistant",
      toolCalls: [{ id: "call_1", name: "get_time", args: {} }],
      content: "",
    };
  }

  const toolResult = messages.find((m) => m.role === "tool").content;
  return {
    role: "assistant",
    toolCalls: [],
    content: `你好！我是跑在 HTTP 服务里的 Agent。现在是 ${toolResult}。` +
      `刚才我通过一次工具调用拿到时间——这就是 ReAct 循环：请求工具 → 观察结果 → 生成回复。` +
      `你上一条消息是：「${messages[0].content}」`,
  };
}

// ---------- Engine 层（对应 internal/engine/loop.ts） ----------
async function runAgent(sessionHistory, userMessage) {
  // 1. 把用户消息塞进上下文（真实项目：按 session 管理历史）
  const messages = [
    ...sessionHistory,
    { role: "user", content: userMessage },
  ];

  const trace = [];

  // 2. Main Loop：模型响应 → 有工具调用就执行并把观察结果追加 → 直到没有工具调用
  while (true) {
    const reply = mockProvider(messages);
    messages.push(reply);
    trace.push({ step: trace.length + 1, type: "assistant", content: reply.content, toolCalls: reply.toolCalls });

    if (!reply.toolCalls?.length) break;

    for (const call of reply.toolCalls) {
      const result = executeTool(call.name, call.args);
      const toolMessage = { role: "tool", callId: call.id, content: result };
      messages.push(toolMessage);
      trace.push({ step: trace.length + 1, type: "tool", name: call.name, content: result });
    }
  }

  const finalReply = messages[messages.length - 1].content;
  return { reply: finalReply, trace };
}

// ---------- HTTP 入口（服务化后的"main.ts"） ----------
const sessions = new Map(); // 简化的会话存储：内存 Map（生产环境换 Redis/DB）

const server = http.createServer(async (req, res) => {
  // 静态页面：聊天客户端（网页只是 HTTP 接口的客户端之一）
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
    return;
  }

  // Agent 接口：POST /api/chat  ← 这就是"包一层 HTTP"的核心
  if (req.method === "POST" && req.url === "/api/chat") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { message, sessionId } = JSON.parse(body || "{}");
        if (!message) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "message 不能为空" }));
          return;
        }
        const sid = sessionId || "default";
        const history = sessions.get(sid) || [];
        const result = await runAgent(history, message);

        // 更新会话历史（保留最近 10 条，防止无限增长）
        sessions.set(sid, [...history, { role: "user", content: message }, { role: "assistant", content: result.reply }].slice(-10));

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

// 服务化形态的关键：进程常驻，监听端口，而不是跑完一轮就退出
const port = Number(process.env.PORT) || 8081;
const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => {
  console.log(`Agent HTTP 服务已启动: http://${host}:${port}`);
  console.log(`POST /api/chat  ← Agent 入口（等价于 CLI 里的 stdin）`);
  console.log(`GET  /          ← 网页客户端（可选，curl 也能调）`);
});
