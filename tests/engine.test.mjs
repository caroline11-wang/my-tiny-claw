import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentEngine } from "../internal/engine/loop.ts";
import { Session } from "../internal/context/session.ts";

function createSession(prompt, workDir = "/workspace") {
  const session = new Session("test", workDir);
  session.append({ role: "user", content: prompt });
  return session;
}

test("tools start concurrently and observations retain call order despite reverse completion", { timeout: 5000 }, async () => {
  const signal = new AbortController().signal;
  const calls = ["slow", "fast", "error"].map((id) => ({
    id, name: "example", arguments: { id },
  }));
  const started = [];
  const completed = [];
  const releases = new Map();
  let requests = 0;
  let firstHistory;
  let notifyStarted;
  const allStarted = new Promise((resolve) => { notifyStarted = resolve; });
  const engine = new AgentEngine({
    async generate(receivedSignal, messages) {
      assert.equal(receivedSignal, signal);
      requests += 1;
      if (requests === 1) {
        firstHistory = messages;
        return { role: "assistant", content: "", toolCalls: calls };
      }
      assert.deepEqual(completed, ["error", "fast", "slow"]);
      assert.deepEqual(messages.slice(-3), calls.map((call) => ({
        role: "user",
        toolCallId: call.id,
        content: call.id === "error" ? "tool failed" : `result:${call.id}`,
      })));
      return { role: "assistant", content: "完成" };
    },
  }, {
    getAvailableTools() { return []; },
    async execute(receivedSignal, call) {
      assert.equal(receivedSignal, signal);
      started.push(call.id);
      await new Promise((resolve) => {
        releases.set(call.id, resolve);
        if (started.length === calls.length) notifyStarted();
      });
      completed.push(call.id);
      return {
        toolCallId: call.id,
        output: call.id === "error" ? "tool failed" : `result:${call.id}`,
        isError: call.id === "error",
      };
    },
  });

  const session = createSession("run independent tools");
  const running = engine.run(signal, session);
  await allStarted;
  assert.deepEqual(started, ["slow", "fast", "error"]);
  for (const id of ["error", "fast"]) {
    releases.get(id)();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1, "model must wait for all tool results");
    assert.equal(firstHistory.length, 3, "partial observations must not enter history");
  }
  releases.get("slow")();
  await running;
  assert.equal(requests, 2);
  assert.deepEqual(session.getWorkingMemory(0).slice(-4, -1), calls.map((call) => ({
    role: "user",
    toolCallId: call.id,
    content: call.id === "error" ? "tool failed" : `result:${call.id}`,
  })));
});

test("the main loop feeds tool observations back until the model finishes", async () => {
  const signal = new AbortController().signal;
  const toolCall = {
    id: "call_123",
    name: "list_files",
    arguments: { path: "." },
  };
  const toolDefinition = {
    name: "list_files",
    description: "List workspace files",
    inputSchema: { type: "object" },
  };
  const requests = [];
  const executions = [];
  const provider = {
    async generate(receivedSignal, messages, availableTools) {
      assert.equal(receivedSignal, signal);
      requests.push({ messages: structuredClone(messages), availableTools });
      if (requests.length === 1) {
        return {
          role: "assistant",
          content: "我来查看文件。",
          toolCalls: [toolCall],
        };
      }
      return {
        role: "assistant",
        content: "任务完成。",
      };
    },
  };
  const registry = {
    getAvailableTools() {
      return [toolDefinition];
    },
    async execute(receivedSignal, call) {
      assert.equal(receivedSignal, signal);
      executions.push(call);
      return {
        toolCallId: call.id,
        output: "main.ts",
        isError: false,
      };
    },
  };
  const engine = new AgentEngine(provider, registry);

  await engine.run(signal, createSession("列出当前目录文件"));

  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages.length, 2);
  assert.equal(requests[0].messages[0].role, "system");
  assert.match(requests[0].messages[0].content, /# 核心身份/u);
  assert.deepEqual(requests[0].messages[1], { role: "user", content: "列出当前目录文件" });
  assert.deepEqual(requests[1].messages[0], requests[0].messages[0]);
  assert.deepEqual(requests[0].availableTools, [toolDefinition]);
  assert.deepEqual(executions, [toolCall]);
  assert.deepEqual(requests[1].messages.slice(-2), [
    {
      role: "assistant",
      content: "我来查看文件。",
      toolCalls: [toolCall],
    },
    {
      role: "user",
      content: "main.ts",
      toolCallId: "call_123",
    },
  ]);
  assert.equal(requests[1].messages.at(-1).toolCallId, toolCall.id);
});

