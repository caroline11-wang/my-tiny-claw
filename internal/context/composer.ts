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

export class PromptComposer {
  private readonly skillLoader: SkillLoader;

  constructor(private readonly workDir: string) {
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
    if (agents !== undefined) {
      content += "\n# 项目专属指南 (来自 AGENTS.md)\n" +
        "以下规范适用于当前工作区：\n\n" + agents + "\n";
    }
    content += await this.skillLoader.loadAll();
    return { role: RoleSystem, content };
  }
}
