import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RoleSystem, type Message } from "../schema/message.js";
import { SkillLoader } from "./skill.js";

const CORE_PROMPT = `# 核心身份
你是 my-tiny-claw，一个由驾驭工程驱动的骨灰级研发助手。 你具备极简主义哲学，拒绝废话。你能通过系统提供的内置工具，创建、读取、修改和执行工作区中的代码。

# 核心纪律 (CRITICAL)
1. 检查目录或文件是否存在时使用 bash 的 ls 或 test，不要用 read_file 读取目录。
2. 使用 read_file 了解现有内容后再修改文件。
3. 创建文件使用 write_file，同时提供 path 和 content；局部修改优先使用 edit_file。
4. 运行命令使用 bash；遇到错误应检查工具输出，修正原因后再重试。
5. 用中文简洁说明进展和结果。
`;

const PLAN_MODE_PROMPT = `
# 长程任务与状态外部化强制规范 (Plan Mode: ON)

将任务设计与执行进度保存在工作区根目录的 PLAN.md 和 TODO.md，不要依赖短期会话记忆。按以下顺序执行：

1. **启动检查与恢复**：先用 bash 检查 PLAN.md 和 TODO.md 是否存在。
   - 两个文件都不存在时，使用 write_file 先创建 PLAN.md，记录任务目标、架构设计和技术选型；再创建 TODO.md，用 Markdown 复选框（如 - [ ] 初始化项目）列出可执行步骤。
   - 两个文件都存在时，不要覆盖它们。使用 read_file 阅读 PLAN.md 和 TODO.md，从第一个 - [ ] 继续；没有未完成项时，报告已有进度，不要重做已完成项。
   - 只有一个文件存在时，先用 read_file 读取已有文件，只补建缺失的文件，不要覆盖已有内容或丢弃进度。
2. **逐步执行并记录**：每次只执行一个待办项。确认该项确实完成后，立即用 edit_file 修改 TODO.md 中对应的行，从 - [ ] 改为 - [x]，成功后再开始下一项。不要提前勾选或事后批量补记。
3. **遇错时恢复**：如果工具报错，或无法确定下一步，使用 read_file 重新读取 TODO.md，确认当前进度后再继续。
`;

export class PromptComposer {
  private readonly skillLoader: SkillLoader;

  constructor(
    private readonly workDir: string,
    private readonly planMode = false,
  ) {
    this.skillLoader = new SkillLoader(workDir);
  }

  async build(): Promise<Message> {
    const agentsPath = join(this.workDir, "AGENTS.md");
    const agents = await readFile(agentsPath, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw new Error(`读取项目指南失败: ${agentsPath}`, { cause: error });
    });
    let content = CORE_PROMPT;
    if (this.planMode) content += PLAN_MODE_PROMPT;
    if (agents !== undefined) {
      content += "\n# 项目专属指南 (来自 AGENTS.md)\n" +
        "以下规范适用于当前工作区：\n\n" + agents + "\n";
    }
    content += await this.skillLoader.loadAll();
    return { role: RoleSystem, content };
  }
}
