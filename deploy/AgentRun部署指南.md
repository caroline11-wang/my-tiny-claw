# my-tiny-claw 部署到阿里云 AgentRun 指南

> 部署包：`deploy/my-tiny-claw-agentrun.zip`（11MB，含编译产物 + 生产依赖）
> 分两步：第 1 步用 Mock Provider 零成本跑通全流程，第 2 步切换到百炼真模型。

---

## 一、前置准备（一次性，约 10 分钟）

1. **阿里云账号**：注册并完成实名认证（个人认证即可）
2. **开通 AgentRun**：打开 [AgentRun 运行时与沙箱控制台](https://functionai.console.aliyun.com/agent/runtime/agent-list)，按提示完成开通
3. **服务角色授权**：首次使用会弹出 SLR 授权（AliyunServiceRoleForFC 等），全部同意即可
4. 无需提前准备 API Key——第 1 步 Mock 版用不到

---

## 二、第 1 步：部署 Mock 版 hello world

### 1. 创建 Agent

控制台 → **创建 Agent** → **通过代码创建**：
- 名称：`my-tiny-claw`（随意）
- 功能描述：`TypeScript Agent Harness 演示`

### 2. 代码来源

选 **上传代码包**，上传 `deploy/my-tiny-claw-agentrun.zip`。

### 3. 关键配置（照抄即可）

| 配置项 | 值 | 说明 |
|---|---|---|
| 运行时 | Node.js 20 | 平台选项 |
| 启动命令 | `node dist/cmd/server/main.js` | 服务化入口 |
| 启动端口 | `9000` | 代码默认读 `AGENT_PORT`，不设则用 9000 |
| 环境变量 | `LLM_PROVIDER=mock` | 走 Mock Provider，不调真实模型 |
| 健康检查路径 | `/health` | 已实现 |
| 执行角色 | `AliyunAgentRunFullAccess` | 按提示选择 |
| 访问凭证 | 先选「不使用凭证」（仅测试） | 跑通后再改 |

### 4. 部署与调试

1. 点右上角 **开始部署**，等状态变为运行中
2. 进入 Agent 详情页 → **代码与调试** → **调试工具**
3. 发一条消息，例如「读取工作区文件」。预期回复：

```
[Mock] 我是部署在 AgentRun 上的 my-tiny-claw。刚完成了 3 次并发工具调用：
- a.txt: ...
- b.txt: ...
- c.txt: ...
```

> 看到这个回复 = 整条链路（代码包 → Serverless 实例 → OpenAI 协议接口 → ReAct 循环 → 并发工具调用）全部跑通了。
> Mock 模式下工作区是空的，三次 read_file 会报「文件不存在」——这是预期行为，重点是循环在转。

---

## 三、第 2 步：切换到百炼真模型

### 1. 准备百炼 API Key

1. 开通[阿里云百炼](https://bailian.console.aliyun.com/)
2. 左侧 **API-KEY 管理** → 创建 Key，记下来（`sk-` 开头）

### 2. 平台侧配置模型（二选一）

- **简单方式**（推荐先用这个）：不用平台模型管理，直接在环境变量里配 Key
- 进阶方式：AgentRun 控制台 **模型管理** 创建模型，通过凭证管理注入 Key——hello world 阶段不必折腾

### 3. 修改环境变量，重新部署

在 Agent 配置里把环境变量改为：

| 环境变量 | 值 |
|---|---|
| `LLM_PROVIDER` | `bailian` |
| `LLM_API_KEY` | `sk-你的百炼Key` |
| `LLM_MODEL` | `qwen-plus`（或 qwen-turbo / qwen-max） |
| `LLM_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `LLM_API_PROTOCOL` | `openai-compatible` |

重新部署后，在调试工具里发真实任务，例如：

> 帮我看看工作区里有什么文件，读一下内容并总结

模型会真实决策工具调用（read_file/bash 等），在实例的临时工作区内执行并返回总结。

---

## 四、验证与排错速查

| 症状 | 原因与处理 |
|---|---|
| 实例启动失败/超时 | 代码监听 `0.0.0.0`（已保证）；端口与控制台一致（已默认 9000） |
| 调试工具 404 | 接口路径必须是 `POST /v1/chat/completions`（已实现） |
| 500 + LLM_API_KEY 报错 | 环境变量没配全，对照第 2 步表格逐项检查 |
| 500 + LLM_BASE_URL 报错 | 代码校验只允许百炼域名（dashscope.aliyuncs.com），确认 URL 拼写 |
| 想看详细日志 | Agent 详情 → 日志（SLS），引擎每轮 Turn 都有 stderr 输出 |

用 curl 直接调用（Endpoint 从详情页获取）：

```bash
curl -X POST https://<你的Endpoint>/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"你好"}]}'
```

---

## 第 10 讲：工作区规范与技能

HTTP 入口与 CLI 共用 `AgentEngine`，每次聊天请求开始时会从工作区重新组装系统提示词：
核心规则 → `AGENTS.md` → `.claw/skills/**/SKILL.md`。
HTTP 默认工作区为进程当前目录（AgentRun 通常为 `/code`），可通过 `AGENT_WORK_DIR` 覆盖。

更新代码后先运行 `npm run build`，用新的 `dist/` 替换打包目录中的编译产物。
如果需要项目规范和技能，还需将 `AGENTS.md` 和 `.claw/skills/` 一并放入打包目录的
工作区根目录，再重新压缩并部署。不要把本机 `.env` 或 API Key 资料复制进部署包。
已有 zip 不会因修改 TypeScript 源码而自动更新。

不提供这些文件时仍可使用核心规则运行；配置了格式不正确的技能或无法读取的指南时，
请求会显式失败，HTTP 返回 500，日志中保留错误来源。技能格式及离线测试方法见
[README 第 10 讲](../README.md#第-10-讲skill-加载与-prompt-composer)。
Mock 模型不会依据技能语义改变决策，验证规范遵循效果需要真实模型。

## 第 11 讲：Session 驱动引擎

引擎现在通过 `run(signal, session)` 读取会话工作区，每个工具轮次使用最近 6 条历史消息，
并保存 Thinking、Action 与工具观察结果。HTTP 入口通过 `X-AgentRun-Session-ID`
请求头复用进程内 Session；请求头缺失或为空时创建独立会话，JSON/SSE 响应协议不变。
日志输出会话 ID 及来源。历史在进程重启后丢失，多实例部署需确保同一 ID 的请求
路由到同一实例；同一会话的请求应顺序发送。
工具 Registry 和 Session 使用同一工作区；更新部署仍须重新编译打包。

## 五、下一步可玩的方向

- **会话记忆**：已有按 Session ID 复用的进程内历史；可进一步实现持久化、过期清理与同会话请求排队
- **Agent Sandbox**：把 bash 工具的执行迁到 AgentRun 沙箱，实现隔离执行（进阶）
- **版本与灰度**：左侧「版本与灰度」发布版本、配流量比例，体验 Serverless 发布流程
- **可观测**：接入 SLS 日志 / ARMS 链路追踪，看 Token 消耗

## 本次代码改动说明

- `internal/engine/loop.ts`：`run()` 返回值从 `void` 改为 `string`（最终回复），原 CLI 行为不受影响
- `cmd/server/main.ts`（新增）：HTTP 服务化入口，与 CLI 共用同一套 internal 组件
- `deploy/my-tiny-claw-agentrun.zip`：部署包（`dist/` + 生产 `node_modules` + `package.json`）
- 原始 loop.ts 备份在 `.backup/loop.ts.orig`
