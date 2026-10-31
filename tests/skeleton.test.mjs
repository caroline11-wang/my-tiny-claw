import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("the mock provider requests three real file reads in one turn with thinking enabled", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiny-claw-entry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contents = ["前端报错日志", "后端接口响应时间", "日期信息"];
  for (const [index, path] of ["a.txt", "b.txt", "c.txt"].entries()) {
    await writeFile(join(directory, path), contents[index]);
  }
  const result = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), join(projectRoot, "cmd/claw/main.ts")],
    {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, LLM_PROVIDER: "mock" },
      timeout: 90_000,
    },
  );

  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[LLM\] 当前连接: provider=mock, model=mock/u);
  assert.match(result.stdout, /🚀 欢迎来到 go-tiny-claw 引擎启动序列/);
  for (const [index, path] of ["a.txt", "b.txt", "c.txt"].entries()) {
    assert.ok(result.stdout.includes(`${path}：${contents[index]}`));
    assert.equal(await readFile(join(directory, path), "utf8"), contents[index]);
    assert.ok(result.stderr.includes(`执行工具: read_file, 参数: {"path":"${path}"}`));
  }
  assert.match(result.stderr, /慢思考模式 \(Thinking Phase\): true/u);
  assert.match(result.stderr, /\[Phase 1\]/u);
  assert.match(result.stderr, /模型请求并发调用 3 个工具/u);
  assert.match(result.stderr, /\[Turn 1\] 开始/);
  assert.match(result.stderr, /\[Phase 2\].*恢复工具挂载/);
  for (const tool of ["read_file", "write_file", "bash", "edit_file"]) {
    assert.ok(result.stderr.includes(`[Registry] 成功挂载工具: ${tool}`));
  }
  assert.doesNotMatch(result.stderr, /执行工具: (write_file|edit_file|bash)/u);
  assert.match(result.stderr, /工具执行成功/u);
  assert.match(result.stderr, /任务宣告完成/);
});

test("missing files remain visible while successful file observations are preserved", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiny-claw-entry-error-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "b.txt"), "available content");
  const result = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), join(projectRoot, "cmd/claw/main.ts")],
    {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, LLM_PROVIDER: "mock" },
      timeout: 10_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /a\.txt：Error executing read_file:/u);
  assert.match(result.stdout, /b\.txt：available content/u);
  assert.match(result.stdout, /c\.txt：Error executing read_file:/u);
  assert.match(result.stderr, /模型请求并发调用 3 个工具/u);
  assert.match(result.stderr, /任务宣告完成/u);
});

test("the real provider requires API credentials from the environment", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "cmd/claw/main.ts"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        LLM_PROVIDER: "bailian",
        LLM_API_KEY: "",
        LLM_BASE_URL: "",
        LLM_MODEL: "",
      },
    },
  );

  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LLM_API_KEY is required/u);
});

test("the architecture preserves the course module directories", () => {
  for (const directory of [
    "cmd/claw",
    "internal/schema",
    "internal/engine",
    "internal/provider",
    "internal/context",
    "internal/tools",
    "internal/memory",
    "internal/feishu",
  ]) {
    assert.ok(statSync(new URL(`../${directory}/`, import.meta.url)).isDirectory(), directory);
  }
});
