# my-tiny-claw：Agent Harness TypeScript 实现

本项目从《从 0 开始构建 Agent Harness》第 01 讲的项目骨架开始，
并实现第 02 至 07 讲中的 Schema、Provider、Main Loop、工具注册分发及
read_file、write_file、bash、edit_file 工具。
它是课程 Go 示例的 TypeScript 对照实现；第 04 讲中的智谱模型已替换为阿里云百炼。

## 架构

保留课程步骤 2 的目录分层，不额外套一层 `src`：

```text
my-tiny-claw/
├── cmd/
│   └── claw/
│       └── main.ts          # 启动入口，对应 main.go
├── internal/
│   ├── schema/              # Agent 上下文、工具调用与结果的数据结构
│   ├── engine/              # 核心引擎与 Main Loop
│   ├── provider/            # 模型接口与厂商适配
│   ├── context/             # 上下文管理与提示词组装
│   ├── tools/               # 工具注册、执行与中间件
│   ├── memory/              # 文件系统记忆与待办
│   └── feishu/              # 飞书交互集成
├── tests/
│   ├── engine.test.mjs      # Main Loop 行为测试
│   ├── providers.test.mjs   # 两种 API 协议适配测试
│   └── skeleton.test.mjs    # Mock 启动闭环与目录结构验证
├── package.json             # Node.js 脚本和依赖，对应 go.mod 的部分职责
├── package-lock.json        # 固定依赖版本
├── tsconfig.json            # TypeScript 严格检查与编译配置
└── README.md
```

`internal/schema/message.ts` 定义统一的 `Message`、`ToolCall`、`ToolResult` 和
`ToolDefinition` 类型；`internal/provider/interface.ts` 定义模型调用契约；
`internal/tools/registry.ts` 定义工具发现与执行契约；`internal/engine/loop.ts`
实现 ReAct Main Loop。`internal/provider/openai.ts` 和
`internal/provider/claude.ts` 分别使用官方 OpenAI 与 Anthropic TypeScript SDK，
将统一消息结构映射为各自 SDK 的参数，并把响应转换回统一结构。接口接收 `AbortSignal`，
并以 Promise 表达 TypeScript 中的异步 I/O。

Main Loop 通过注入的 Provider 和 Registry 获取模型响应、执行工具，并将工具观察结果
按调用 ID 追加到上下文中，直到模型不再请求工具。`LLM_PROVIDER` 选择百炼、本地 Ollama 或离线 Mock Provider；入口始终注册真实的
`ToolRegistry` 和 `ReadFileTool`。Mock Provider 仅模拟模型决策，工具仍会实际读取文件。

## 第 03 讲：Thinking / Action 两阶段

`AgentEngine` 保留 `enableThinking` 开关；当前第 08 讲入口将其开启，以对应课程的
并发规划演示。Thinking 开关开启时，每轮先以空工具列表请求规划，再提供工具定义
执行 Action；此功能由引擎测试覆盖。

## 第 04 讲：连接阿里云百炼

启动入口使用通用的 `LLM_*` 环境变量配置模型。项目根目录的 `.env` 用于本地配置，
已加入 `.gitignore`；`.env.example` 是不含真实凭证的模板。复制模板后填写配置：

```dotenv
LLM_PROVIDER=bailian
LLM_MODEL=qwen3.8-max-0902
LLM_API_KEY=你的百炼 API key
LLM_BASE_URL=https://你的百炼 OpenAI 兼容 endpoint
LLM_API_PROTOCOL=openai-compatible
```

```sh
cp .env.example .env
npm start
```

`LLM_PROVIDER` 支持 `bailian`、`local-ollama` 和 `mock`；`LLM_MODEL` 指所选服务中已
开通或已安装的模型。`LLM_API_KEY` 和 `LLM_BASE_URL` 分别设置 SDK 认证凭证和基础地址。
百炼的 OpenAI 兼容模式使用 `LLM_API_PROTOCOL=openai-compatible`；当前代码也可通过
`LLM_API_PROTOCOL=anthropic-compatible` 使用 Anthropic SDK，但所选模型服务必须确实提供
Anthropic-compatible endpoint。该模式的 endpoint 与 OpenAI-compatible endpoint 可能不同。

本地 Ollama 使用 OpenAI-compatible endpoint，例如 `http://localhost:11434/v1`，
并将 `LLM_PROVIDER` 设为 `local-ollama`、`LLM_API_PROTOCOL` 设为
`openai-compatible`。Ollama 不校验 API key 时，`LLM_API_KEY` 可填写 `ollama`。
不要将真实 API key 提交到 Git。

### 本地 Ollama

`internal/provider/ollama.ts` 实现独立的 `OllamaProvider`，复用 `OpenAIProvider`
进行消息与工具调用转换，与 ninjagops 一样通过 OpenAI-compatible API 连接 Ollama。
本地连接仅允许 HTTP 回环地址，不需要新增 SDK。

