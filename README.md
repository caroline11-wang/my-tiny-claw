# my-tiny-claw：Agent Harness TypeScript 实现

本项目从《从 0 开始构建 Agent Harness》第 01 讲的项目骨架开始，
并实现第 02 至 07 讲中的 Schema、Provider、Main Loop、工具注册分发及
read_file、write_file、bash、edit_file 工具。
第 08 讲支持单轮工具并发，第 10 讲增加 Skill 加载与动态系统提示词组装；
第 11 讲增加 Session，第 12 讲加入上下文压缩；
HTTP 入口用于 AgentRun 部署，与 CLI 共享同一套引擎。
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
│   ├── context/
│   │   ├── skill.ts         # SKILL.md 解析、递归扫描与技能格式化
│   │   ├── composer.ts      # 核心规则 + AGENTS.md + Skills
│   │   ├── session.ts       # Session 历史、Working Memory 与进程内管理器
│   │   └── compactor.ts     # 上下文阶梯压缩
│   ├── tools/               # 工具注册、执行与中间件
│   ├── memory/              # 文件系统记忆与待办
│   └── feishu/              # 飞书交互集成
├── tests/
│   ├── context.test.mjs     # 技能解析、文件加载与动态提示词验证
│   ├── session.test.mjs     # Session 历史窗口与管理器隔离测试
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

`AgentEngine` 保留 `enableThinking` 开关；当前第 10 讲 CLI 入口将其开启。
Thinking 开关开启时，每轮先以空工具列表请求规划，再提供工具定义
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
工作区内容。当前任务是在独立的 `workspace/` 创建 `ping.ts` 并本地提交，
运行前请完成下文第 10 讲的环境准备。想先离线验证工具链，可运行：

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

第 07 讲的实战任务是修改 `server.go` 的鉴权片段；当前入口已切换为第 10 讲的接口创建与提交。
可以通过测试离线验证 L4 缩进容错：

```sh
node --import tsx --test tests/edit-file.test.mjs
```

项目保留 `server.go` 示例文件供 Edit 测试使用。当前真实模型入口执行第 10 讲任务，
需先完成下文的独立工作区准备：

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
# 先完成下文第 10 讲的 workspace Git 初始化
npm start
```

入口保留 `go-tiny-claw` 的欢迎文本方便与 Go 示例对照。模型文本写入 stdout，
引擎进度和工具执行日志写入 stderr。无需真实模型即可验证工具链：

```sh
LLM_PROVIDER=mock npm start
```

MockProvider 保持第 08 讲原样：始终通过真实 `read_file` 同轮读取三个文件，
不会执行第 10 讲的创建接口与提交任务，也不能用于验证模型是否遵循技能。
如需准备 Mock 数据，可以在 `workspace/` 手动创建内容不同的 `a.txt`、`b.txt`、`c.txt`；
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

第 08 讲曾将 `AgentEngine` 的第四个参数设为 `true`，开启独立 Thinking 阶段，
并要求模型一次性读取三个文件。当前 CLI 任务已切换为第 10 讲，但并发能力及
MockProvider 的三文件读取行为保持不变。
百炼/Ollama 配置和四种工具的注册保持不变。真实模型是否在同轮返回三个工具调用
取决于其实际决策；日志出现“模型请求并发调用 3 个工具”才表示形成了并发批次。
开启 Thinking 是课程的规划方式，并不是实现并发的必要条件。

## 第 10 讲：Skill 加载与 Prompt Composer

对应 [Go 第 10 讲示例](../publication/column/timegeek/build-agent-harness-from-scratch/ch10/go-tiny-claw/)：

1. `internal/context/skill.ts` 定义 `Skill` 和 `SkillLoader`。递归查找工作区
   `.claw/skills/` 下名称精确为 `SKILL.md` 的普通文件，按路径稳定排序，
   将名称、触发条件和 Markdown 执行指南格式化为技能区块；不跟随符号链接。
2. `internal/context/composer.ts` 的 `PromptComposer.build()` 异步返回一条
   `role: "system"` 消息，顺序为核心身份与工具纪律、工作区根目录的 `AGENTS.md`、
   全部技能。核心规则保留先读后改，并区分 `write_file` 创建与 `edit_file` 局部修改。
3. `internal/engine/loop.ts` 在每次 `run()` 开始时根据 Session 工作区调用 Composer，替代旧的硬编码
   系统消息；本次运行中的 Thinking、Action 和后续工具轮次共用这条消息。
   下一次 `run()` 会重新读取文件，无需重新创建引擎；不在每个工具轮次热更新。

配置放在**引擎实际工作区**中：

```text
工作区/
├── AGENTS.md
└── .claw/
    └── skills/
        └── review/
            └── SKILL.md
