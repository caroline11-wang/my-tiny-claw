import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeProvider } from "../internal/provider/claude.ts";
import { OpenAIProvider } from "../internal/provider/openai.ts";

test("OpenAI SDK provider maps messages, tools, and tool calls", async () => {
  const controller = new AbortController();
  let request;
  const provider = new OpenAIProvider({
    apiKey: "test-token",
    baseURL: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    fetch: async (url, init) => {
      request = { url: String(url), init, body: JSON.parse(String(init.body)) };
      return Response.json({
        id: "chatcmpl_test",
        object: "chat.completion",
        created: 0,
        model: "qwen-plus",
        choices: [{
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "查询天气",
            tool_calls: [{
              id: "call_weather",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"city":"北京"}',
              },
            }],
            refusal: null,
          },
        }],
      });
    },
  });
  const result = await provider.generate(
    controller.signal,
    [
      { role: "system", content: "system prompt" },
      { role: "user", content: "北京天气如何？" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call_old",
          name: "get_weather",
          arguments: { city: "上海" },
        }],
      },
      { role: "user", content: "晴天", toolCallId: "call_old" },
    ],
    [{
      name: "get_weather",
      description: "Get weather",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    }],
  );

  assert.equal(
    request.url,
    "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  assert.ok(request.init.signal instanceof AbortSignal);
  assert.equal(request.init.signal.aborted, false);
  assert.equal(
    new Headers(request.init.headers).get("authorization"),
    "Bearer test-token",
  );
  assert.equal(request.body.model, "qwen-plus");
  assert.equal(request.body.messages[3].role, "tool");
  assert.equal(request.body.messages[3].tool_call_id, "call_old");
  assert.equal(request.body.tools[0].function.name, "get_weather");
  assert.deepEqual(result, {
    role: "assistant",
    content: "查询天气",
    toolCalls: [{
      id: "call_weather",
      name: "get_weather",
      arguments: { city: "北京" },
    }],
  });
});

test("Anthropic SDK provider maps tool results and response blocks", async () => {
  const controller = new AbortController();
  let request;
  const provider = new ClaudeProvider({
    apiKey: "test-token",
    baseURL: "https://api.example.com",
    model: "qwen-plus",
    fetch: async (url, init) => {
      request = { url: String(url), init, body: JSON.parse(String(init.body)) };
      return Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "qwen-plus",
        content: [
          { type: "text", text: "我将调用天气工具。" },
          {
            type: "tool_use",
            id: "call_weather",
            name: "get_weather",
            input: { city: "北京" },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  const result = await provider.generate(
    controller.signal,
    [
      { role: "system", content: "system prompt" },
      { role: "user", content: "天气如何？" },
      { role: "user", content: "晴天", toolCallId: "call_old" },
    ],
    [{
      name: "get_weather",
      description: "Get weather",
      inputSchema: { type: "object", properties: {} },
    }],
  );

  assert.equal(request.url, "https://api.example.com/v1/messages");
  assert.ok(request.init.signal instanceof AbortSignal);
  assert.equal(request.init.signal.aborted, false);
  assert.equal(new Headers(request.init.headers).get("x-api-key"), "test-token");
  assert.equal(
    new Headers(request.init.headers).get("anthropic-version"),
    "2023-06-01",
  );
  assert.equal(request.body.system, "system prompt");
  assert.deepEqual(request.body.messages[1].content[0], {
    type: "tool_result",
    tool_use_id: "call_old",
    content: "晴天",
  });
  assert.equal(request.body.tools[0].input_schema.type, "object");
  assert.deepEqual(result, {
    role: "assistant",
    content: "我将调用天气工具。",
    toolCalls: [{
      id: "call_weather",
      name: "get_weather",
      arguments: { city: "北京" },
    }],
  });
});
