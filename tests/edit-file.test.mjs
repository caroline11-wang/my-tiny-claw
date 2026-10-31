import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EditFileTool } from "../internal/tools/edit_file.ts";
import { ToolRegistry } from "../internal/tools/registry.ts";

async function createTool(t) {
  const workDir = await mkdtemp(join(tmpdir(), "tiny-claw-edit-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  return { workDir, tool: new EditFileTool(workDir) };
}

test("edit_file exposes the expected tool definition and exact-matches once", async (t) => {
  const { workDir, tool } = await createTool(t);
  assert.equal(tool.name(), "edit_file");
  assert.deepEqual(tool.definition().inputSchema.required, [
    "path", "old_text", "new_text",
  ]);
  await writeFile(join(workDir, "sample.go"), "before\nold value\nafter\n");
  assert.equal(
    await tool.execute(new AbortController().signal, {
      path: "sample.go",
      old_text: "old value",
      new_text: "new value",
    }),
    "✅ 成功修改文件: sample.go",
  );
  assert.equal(await readFile(join(workDir, "sample.go"), "utf8"), "before\nnew value\nafter\n");
});

test("edit_file falls back from CRLF normalization to trimmed-space matching", async (t) => {
  const { workDir, tool } = await createTool(t);
  await writeFile(join(workDir, "crlf.txt"), "first\r\nold value\r\nlast\r\n");
  await tool.execute(new AbortController().signal, {
    path: "crlf.txt",
    old_text: "old value\n",
    new_text: "new value\n",
  });
  assert.equal(await readFile(join(workDir, "crlf.txt"), "utf8"), "first\nnew value\nlast\n");

  await writeFile(join(workDir, "trim.txt"), "before value = 1; after\n");
  await tool.execute(new AbortController().signal, {
    path: "trim.txt",
    old_text: "  value = 1;  ",
    new_text: "value = 2;",
  });
  assert.equal(await readFile(join(workDir, "trim.txt"), "utf8"), "before value = 2; after\n");
});

test("edit_file matches multiline snippets despite indentation differences", async (t) => {
  const { workDir, tool } = await createTool(t);
  const original = [
    "package main",
    "",
    "func main() {",
    "\t// TODO: auth",
    "\tif true {",
    '\t\tfmt.Println("public")',
    "\t}",
    "}",
    "",
  ].join("\n");
  await writeFile(join(workDir, "server.go"), original);
  await tool.execute(new AbortController().signal, {
    path: "server.go",
    old_text: '// TODO: auth\nif true {\nfmt.Println("public")\n}',
    new_text: '\t// TODO: auth\n\tif user == nil {\n\t\tfmt.Println("Forbidden!")\n\t\treturn\n\t}',
  });
  assert.equal(
    await readFile(join(workDir, "server.go"), "utf8"),
    [
      "package main",
      "",
      "func main() {",
      "\t// TODO: auth",
      "\tif user == nil {",
      '\t\tfmt.Println("Forbidden!")',
      "\t\treturn",
      "\t}",
      "}",
      "",
    ].join("\n"),
  );
});

test("edit_file rejects ambiguous or missing snippets without modifying the file", async (t) => {
  const { workDir, tool } = await createTool(t);
  const original = "if true {\n\tfmt.Println(\"public\")\n}\n\nif true {\n\tfmt.Println(\"public\")\n}\n";
  await writeFile(join(workDir, "duplicate.go"), original);
  await assert.rejects(
    tool.execute(new AbortController().signal, {
      path: "duplicate.go",
      old_text: 'if true {\nfmt.Println("public")\n}',
      new_text: "replacement",
    }),
    /模糊匹配到了 2 处代码/u,
  );
  await assert.rejects(
    tool.execute(new AbortController().signal, {
      path: "duplicate.go", old_text: "not present", new_text: "replacement",
    }),
    /未找到 old_text/u,
  );
  assert.equal(await readFile(join(workDir, "duplicate.go"), "utf8"), original);

  await writeFile(join(workDir, "exact-duplicate.txt"), "same same");
  await assert.rejects(
    tool.execute(new AbortController().signal, {
      path: "exact-duplicate.txt", old_text: "same", new_text: "new",
    }),
    /匹配到了 2 处/u,
  );
  assert.equal(await readFile(join(workDir, "exact-duplicate.txt"), "utf8"), "same same");
});

test("edit_file validates arguments, reports file errors, and is available through the registry", async (t) => {
  const { workDir, tool } = await createTool(t);
  for (const args of [
    null, [], "file", {}, { path: "" }, { path: "a", old_text: "" },
    { path: "a", old_text: " " }, { path: "a", old_text: "old" },
    { path: "a", old_text: "old", new_text: 1 },
  ]) {
    await assert.rejects(
      tool.execute(new AbortController().signal, args),
      /参数解析失败/u,
    );
  }

  const registry = new ToolRegistry();
  registry.register(tool);
  const result = await registry.execute(new AbortController().signal, {
    id: "edit_1",
    name: "edit_file",
    arguments: {
      path: "missing.txt",
      old_text: "old",
      new_text: "new",
    },
  });
  assert.equal(result.toolCallId, "edit_1");
  assert.equal(result.isError, true);
  assert.match(result.output, /Error executing edit_file: 读取文件失败/u);
});

test("edit_file rejects a pre-cancelled operation", async (t) => {
  const { workDir, tool } = await createTool(t);
  await writeFile(join(workDir, "file.txt"), "old");
  await assert.rejects(
    tool.execute(AbortSignal.abort(), {
      path: "file.txt",
      old_text: "old",
      new_text: "new",
    }),
    (error) => error.cause?.name === "AbortError",
  );
});