```

`AGENTS.md` 可以描述项目使用 TypeScript、修改后需要运行哪些测试等工作区规范。
`SKILL.md` 的最小示例：

```markdown
---
name: review
description: 需要检查代码改动时使用
---
# 检查流程
1. 阅读改动及相关测试。
2. 检查行为是否保持一致。
3. 汇报问题及验证结果。
```

与课程一样不引入 YAML 依赖：Frontmatter 以独立一行的 `---` 开始和结束，
必填的 `name`、`description` 使用单行文本，可以加成对的单引号或双引号。
支持 LF、CRLF 和 UTF-8 BOM；这不是完整 YAML 解析器，不解析转义、折叠/多行
标量或复杂结构。其他元数据不参与提示词组装，脚本和参考资料也不会被自动执行或加载。
技能正文可以包含 Markdown 分隔线和代码块。

未配置 `AGENTS.md` 或技能目录时只使用核心规则；空技能目录不会生成空的技能标题。
与课程示例的静默降级不同，本实现对缺失必填元数据、空正文、重复字段、未闭合
分隔符/引号及文件系统读取错误显式抛错，保留来源路径和原始 cause，
在调用模型前中止，不用 `Unknown Skill` 掩盖配置问题。

CLI 的工作区是启动目录下的 `workspace/`；HTTP/AgentRun 的工作区是 `AGENT_WORK_DIR`，
未设置时为进程当前目录。两个入口无需分别接线，都会通过共享的 `AgentEngine`
加载规范和技能。部署时还需把这些配置文件放入部署包中的工作区，详见
[AgentRun 部署指南](./deploy/AgentRun部署指南.md#第-10-讲工作区规范与技能)。

当前遵循第 10 讲的**全量注入**方式：所有技能正文都会进入系统提示词，
由模型根据 description 判断适用场景；没有实现语义检索或按需读取正文。
这些文件是受信任的提示词配置，不是强制权限控制，只应从可信来源加载。
现有 Mock Provider 仅用于验证工具链，不会像真实模型一样执行技能的语义指令。

## 第 11 讲：Session 与 Session 驱动的 AgentEngine

对应 [Go 第 11 讲示例](../publication/column/timegeek/build-agent-harness-from-scratch/ch11/go-tiny-claw/internal/context/session.go)，
新增的 `internal/context/session.ts` 提供：

- `Session` 保存会话 `id`、绑定的 `workDir`、创建/更新时间及私有 `Message` 历史。
- `append(message)` 追加消息并更新时间；存储和返回消息都做结构化复制，避免调用方修改历史。
- `getWorkingMemory(limit)` 返回历史副本。`limit <= 0` 返回全部；正数返回最近消息。
  如果窗口开头是带 `toolCallId` 的用户工具结果，会继续丢弃该孤立结果，避免保留已被截掉的工具调用观察。
- `SessionManager.getOrCreate(id, workDir)` 按 ID 复用会话；已存在时保留该会话最初绑定的工作区。
  `GlobalSessionMgr` 是进程内全局实例。不同 ID 对应独立历史；该 Map 不持久化，不跨进程共享。

第 2 步中，`AgentEngine` 不再持有固定 `workDir` 或 Composer，构造方式为
`new AgentEngine(provider, registry, enableThinking)`，运行方式改为
`run(signal, session): Promise<string>`：

1. 调用方先把用户消息写入 Session，再调用引擎；引擎不重复追加用户输入。
2. 每次 `run()` 根据 `session.workDir` 组装最新的 System Prompt；系统消息不存入会话历史。
3. 每个工具轮次重新读取 `session.getWorkingMemory(20)`，形成 System Prompt + 最近消息。
   非空 Thinking 回复会同时追加到 Session 和当前 Action 上下文；Action 回复始终保存到 Session。
   当前轮次的 Thinking 可以使 Action 实际看到超过 20 条非系统消息。
4. 并发工具全部完成后，按原始调用顺序把观察结果写入 Session，再开始下一轮。
   完整历史保留在内存中，20 条窗口只限制发给模型的历史，不裁掉 Session 的存档。
5. 复用同一个 Session 可以保留前次调用的历史；不同 Session 不共用历史。
   同一个 Session 的 `run()` 应顺序调用，本实现没有加入请求级排队或跨进程锁。

```ts
const engine = new AgentEngine(provider, registry, true);
const session = GlobalSessionMgr.getOrCreate("terminal", workDir);
session.append({ role: "user", content: "请说明当前项目" });
const reply = await engine.run(new AbortController().signal, session);
```

CLI 已适配为先追加任务消息再运行 Session；仍是单次任务入口，不增加交互循环或飞书。
HTTP/AgentRun 通过 `X-AgentRun-Session-ID` 请求头按 ID 复用进程内 Session，
保留跨请求历史；请求头缺失或为空时生成一次性 ID，仍为独立上下文。
服务日志输出 Session ID 及其来源。历史在进程重启后丢失，多实例部署须确保同一
Session ID 的请求路由到同一实例；同一会话的请求应顺序发送。
MockProvider 与模型装配逻辑均不变。

注意：工具实例仍在入口注册时绑定物理工作区。Registry 内工具的工作区必须与
Session 工作区一致；切换物理工作区时应装配对应的 Registry/引擎。
Session 的历史隔离不等于文件系统沙箱，也不会自动重绑定工具路径。
课程的孤立工具结果保护只检查窗口开头，并非完整的工具调用协议修复器。

验证：

```sh
node --import tsx --test tests/session.test.mjs tests/engine.test.mjs tests/skeleton.test.mjs
```

离线验证：

```sh
node --import tsx --test tests/context.test.mjs tests/engine.test.mjs tests/skeleton.test.mjs
```

### 运行与实战测试：准备环境

已提供 `workspace/AGENTS.md` 和 `workspace/.claw/skills/git-workflow/SKILL.md`。
前者约束 TypeScript、JSON 响应和中文错误信息；后者约束 Git 检查、Emoji 提交消息
及明确的暂存范围。相对 Go 示例，任务改为生成 `ping.ts`，不需要 Go 环境。

先将这两份配置作为普通文件保存到主项目的版本库，再初始化独立工作区，
避免主项目将未跟踪的嵌套仓库误记录为 gitlink。环境准备由你手动执行一次，
本次修改不自动初始化、提交或调用真实模型。

从 `my-tiny-claw/` 根目录执行：

```sh
git -C workspace init -b main
git -C workspace add AGENTS.md .claw/skills/git-workflow/SKILL.md
git -C workspace commit -m "Prepare chapter 10 workspace" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Git 需要已配置正确的提交身份；缺少身份时请自行配置该工作区的本地
`user.name`、`user.email`，不需要设置远端。入口会拒绝缺失的工作区或非独立仓库，
避免 Git 向上找到主项目。这个检查不是文件系统沙箱。

