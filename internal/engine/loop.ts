import type { LLMProvider } from "../provider/interface.js";
import {
  RoleSystem,
  RoleUser,
  type Message,
} from "../schema/message.js";
import type { Registry } from "../tools/registry.js";

export class AgentEngine {
  constructor(
    private readonly provider: LLMProvider,
    private readonly registry: Registry,
    readonly workDir: string,
    readonly enableThinking: boolean = false,
  ) {}

  async run(signal: AbortSignal, userPrompt: string): Promise<string> {
    console.error(`[Engine] 引擎启动，锁定工作区: ${this.workDir}`);
    console.error(`[Engine] 慢思考模式 (Thinking Phase): ${this.enableThinking}`);

    const contextHistory: Message[] = [
      {
        role: RoleSystem,
        content:
          "You are go-tiny-claw, an expert coding assistant. You have full access to tools in the workspace.",
      },
      { role: RoleUser, content: userPrompt },
    ];

    let turnCount = 0;

    while (true) {
      turnCount += 1;
      console.error(`========== [Turn ${turnCount}] 开始 ==========`);

      const availableTools = this.registry.getAvailableTools();

      if (this.enableThinking) {
        console.error("[Engine][Phase 1] 剥夺工具访问权，强制进入慢思考与规划阶段...");

        let thinkResponse: Message;
        try {
          thinkResponse = await this.provider.generate(signal, contextHistory, []);
        } catch (error) {
          throw new Error("Thinking 阶段生成失败", { cause: error });
        }

        if (thinkResponse.content !== "") {
          console.log(`🧠 [内部思考 Trace]: ${thinkResponse.content}`);
          contextHistory.push(thinkResponse);
        }
      }

      console.error("[Engine][Phase 2] 恢复工具挂载，等待模型采取行动...");

      let response: Message;
      try {
        response = await this.provider.generate(
          signal,
          contextHistory,
          availableTools,
        );
      } catch (error) {
        throw new Error("Action 阶段生成失败", { cause: error });
      }

      contextHistory.push(response);

      if (response.content !== "") {
        console.log(`🤖 [对外回复]: ${response.content}`);
      }

      const toolCalls = response.toolCalls ?? [];
      if (toolCalls.length === 0) {
        console.error("[Engine] 模型未请求调用工具，任务宣告完成。");
        return response.content;
      }

      console.error(`[Engine] 模型请求并发调用 ${toolCalls.length} 个工具...`);

      const observationMsgs = await Promise.all(toolCalls.map(async (toolCall, index): Promise<Message> => {
        console.error(
          `  -> [Task-${index}] 🛠️ 执行工具: ${toolCall.name}, 参数: ${JSON.stringify(toolCall.arguments)}`,
        );

        const result = await this.registry.execute(signal, toolCall);
        if (result.isError) {
          console.error(`  -> [Task-${index}] ❌ 工具执行报错: ${result.output}`);
        } else {
          console.error(
            `  -> [Task-${index}] ✅ 工具执行成功 (返回 ${Buffer.byteLength(result.output)} 字节)`,
          );
        }

        return {
          role: RoleUser,
          content: result.output,
          toolCallId: toolCall.id,
        };
      }));

      console.error("[Engine] 所有并发工具执行完毕，开始聚合观察结果 (Observation)...");
      for (const observation of observationMsgs) {
        contextHistory.push(observation);
      }
    }
  }
}
