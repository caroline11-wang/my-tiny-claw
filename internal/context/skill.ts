import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export function parseSkillMD(content: string): Skill {
  const lines = content.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  if (lines[0] !== "---") {
    throw new Error("SKILL.md 必须以 --- 开始的 Frontmatter 声明 name 和 description");
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closingIndex === -1) {
    throw new Error("SKILL.md Frontmatter 缺少独立一行的结束分隔符 ---");
  }

  const metadata = new Map<string, string>();
  for (const line of lines.slice(1, closingIndex)) {
    const match = /^(name|description):[ \t]*(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2]?.trim();
    if (key === undefined || rawValue === undefined) continue;
    if (metadata.has(key)) {
      throw new Error(`SKILL.md Frontmatter 字段重复: ${key}`);
    }
    if (/^[|>]/u.test(rawValue)) {
      throw new Error(`SKILL.md ${key} 仅支持单行文本，不支持 YAML 多行标量`);
    }

    let value = rawValue;
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (value.length < 2 || !value.endsWith(quote)) {
        throw new Error(`SKILL.md ${key} 的引号未闭合`);
      }
      value = value.slice(1, -1).trim();
    }
    metadata.set(key, value);
  }

  const name = metadata.get("name");
  const description = metadata.get("description");
  if (!name || !description) {
    throw new Error("SKILL.md Frontmatter 必须提供非空的 name 和 description");
  }
  const body = lines.slice(closingIndex + 1).join("\n").trim();
  if (!body) {
    throw new Error("SKILL.md 必须提供非空的 Markdown 执行指南");
  }
  return { name, description, body };
}

export class SkillLoader {
  constructor(private readonly workDir: string) {}

  async loadAll(): Promise<string> {
    const skills = await this.loadDirectory(join(this.workDir, ".claw", "skills"), true);
    if (skills.length === 0) return "";

    const sections = skills.map((skill) =>
      `#### 技能名称: ${skill.name}\n` +
      `**触发条件**: ${skill.description}\n\n` +
      `**执行指南**:\n${skill.body}\n\n---\n`,
    );
    return "\n### 可用专业技能 (Agent Skills)\n" +
      "请根据各技能的触发条件选择适用流程，并遵循对应的执行指南。\n\n" +
      sections.join("\n");
  }

  private async loadDirectory(directory: string, optional = false): Promise<Skill[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (optional && error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw new Error(`扫描技能目录失败: ${directory}`, { cause: error });
    });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

    const skills: Skill[] = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        skills.push(...await this.loadDirectory(path));
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        try {
          skills.push(parseSkillMD(await readFile(path, "utf8")));
        } catch (error) {
          throw new Error(`加载技能失败: ${path}`, { cause: error });
        }
      }
    }
    return skills;
  }
}