本地配置文件 `.env-ollama` 已加入 `.gitignore`，内容如下（模型必须已在本机安装）：

```dotenv
LLM_PROVIDER=local-ollama
LLM_MODEL=llama3.1:latest
LLM_API_KEY=ollama
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_API_PROTOCOL=openai-compatible
```

确保 Ollama 正在运行（使用桌面应用或 `ollama serve`，不要重复启动服务），再执行：

```sh
ollama list
npm run start:ollama
```

启动命令只加载 `.env-ollama`，不读取百炼的 `.env`；已有 shell 环境变量优先于文件配置。
模型需支持工具调用；入口中的文件读取、写入、命令执行和局部编辑都是真实操作。
编译后可执行
`npm run build` 和 `npm run start:ollama:built`。

默认 `npm start` 会发起真实百炼模型请求，可能产生费用，并允许模型通过工具修改
工作区内容。当前入口任务是读取三个文本文件；想先离线验证，可运行：

```sh
LLM_PROVIDER=mock npm start
```

## 第 05 讲：工具注册与 read_file（前三步）

对应 [Go 第 05 讲示例](../publication/column/timegeek/build-agent-harness-from-scratch/ch05/go-tiny-claw/)：

- `internal/tools/registry.ts` 定义 `BaseTool`：`name()`、`definition()`、
  `execute(signal, args)`。参数沿用现有 `JsonValue`，不重复解析已经反序列化的 JSON。
- `ToolRegistry` 用 Map 按名称注册和分发工具。重复注册会警告并覆盖；
  未知工具和执行异常转换为 `isError=true` 的 `ToolResult`，保留调用 ID，
  供引擎作为工具观察结果反馈给模型，不中断整个循环。
- `internal/tools/read_file.ts` 实现 `ReadFileTool`，接收工作区和 `path` 参数，
  读取文件并在超过 **8000 字节** 时截断，追加课程中的截断提示。

```ts
const registry = new ToolRegistry();
registry.register(new ReadFileTool(workDir));
```

保留 `Registry` 执行接口供引擎依赖；入口使用 `ToolRegistry` 注册并分发
`ReadFileTool`。运行时 Provider 决定模型大脑，文件读取工具始终执行真实 I/O。
这版与课程一样不是文件系统安全沙箱：拼接工作区路径不阻止 `..` 或符号链接访问工作区外
的文件，也不自动过滤密钥文件；不要将其挂载到处理不可信请求的线上服务。
课程实现先读完整文件再截断，不是流式读取或大文件内存限制。

## 第 06 讲：write_file、bash 与多工具运行演示

对应 [Go 第 06 讲示例](../publication/column/timegeek/build-agent-harness-from-scratch/ch06/go-tiny-claw/)：
该讲的原始入口演示检查 Go 版本、写入并运行 `helloworld.go`；第 07 讲的实战入口
已改为使用 `edit_file` 修改 `server.go`，见下节。

- `internal/tools/write_file.ts` 的 `WriteFileTool` 接收 `path` 和 `content`，
  自动递归创建父目录，创建或覆盖 UTF-8 文件，也允许写入空内容。
  新目录和文件的创建权限分别为 `0755` 和 `0644`（受系统 umask 影响）。
- `internal/tools/bash.ts` 的 `BashTool` 接收 `command`，使用 `bash -c`，
  将工作目录设为 `workDir`，支持管道、重定向和 `&&`，合并 stdout/stderr。
  执行超过 30 秒会强制终止所启动的进程并返回超时提示；支持 `AbortSignal` 取消。
- 与课程一样，命令非零退出会把退出状态和输出作为观察结果返回，便于模型纠错；
  参数错误、进程启动失败及取消由 Registry 转换为 `isError=true` 的工具结果。
- 终端输出只保留前 **8000 字节**并继续排空后续数据，避免输出缓存无限增长。
  成功、非零退出及超时分支都受截断限制，比课程只截断正常返回分支更严格。
  与现有 `read_file` 一样，按字节截断可能在 UTF-8 字符边界产生替换字符。

两个工具都实现 `BaseTool`，可注册到现有 `ToolRegistry`：

```ts
import { BashTool } from "./internal/tools/bash.js";
import { WriteFileTool } from "./internal/tools/write_file.js";

registry.register(new WriteFileTool(workDir));
registry.register(new BashTool(workDir));
```

入口已注册 `read_file`、`write_file` 和 `bash`，使用同一个工作区。
本节对应的多工具演示需要本机 Go 编译器；当前入口的第 07 讲实战不再依赖 Go 命令。
离线 Mock Provider 按固定顺序发起同样的真实工具调用；工具失败时反馈错误，不宣称成功。
工作区路径和命令 cwd 都不是安全沙箱。写入可能覆盖已有文件；
Bash 继承当前进程的环境与用户权限，可访问工作区外的文件和网络。
超时/取消不保证终止命令产生的全部后代进程，不应据此管理常驻服务。
仅在可信的本地学习环境中使用，不要向不可信请求开放或视为线上隔离方案。

