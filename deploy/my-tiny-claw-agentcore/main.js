// AgentCore 高代码模式入口薄壳：规范示例要求 main.js 位于代码包根目录。
// 真正的 HTTP 服务实现（监听 0.0.0.0、AGENT_PORT/9000、/health、
// OpenAI Chat Completions + SSE、会话管理）在 dist/cmd/server/main.js，
// 与 AgentRun 部署共用同一份编译产物，此处仅做入口转发。
import "./dist/cmd/server/main.js";
