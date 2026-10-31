import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ReadFileTool } from "../internal/tools/read_file.ts";
import { ToolRegistry } from "../internal/tools/registry.ts";

const signal = new AbortController().signal;

test("registry discovers tools and dispatches arguments and cancellation signal", async () => {
  const registry = new ToolRegistry();
  assert.deepEqual(registry.getAvailableTools(), []);
  const args = { path: "hello.txt" };
  const definition = {
    name: "example",
    description: "Example",
    inputSchema: { type: "object" },
  };
  registry.register({
    name: () => "example",
    definition: () => definition,
    execute: async (receivedSignal, receivedArgs) => {
      assert.equal(receivedSignal, signal);
      assert.equal(receivedArgs, args);
      return "result";
    },
  });
  assert.deepEqual(registry.getAvailableTools(), [definition]);
  assert.deepEqual(await registry.execute(signal, {
    id: "call_1",
    name: "example",
    arguments: args,
  }), { toolCallId: "call_1", output: "result", isError: false });
});

test("registry replaces duplicate tools and returns errors as observations", async () => {
  const registry = new ToolRegistry();
  const tool = {
    name: () => "example",
    definition: () => ({
      name: "example",
      description: "Example",
      inputSchema: {},
    }),
    execute: async () => "old",
  };
  registry.register(tool);
  registry.register({ ...tool, execute: async () => "new" });
  const call = { id: "call_2", name: "example", arguments: {} };
  assert.equal((await registry.execute(signal, call)).output, "new");
  assert.equal(registry.getAvailableTools().length, 1);

  registry.register({
    ...tool,
    execute: async () => { throw new Error("read failed"); },
  });
  assert.deepEqual(await registry.execute(signal, call), {
    toolCallId: "call_2",
    output: "Error executing example: read failed",
    isError: true,
  });
  assert.deepEqual(await registry.execute(signal, { ...call, name: "missing" }), {
    toolCallId: "call_2",
    output: "Error: 系统中不存在名为 'missing' 的工具。",
    isError: true,
  });
});

test("read_file reads workspace-relative files through the registry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiny-claw-read-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "nested"));
  await writeFile(join(directory, "nested", "hello.txt"), "你好，文件内容。\n");
  const tool = new ReadFileTool(directory);
  assert.equal(tool.name(), "read_file");
  assert.deepEqual(tool.definition().inputSchema.required, ["path"]);
  assert.equal(tool.definition().inputSchema.properties.path.type, "string");
  const registry = new ToolRegistry();
  registry.register(tool);
  assert.deepEqual(await registry.execute(signal, {
    id: "read_1",
    name: "read_file",
    arguments: { path: "nested/hello.txt" },
  }), { toolCallId: "read_1", output: "你好，文件内容。\n", isError: false });
});

test("read_file truncates only above 8000 bytes, not 8000 characters", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiny-claw-limit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tool = new ReadFileTool(directory);
  for (const size of [0, 7999, 8000, 8001]) {
    await writeFile(join(directory, "data.txt"), "a".repeat(size));
    const result = await tool.execute(signal, { path: "data.txt" });
    assert.equal(
      result,
      size > 8000
        ? `${"a".repeat(8000)}\n\n...[由于内容过长，已被系统截断至前 8000 字节]...`
        : "a".repeat(size),
    );
  }
  const multibyte = "你好".repeat(2000);
  await writeFile(join(directory, "data.txt"), multibyte);
  const result = await tool.execute(signal, { path: "data.txt" });
  assert.equal(
    result,
    `${Buffer.from(multibyte).subarray(0, 8000).toString("utf8")}\n\n...[由于内容过长，已被系统截断至前 8000 字节]...`,
  );
});

test("read_file rejects invalid input and reports I/O and cancellation failures", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiny-claw-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tool = new ReadFileTool(directory);
  for (const args of [null, [], 123, "file.txt", {}, { path: 1 }, { path: " " }]) {
    await assert.rejects(tool.execute(signal, args), /参数解析失败/u);
  }
  const registry = new ToolRegistry();
  registry.register(tool);
  const missing = await registry.execute(signal, {
    id: "missing",
    name: "read_file",
    arguments: { path: "missing.txt" },
  });
  assert.equal(missing.isError, true);
  assert.equal(missing.toolCallId, "missing");
  assert.match(missing.output, /Error executing read_file:.*ENOENT/u);
  await writeFile(join(directory, "data.txt"), "data");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    tool.execute(controller.signal, { path: "data.txt" }),
    (error) => error.cause?.name === "AbortError",
  );
});
