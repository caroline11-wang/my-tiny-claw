import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { PromptComposer } from "../internal/context/composer.ts";
import { parseSkillMD, SkillLoader } from "../internal/context/skill.ts";

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "tiny-claw-context-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeSkill(directory, relativePath, name, body = "执行前检查工作区。") {
  const path = join(directory, ".claw", "skills", relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\nname: ${name}\ndescription: 需要 ${name} 时使用\n---\n${body}\n`);
}

test("skill parsing extracts metadata and preserves Markdown, including thematic breaks", () => {
  assert.deepEqual(parseSkillMD(
    "---\nname: code-review\ndescription: Review changes: check --- carefully\nlicense: MIT\n---\n" +
    "# Steps\n\nRead the diff.\n\n---\n\nReport results.\n",
  ), {
    name: "code-review",
    description: "Review changes: check --- carefully",
    body: "# Steps\n\nRead the diff.\n\n---\n\nReport results.",
  });
});

test("skill parsing accepts CRLF, a UTF-8 BOM, and surrounding scalar quotes", () => {
  assert.deepEqual(parseSkillMD(
    '\uFEFF---\r\nname: "review"\r\ndescription: \'Review code\'\r\n---\r\n# Steps\r\nCheck tests.\r\n',
  ), {
    name: "review",
    description: "Review code",
    body: "# Steps\nCheck tests.",
  });
});

for (const [label, content, message] of [
  ["missing frontmatter", "# Only Markdown", /必须以 ---/u],
  ["unclosed frontmatter", "---\nname: review\n", /结束分隔符/u],
  ["inline closing delimiter", "---\nname: review\n---not-a-delimiter\n", /结束分隔符/u],
  ["missing description", "---\nname: review\n---\nSteps", /非空的 name 和 description/u],
  ["empty name", "---\nname: ''\ndescription: Review\n---\nSteps", /非空的 name 和 description/u],
  ["empty body", "---\nname: review\ndescription: Review\n---\n  ", /非空的 Markdown/u],
  ["duplicate metadata", "---\nname: a\nname: b\ndescription: Review\n---\nSteps", /字段重复/u],
  ["multiline scalar", "---\nname: review\ndescription: >-\n  Review\n---\nSteps", /仅支持单行文本/u],
  ["unclosed quotes", "---\nname: 'review\ndescription: Review\n---\nSteps", /引号未闭合/u],
]) {
  test(`skill parsing reports ${label}`, () => {
    assert.throws(() => parseSkillMD(content), message);
  });
}

test("missing and empty skill directories inject no skills heading", async (t) => {
  const directory = await workspace(t);
  const loader = new SkillLoader(directory);
  assert.equal(await loader.loadAll(), "");
  await mkdir(join(directory, ".claw", "skills"), { recursive: true });
  assert.equal(await loader.loadAll(), "");
  await writeFile(join(directory, ".claw", "skills", "README.md"), "Not a skill");
  assert.equal(await loader.loadAll(), "");
});

test("loader scans nested SKILL.md files in stable path order and ignores other files and symlinks", async (t) => {
  const directory = await workspace(t);
  await writeSkill(directory, "z-last/SKILL.md", "last", "Last instructions.");
  await writeSkill(directory, "a-first/nested/SKILL.md", "first", "First instructions.");
  await writeSkill(directory, "ignored/skill.md", "lowercase");
  await writeFile(join(directory, ".claw", "skills", "README.md"), "Not a skill");
  await mkdir(join(directory, "external"));
  await writeFile(join(directory, "external", "SKILL.md"), "Invalid external skill");
  await symlink(join(directory, "external"), join(directory, ".claw", "skills", "linked-directory"));
  await symlink(
    join(directory, "external", "SKILL.md"),
    join(directory, ".claw", "skills", "SKILL.md"),
  );

  const content = await new SkillLoader(directory).loadAll();
  assert.equal(content.match(/#### 技能名称:/gu)?.length, 2);
  assert.ok(content.indexOf("技能名称: first") < content.indexOf("技能名称: last"));
  assert.match(content, /\*\*触发条件\*\*: 需要 first 时使用/u);
  assert.match(content, /\*\*执行指南\*\*:\nFirst instructions\./u);
  assert.doesNotMatch(content, /lowercase|Invalid external skill|Not a skill/u);
});

test("loader reloads added, changed, and deleted skills without caching", async (t) => {
  const directory = await workspace(t);
  const loader = new SkillLoader(directory);
  await writeSkill(directory, "review/SKILL.md", "review", "Original instructions.");
  assert.match(await loader.loadAll(), /Original instructions/u);
  await writeSkill(directory, "review/SKILL.md", "review", "Updated instructions.");
  const updated = await loader.loadAll();
  assert.match(updated, /Updated instructions/u);
  assert.doesNotMatch(updated, /Original instructions/u);
  await writeSkill(directory, "test/SKILL.md", "test");
  assert.match(await loader.loadAll(), /技能名称: test/u);
  await rm(join(directory, ".claw", "skills", "review"), { recursive: true });
  assert.doesNotMatch(await loader.loadAll(), /技能名称: review/u);
});

test("malformed skills report their source path and parsing cause", async (t) => {
  const directory = await workspace(t);
  const path = join(directory, ".claw", "skills", "broken", "SKILL.md");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "---\nname: broken\n---\nBody");
  await assert.rejects(new SkillLoader(directory).loadAll(), (error) => {
    assert.ok(error.message.includes(path));
    assert.match(error.cause.message, /非空的 name 和 description/u);
    return true;
  });
});

test("a skill root that is not a directory fails explicitly", async (t) => {
  const directory = await workspace(t);
  await mkdir(join(directory, ".claw"));
  await writeFile(join(directory, ".claw", "skills"), "Not a directory");
  await assert.rejects(new SkillLoader(directory).loadAll(), (error) => {
    assert.match(error.message, /扫描技能目录失败/u);
    assert.equal(error.cause.code, "ENOTDIR");
    return true;
  });
});

test("composer builds a system message with only the core when optional files are absent", async (t) => {
  const directory = await workspace(t);
  const message = await new PromptComposer(directory).build();
  assert.deepEqual(Object.keys(message).sort(), ["content", "role"]);
  assert.equal(message.role, "system");
  assert.match(message.content, /my-tiny-claw/u);
  assert.match(message.content, /read_file/u);
  assert.match(message.content, /write_file/u);
  assert.match(message.content, /edit_file/u);
  assert.match(message.content, /bash/u);
  assert.doesNotMatch(message.content, /项目专属指南|可用专业技能/u);
});

test("composer orders core, workspace guidelines, and skills, reloading on every build", async (t) => {
  const directory = await workspace(t);
  const composer = new PromptComposer(directory);
  const guide = "# Guidelines\nUse TypeScript.\n```sh\nnpm test\n```\n";
  await writeFile(join(directory, "AGENTS.md"), guide);
  await writeSkill(directory, "review/SKILL.md", "review", "Check the test suite.");
  const first = await composer.build();
  assert.ok(first.content.includes(guide));
  assert.ok(first.content.indexOf("# 核心身份") < first.content.indexOf("# 项目专属指南"));
  assert.ok(first.content.indexOf("# 项目专属指南") < first.content.indexOf("### 可用专业技能"));
  assert.match(first.content, /Check the test suite/u);

  await writeFile(join(directory, "AGENTS.md"), "Updated workspace guidelines.");
  await rm(join(directory, ".claw"), { recursive: true });
  const second = await composer.build();
  assert.match(second.content, /Updated workspace guidelines/u);
  assert.doesNotMatch(second.content, /Use TypeScript|可用专业技能/u);
  await rm(join(directory, "AGENTS.md"));
  assert.doesNotMatch((await composer.build()).content, /项目专属指南/u);
});

test("composer propagates non-missing AGENTS.md read errors", async (t) => {
  const directory = await workspace(t);
  await mkdir(join(directory, "AGENTS.md"));
  await assert.rejects(new PromptComposer(directory).build(), (error) => {
    assert.ok(error.message.includes(join(directory, "AGENTS.md")));
    assert.equal(error.cause.code, "EISDIR");
    return true;
  });
});
