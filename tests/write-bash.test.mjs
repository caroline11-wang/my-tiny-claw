import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BashTool } from "../internal/tools/bash.ts";
import { ToolRegistry } from "../internal/tools/registry.ts";
import { WriteFileTool } from "../internal/tools/write_file.ts";

const signal = new AbortController().signal;

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "tiny-claw-write-bash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("write_file creates parents, overwrites content, and permits empty files", async (t) => {
  const directory = await workspace(t);
  const tool = new WriteFileTool(directory);
  assert.equal(tool.name(), "write_file");
  assert.deepEqual(tool.definition().inputSchema.required, ["path", "content"]);
  const path = "nested/deeper/hello.txt";
  for (const content of ["你好，文件！\n", "replacement", ""]) {
    assert.equal(
      await tool.execute(signal, { path, content }),
      `成功将内容写入到文件: ${path}`,
    );
    assert.equal(await readFile(join(directory, path), "utf8"), content);
  }
});

test("write_file validates arguments and surfaces directory and write errors", async (t) => {
  const directory = await workspace(t);
  const tool = new WriteFileTool(directory);
  for (const args of [
    null, [], "file", {}, { path: "" }, { path: " ", content: "" },
    { path: 1, content: "" }, { path: "hello.txt", content: 1 },
  ]) {
    await assert.rejects(tool.execute(signal, args), /参数解析失败/u);
  }
  await writeFile(join(directory, "parent"), "not a directory");
  await assert.rejects(
    tool.execute(signal, { path: "parent/hello.txt", content: "data" }),
    /创建父目录失败/u,
  );
  await assert.rejects(
    tool.execute(signal, { path: ".", content: "data" }),
    /写入文件失败/u,
  );
  await assert.rejects(
    tool.execute(AbortSignal.abort(), { path: "cancelled.txt", content: "data" }),
    { name: "AbortError" },
  );
});

test("registry composes write_file and bash using the same workspace", async (t) => {
  const directory = await workspace(t);
  const registry = new ToolRegistry();
  registry.register(new WriteFileTool(directory));
  registry.register(new BashTool(directory));
  assert.deepEqual(
    registry.getAvailableTools().map((definition) => definition.name),
    ["write_file", "bash"],
  );
  const written = await registry.execute(signal, {
    id: "write_1", name: "write_file",
    arguments: { path: "hello.txt", content: "actual file content\n" },
  });
  assert.equal(written.isError, false);
  assert.deepEqual(await registry.execute(signal, {
    id: "bash_1", name: "bash", arguments: { command: "cat hello.txt" },
  }), {
    toolCallId: "bash_1", output: "actual file content\n", isError: false,
  });
});

test("bash uses cwd, supports chaining, and combines stdout and stderr", async (t) => {
  const directory = await workspace(t);
  const tool = new BashTool(directory);
  assert.equal(tool.name(), "bash");
  assert.deepEqual(tool.definition().inputSchema.required, ["command"]);
  assert.equal(
    await tool.execute(signal, { command: "printf '%s' \"$PWD\"" }),
    await realpath(directory),
  );
  assert.equal(
    await tool.execute(signal, { command: "printf first && printf second >&2 && printf third" }),
    "firstsecondthird",
  );
  assert.equal(
    await tool.execute(signal, { command: ":" }),
    "命令执行成功，无终端输出。",
  );
  assert.equal(
    await tool.execute(signal, { command: "printf failed >&2; exit 7" }),
    "执行报错: exit status 7\n输出:\nfailed",
  );
});

test("bash enforces the 8000-byte output limit on both success and failure", async (t) => {
  const directory = await workspace(t);
  const tool = new BashTool(directory);
  for (const size of [8000, 8001]) {
    await writeFile(join(directory, "output.txt"), "a".repeat(size));
    for (const fail of [false, true]) {
      const result = await tool.execute(signal, {
        command: `cat output.txt${fail ? "; exit 2" : ""}`,
      });
      assert.equal(
        result,
        `${fail ? "执行报错: exit status 2\n输出:\n" : ""}${"a".repeat(Math.min(size, 8000))}${
          size > 8000 ? "\n\n...[终端输出过长，已截断至前 8000 字节]..." : ""
        }`,
      );
    }
  }
  const content = "你好".repeat(2000);
  await writeFile(join(directory, "output.txt"), content);
  assert.equal(
    await tool.execute(signal, { command: "cat output.txt" }),
    `${Buffer.from(content).subarray(0, 8000).toString("utf8")}\n\n...[终端输出过长，已截断至前 8000 字节]...`,
  );
});

test("bash rejects invalid arguments, missing cwd, and pre-cancelled execution", async (t) => {
  const directory = await workspace(t);
  const tool = new BashTool(directory);
  for (const args of [null, [], "pwd", {}, { command: 1 }, { command: " " }]) {
    await assert.rejects(tool.execute(signal, args), /参数解析失败/u);
  }
  await assert.rejects(
    new BashTool(join(directory, "missing")).execute(signal, { command: "pwd" }),
    /命令启动或执行失败:.*ENOENT/u,
  );
  await assert.rejects(
    tool.execute(AbortSignal.abort(), { command: "pwd" }),
    { name: "AbortError" },
  );
});

test("bash cancellation terminates a running command promptly", async (t) => {
  const directory = await workspace(t);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  t.after(() => clearTimeout(timer));
  await assert.rejects(
    new BashTool(directory).execute(controller.signal, { command: "exec sleep 60" }),
    { name: "AbortError" },
  );
});

test("bash terminates a command at the actual 30-second deadline", { timeout: 40_000 }, async (t) => {
  const directory = await workspace(t);
  const start = performance.now();
  const result = await new BashTool(directory).execute(signal, {
    command: "printf started; exec sleep 60",
  });
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 29_500 && elapsed < 38_000, `elapsed=${elapsed}ms`);
  assert.equal(result, "started\n[警告: 命令执行超时(30s)，已被系统强制终止。]");
});