## 第 07 讲：支持多级模糊匹配的 edit_file

对应 [Go 第 07 讲示例](../publication/column/timegeek/build-agent-harness-from-scratch/ch07/go-tiny-claw/)：

- `internal/tools/edit_file.ts` 实现 `EditFileTool`，Schema 接收 `path`、
  `old_text` 和 `new_text`，只对已存在文件做局部替换。
- 匹配按顺序降级：**L1** 原文唯一精确匹配；**L2** 统一 CRLF/LF 后唯一匹配；
  **L3** 去除 old_text 首尾空白后唯一匹配；**L4** 逐行忽略缩进匹配多行代码。
- 任意层级遇到唯一匹配即替换；精确匹配重复、模糊匹配多处或找不到片段时返回明确错误，
  不写回文件。为避免空白目标意外插入文本，本实现也拒绝空或纯空白 `old_text`。
- Edit 工具读取并保留文件内容，成功匹配后才写回；它不是语法感知的 AST 重构工具，
  也不验证替换结果是否能编译。

第 07 讲的实战任务是修改 `server.go` 的鉴权片段；当前入口已切换为第 08 讲的并发读取。
可以通过测试离线验证 L4 缩进容错：

```sh
node --import tsx --test tests/edit-file.test.mjs
```

项目保留 `server.go` 示例文件，Edit 实战会修改它。当前真实模型入口可执行：

```sh
npm start
```

Edit、Write 和 Bash 均可直接修改或执行工作区内容，路径拼接不构成安全隔离。
运行前请确认目标文件内容可修改，并仅在可信的本地工作区使用。

## 安装与运行

需要 Node.js 22 或更新版本及 npm。

```sh
cd my-tiny-claw
npm install
npm start
```

入口保留 `go-tiny-claw` 的欢迎文本方便与 Go 示例对照。模型文本写入 stdout，
引擎进度和工具执行日志写入 stderr。无需真实模型即可验证工具链：

```sh
LLM_PROVIDER=mock npm start
```

Mock 模式通过真实 `read_file` 同轮读取三个文件，并按文件名展示原始观察结果，
不模拟语义总结。真实模型则根据提示词综合说明各文件的信息领域。
如需准备演示数据，可以手动创建内容不同的 `a.txt`、`b.txt`、`c.txt`；
入口不会自动创建或覆盖这些文件。缺失文件的错误会反馈给模型，其他文件仍正常读取。
Mock 输出示例（取决于实际文件内容）：

```text
🚀 欢迎来到 go-tiny-claw 引擎启动序列
🤖 [对外回复]: a.txt：前端报错日志
b.txt：后端接口响应时间
c.txt：日期信息
```

stderr 中能看到四个工具挂载、慢思考开启、单轮三个 `read_file` 调用及聚合完成日志。
npm 也会显示脚本名称等运行提示。

## 第 08 讲：单轮工具并发与有序聚合

对应 [Go 第 08 讲引擎](../publication/column/timegeek/build-agent-harness-from-scratch/ch08/go-tiny-claw/internal/engine/loop.go)：
`internal/engine/loop.ts` 将同一轮的工具调用同时启动，等待所有结果后，
按模型原始调用顺序回填上下文，再开始下一轮。每条结果保留原始调用 ID；
工具返回 `isError=true` 时仍参与聚合，供模型纠错。

TypeScript 使用 `Promise.all(toolCalls.map(...))` 对应 Go 的预分配结果切片及
WaitGroup：结果数组的位置对应输入索引，不受完成先后顺序影响。
这是异步 I/O 并发，不是为每个工具创建 JavaScript 工作线程。
日志以 `Task-索引` 区分任务，日志完成顺序可能不同于上下文结果顺序。

本实现与课程一致，将同轮调用视为互相独立，不自动分析依赖或限制并发数量。
有先后依赖、编辑同一文件等操作应拆到不同轮；模型并不能保证永远正确区分依赖，
引擎也不提供文件冲突隔离。

### 奇迹时刻：并发工具执行

入口参照本讲示例，将 `AgentEngine` 的第四个参数设为 `true`，
开启独立 Thinking 阶段，并要求模型一次性读取 `a.txt`、`b.txt`、`c.txt` 后综合说明。
百炼/Ollama 配置和四种工具的注册保持不变。真实模型是否在同轮返回三个工具调用
取决于其实际决策；日志出现“模型请求并发调用 3 个工具”才表示形成了并发批次。
开启 Thinking 是课程的规划方式，并不是实现并发的必要条件。

## 验证与编译

```sh
npm run typecheck
npm test
npm run build
npm run start:built
```

编译产物位于 `dist/`，不提交到版本库。TypeScript 的 `internal/` 只是架构约定，
不像 Go 的 `internal` 目录那样由语言工具链强制限制外部导入。