test("the main loop wraps and propagates model generation failures", async () => {
  const cause = new Error("provider unavailable");
  const engine = new AgentEngine(
    {
      async generate() {
        throw cause;
      },
    },
    {
      getAvailableTools() {
        return [];
      },
      async execute() {
        throw new Error("No tools should be executed");
      },
    },
  );

  await assert.rejects(
    engine.run(new AbortController().signal, createSession("hello")),
    (error) => {
      assert.equal(error.message, "Action 阶段生成失败");
      assert.equal(error.cause, cause);
      return true;
    },
  );
});

test("thinking precedes every action with no tools and preserves the context timeline", async () => {
  const signal = new AbortController().signal;
  const tools = [{ name: "bash", description: "Run commands", inputSchema: {} }];
  const call = { id: "call_1", name: "bash", arguments: { command: "ls" } };
  const responses = [
    { role: "assistant", content: "先检查目录" },
    { role: "assistant", content: "", toolCalls: [call] },
    { role: "assistant", content: "目录检查完毕，可以回复" },
    { role: "assistant", content: "完成", toolCalls: [] },
  ];
  const requests = [];
  const executions = [];
  let discoveries = 0;
  const engine = new AgentEngine(
    {
      async generate(receivedSignal, messages, availableTools) {
        assert.equal(receivedSignal, signal);
        requests.push({ messages: structuredClone(messages), tools: availableTools });
        assert.ok(requests.length <= responses.length, "unexpected extra model call");
        return responses[requests.length - 1];
      },
    },
    {
      getAvailableTools() {
        discoveries += 1;
        return tools;
      },
      async execute(receivedSignal, toolCall) {
        assert.equal(receivedSignal, signal);
        executions.push(toolCall);
        return { toolCallId: call.id, output: "文件读取失败", isError: true };
      },
    },
    true,
  );

  const session = createSession("检查目录");
  await engine.run(signal, session);

  assert.equal(engine.enableThinking, true);
  assert.equal(discoveries, 2);
  assert.deepEqual(requests.map((request) => request.tools), [[], tools, [], tools]);
  assert.deepEqual(executions, [call]);
  const initial = requests[0].messages;
  const observation = { role: "user", content: "文件读取失败", toolCallId: call.id };
  assert.deepEqual(requests[1].messages, [...initial, responses[0]]);
  assert.deepEqual(requests[2].messages, [
    ...initial, responses[0], responses[1], observation,
  ]);
  assert.deepEqual(requests[3].messages, [
    ...initial, responses[0], responses[1], observation, responses[2],
  ]);
  assert.deepEqual(session.getWorkingMemory(0), [
    initial[1], responses[0], responses[1], observation, responses[2], responses[3],
  ]);
});

test("an empty thinking response does not end the task or enter the history", async () => {
  const requests = [];
  const engine = new AgentEngine(
    {
      async generate(_signal, messages, tools) {
        requests.push({ messages: structuredClone(messages), tools });
        assert.ok(requests.length <= 2);
        return { role: "assistant", content: requests.length === 1 ? "" : "完成" };
      },
    },
    {
      getAvailableTools() { return []; },
      async execute() { assert.fail("no tool should execute"); },
    },
    true,
  );

  const session = createSession("hello");
  await engine.run(new AbortController().signal, session);

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages, requests[0].messages);
  assert.deepEqual(session.getWorkingMemory(0), [
    { role: "user", content: "hello" }, { role: "assistant", content: "完成" },
  ]);
});

for (const failingPhase of ["Thinking", "Action"]) {
  test(`${failingPhase} failures preserve the cause and stop further execution`, async () => {
    const cause = new Error("provider unavailable");
    let calls = 0;
    const engine = new AgentEngine(
      {
        async generate() {
          calls += 1;
          if (failingPhase === "Thinking" || calls === 2) throw cause;
          return { role: "assistant", content: "准备行动" };
        },
      },
      {
        getAvailableTools() { return []; },
        async execute() { assert.fail("no tool should execute"); },
      },
      true,
    );

    const session = createSession("hello");
    await assert.rejects(engine.run(new AbortController().signal, session), (error) => {
      assert.equal(error.message, `${failingPhase} 阶段生成失败`);
      assert.equal(error.cause, cause);
      return true;
    });
    assert.equal(calls, failingPhase === "Thinking" ? 1 : 2);
    assert.deepEqual(session.getWorkingMemory(0), [
      { role: "user", content: "hello" },
      ...(failingPhase === "Action" ? [{ role: "assistant", content: "准备行动" }] : []),
    ]);
  });
}