### 触发测试：在终端唤醒 Agent

完成准备后，在主项目根目录执行 `npm start`（百炼）或 `npm run start:ollama`。
保留原有 Provider 装配，不新增演示模式，不修改 MockProvider。
入口开启 Thinking，要求创建 HTTP ping 接口并本地提交，但不在用户任务中重复写入
JSON 和 Emoji 规则；它们来自工作区规范和技能。未实现飞书，因此沿用现有终端日志，
不引入 TerminalReporter。第 11 讲接入后，入口先把任务写入 Session，再调用
`AgentEngine.run(signal, session)`，任务内容与工作区保持不变。

真实模型会产生调用费用（取决于服务）并执行文件写入及本地 Git 操作。
结束后检查：

```sh
git -C workspace log -1 --format=%B
git -C workspace show --stat HEAD
git -C workspace status --short
```

确认最新任务提交以 Emoji 和类型开头，仅包含任务文件，而不是把初始准备提交
误当成任务成功。重复运行前先检查已有变更，不需要修改时不应创建空提交。

启动模型生成的接口（默认约定为本地 8080 端口）：

```sh
node --import tsx workspace/ping.ts
```

另开终端验证，再用 Ctrl+C 关闭服务：

```sh
curl -i http://127.0.0.1:8080/ping
# 预期 HTTP 200，JSON 为 {"code":200,"message":"pong"}
```

Mock 模式仍只读取 `workspace/a.txt`、`b.txt`、`c.txt`，缺失文件会产生工具错误观察；
不会创建 `ping.ts` 或 Git 提交。真实规范遵循效果需要用真实模型实跑确认。
HTTP/AgentRun 入口不随 CLI 改变默认工作区；如需复用配置，可把 `AGENT_WORK_DIR`
指向对应 `workspace/`，或将配置放入 HTTP 的工作区根目录。

## 第 12 讲：Context Compaction

`internal/context/compactor.ts` 参考第 12 讲的 Go 示例：每轮取最近 20 条历史，
按消息内容及工具名称、JSON 参数的 UTF-8 字节估算长度；达到 3000 字节时触发压缩，
保护最近 6 条消息。远期超过 200 字节的工具结果被掩码，远期超过 200 字节的
assistant 内容被折叠；近期超过 1000 字节的工具结果保留前后各不超过 500 字节，
在 Unicode 字符边界截断。系统提示词、工具调用及其 ID 保持不变。

压缩只作用于发给 Provider 的临时消息，不修改 Session 原始历史。Thinking 请求前
压缩一次；若 Thinking 产生新消息，Action 请求前基于原始上下文重新压缩，避免
新增内容跨过阈值时漏检。该策略不是 Token 精确计数或硬上限：用户消息、系统提示、
近期 assistant 内容和工具参数可能仍导致请求超限；它也不限制 Session 的内存增长。

```sh
node --import tsx --test tests/compactor.test.mjs tests/engine.test.mjs
```

## 验证与编译

```sh
npm run typecheck
npm test
npm run build
npm run start:built
```

编译产物位于 `dist/`，不提交到版本库。TypeScript 的 `internal/` 只是架构约定，
不像 Go 的 `internal` 目录那样由语言工具链强制限制外部导入。
