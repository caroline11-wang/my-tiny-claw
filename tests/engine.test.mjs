import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentEngine } from "../internal/engine/loop.ts";

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
  }, "/workspace");

  const running = engine.run(signal, "run independent tools");
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
  const engine = new AgentEngine(provider, registry, "/workspace");

  await engine.run(signal, "列出当前目录文件");

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].messages, [
    {
      role: "system",
      content:
        "You are go-tiny-claw, an expert coding assistant. You have full access to tools in the workspace.",
    },
    { role: "user", content: "列出当前目录文件" },
  ]);
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
    "/workspace",
  );

  await assert.rejects(
    engine.run(new AbortController().signal, "hello"),
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
    "/workspace",
    true,
  );

  await engine.run(signal, "检查目录");

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
    "/workspace",
    true,
  );

  await engine.run(new AbortController().signal, "hello");

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages, requests[0].messages);
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
      "/workspace",
      true,
    );

    await assert.rejects(engine.run(new AbortController().signal, "hello"), (error) => {
      assert.equal(error.message, `${failingPhase} 阶段生成失败`);
      assert.equal(error.cause, cause);
      return true;
    });
    assert.equal(calls, failingPhase === "Thinking" ? 1 : 2);
  });
}