test("composed prompts reach every phase and tool turn, and refresh only on the next run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiny-claw-engine-context-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentsPath = join(directory, "AGENTS.md");
  const skillDirectory = join(directory, ".claw", "skills", "review");
  await mkdir(skillDirectory, { recursive: true });
  const skillPath = join(skillDirectory, "SKILL.md");
  const skill = (version) =>
    `---\nname: review\ndescription: Review changes\n---\nReview instructions ${version}`;
  await writeFile(agentsPath, "Workspace guidelines v1");
  await writeFile(skillPath, skill("v1"));

  const requests = [];
  const call = { id: "call_review", name: "example", arguments: {} };
  const definition = { name: "example", description: "Example", inputSchema: {} };
  const engine = new AgentEngine({
    async generate(_signal, messages, tools) {
      requests.push(structuredClone(messages));
      assert.equal(messages.filter((message) => message.role === "system").length, 1);
      if (tools.length === 0) return { role: "assistant", content: "准备行动" };
      if (requests.length === 2) {
        await writeFile(agentsPath, "Workspace guidelines v2");
        await writeFile(skillPath, skill("v2"));
        return { role: "assistant", content: "", toolCalls: [call] };
      }
      return { role: "assistant", content: "完成" };
    },
  }, {
    getAvailableTools() { return [definition]; },
    async execute() {
      return { toolCallId: call.id, output: "tool observation", isError: false };
    },
  }, true);

  assert.equal(await engine.run(new AbortController().signal, createSession("First run", directory)), "完成");
  assert.equal(requests.length, 4);
  for (const messages of requests) {
    assert.deepEqual(messages[0], requests[0][0]);
    assert.match(messages[0].content, /Workspace guidelines v1/u);
    assert.match(messages[0].content, /Review instructions v1/u);
    assert.doesNotMatch(messages[0].content, /v2/u);
  }
  assert.ok(requests[2].some((message) => message.toolCallId === call.id));

  assert.equal(await engine.run(new AbortController().signal, createSession("Second run", directory)), "完成");
  assert.equal(requests.length, 6);
  for (const messages of requests.slice(4)) {
    assert.match(messages[0].content, /Workspace guidelines v2/u);
    assert.match(messages[0].content, /Review instructions v2/u);
    assert.doesNotMatch(messages[0].content, /v1/u);
  }
  assert.equal(requests[4].length, 2, "a different session starts a fresh conversation");
});

test("prompt loading failures stop before any provider or tool operation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiny-claw-engine-context-error-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const skillDirectory = join(directory, ".claw", "skills", "broken");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), "Missing required frontmatter");
  const engine = new AgentEngine({
    async generate() { assert.fail("provider must not run with an invalid prompt"); },
  }, {
    getAvailableTools() { assert.fail("tool discovery must not run"); },
    async execute() { assert.fail("tools must not run"); },
  });

  await assert.rejects(engine.run(new AbortController().signal, createSession("hello", directory)), (error) => {
    assert.match(error.message, /加载技能失败/u);
    assert.match(error.cause.message, /必须以 ---/u);
    return true;
  });
});

test("each tool turn rebuilds a twenty-message window without deleting the full session history", async () => {
  const session = new Session("window", "/workspace");
  const oldMessages = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `old-${index}`,
  }));
  for (const message of oldMessages) session.append(message);
  session.append({ role: "user", content: "current task" });
  const calls = ["a", "b"].map((id) => ({
    id, name: "example", arguments: {},
  }));
  const requests = [];
  const engine = new AgentEngine({
    async generate(_signal, messages) {
      requests.push(structuredClone(messages));
      assert.equal(messages.length, 21, "system plus twenty recent messages");
      assert.deepEqual(messages.slice(1), session.getWorkingMemory(20));
      return requests.length === 1
        ? { role: "assistant", content: "", toolCalls: calls }
        : { role: "assistant", content: "done" };
    },
  }, {
    getAvailableTools() { return []; },
    async execute(_signal, call) {
      return { toolCallId: call.id, output: `result-${call.id}`, isError: false };
    },
  });

  assert.equal(await engine.run(new AbortController().signal, session), "done");
  assert.equal(requests.length, 2);
  assert.notDeepEqual(requests[0].slice(1), requests[1].slice(1));
  const fullHistory = session.getWorkingMemory(0);
  assert.equal(fullHistory.length, 29);
  assert.deepEqual(fullHistory.slice(0, 24), oldMessages);
  assert.ok(fullHistory.every((message) => message.role !== "system"));
});

test("compacts each model request without changing session observations", async () => {
  const observation = "start" + "😀".repeat(1100) + "end";
  const call = { id: "call", name: "example", arguments: {} };
  const requests = [];
  const engine = new AgentEngine({
    async generate(_signal, messages, tools) {
      requests.push(structuredClone(messages));
      if (requests.length === 1) return { role: "assistant", content: "plan" };
      if (requests.length === 2) return { role: "assistant", content: "", toolCalls: [call] };
      if (tools.length === 0) return { role: "assistant", content: "next plan" };
      return { role: "assistant", content: "done" };
    },
  }, {
    getAvailableTools() { return [{ name: "example", description: "example", inputSchema: {} }]; },
    async execute() { return { toolCallId: call.id, output: observation, isError: false }; },
  }, true);
  const session = createSession("task");
  assert.equal(await engine.run(new AbortController().signal, session), "done");
  for (const request of requests.slice(2)) {
    const result = request.find((message) => message.toolCallId === call.id);
    assert.match(result.content, /内容过长/u);
    assert.ok(result.content.startsWith("start"));
    assert.ok(result.content.endsWith("end"));
    assert.deepEqual(request.find((message) => message.toolCalls)?.toolCalls, [call]);
  }
  assert.equal(session.getWorkingMemory(0).find((message) => message.toolCallId === call.id).content, observation);
});

test("rechecks the original context after thinking pushes it over the threshold", async () => {
  const session = createSession("task");
  const call = { id: "old", name: "read_file", arguments: {} };
  const oldOutput = "old".repeat(100);
  session.append({ role: "assistant", content: "", toolCalls: [call] });
  session.append({ role: "user", content: oldOutput, toolCallId: call.id });
  for (let i = 0; i < 5; i++) session.append({ role: "user", content: `recent ${i}` });
  const requests = [];
  const engine = new AgentEngine({
    async generate(_signal, messages) {
      requests.push(structuredClone(messages));
      return { role: "assistant", content: requests.length === 1 ? "plan".repeat(800) : "done" };
    },
  }, {
    getAvailableTools() { return []; },
    async execute() { assert.fail("no tools expected"); },
  }, true);
  await engine.run(new AbortController().signal, session);
  assert.equal(requests[0].find((message) => message.toolCallId === call.id).content, oldOutput);
  assert.match(requests[1].find((message) => message.toolCallId === call.id).content, /强制清理/u);
  assert.equal(session.getWorkingMemory(0).find((message) => message.toolCallId === call.id).content, oldOutput);
});

test("a reused session remembers previous runs while another session uses its own workspace and history", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiny-claw-engine-sessions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workDirA = join(directory, "a");
  const workDirB = join(directory, "b");
  await mkdir(workDirA);
  await mkdir(workDirB);
  await writeFile(join(workDirA, "AGENTS.md"), "Workspace A rules");
  await writeFile(join(workDirB, "AGENTS.md"), "Workspace B rules");
  const first = createSession("Remember alpha", workDirA);
  const second = createSession("Hello beta", workDirB);
  const requests = [];
  const engine = new AgentEngine({
    async generate(_signal, messages) {
      requests.push(structuredClone(messages));
      return { role: "assistant", content: "answer" };
    },
  }, {
    getAvailableTools() { return []; },
    async execute() { assert.fail("no tools expected"); },
  });

  await engine.run(new AbortController().signal, first);
  first.append({ role: "user", content: "What did I say?" });
  await engine.run(new AbortController().signal, first);
  await engine.run(new AbortController().signal, second);

  assert.deepEqual(requests[1].slice(1), [
    { role: "user", content: "Remember alpha" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "What did I say?" },
  ]);
  assert.match(requests[1][0].content, /Workspace A rules/u);
  assert.match(requests[2][0].content, /Workspace B rules/u);
  assert.doesNotMatch(requests[2][0].content, /Workspace A rules/u);
  assert.deepEqual(requests[2].slice(1), [{ role: "user", content: "Hello beta" }]);
  assert.equal(first.getWorkingMemory(0).length, 4);
  assert.equal(second.getWorkingMemory(0).length, 2);
});
