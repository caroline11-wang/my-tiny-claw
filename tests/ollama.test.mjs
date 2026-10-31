import assert from "node:assert/strict";
import { test } from "node:test";
import { OllamaProvider } from "../internal/provider/ollama.ts";

test("Ollama uses the OpenAI SDK for tool calls and tool observations", async () => {
  const requests = [];
  const provider = new OllamaProvider({
    model: "llama3.1:latest",
    baseURL: "http://127.0.0.1:11434/v1/",
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)),
      });
      return Response.json({
        choices: [{
          message: requests.length === 1
            ? {
                content: null,
                tool_calls: [{
                  id: "weather",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"city":"北京"}',
                  },
                }],
              }
            : { content: "晴天，适合跑步。" },
        }],
      });
    },
  });
  const signal = new AbortController().signal;
  const messages = [{ role: "user", content: "北京天气？" }];
  const tools = [{
    name: "get_weather",
    description: "Get weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  }];
  const response = await provider.generate(signal, messages, tools);
  assert.deepEqual(response.toolCalls, [{
    id: "weather",
    name: "get_weather",
    arguments: { city: "北京" },
  }]);
  const final = await provider.generate(signal, [
    ...messages,
    response,
    { role: "user", content: "晴天", toolCallId: "weather" },
  ], []);
  assert.equal(final.content, "晴天，适合跑步。");
  assert.equal(requests[0].url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(requests[0].body.model, "llama3.1:latest");
  assert.equal(requests[0].body.tools[0].function.name, "get_weather");
  assert.equal(requests[1].body.messages[2].role, "tool");
  assert.equal(requests[1].body.messages[2].tool_call_id, "weather");
  assert.equal(requests[1].body.tools, undefined);
});

test("Ollama rejects invalid models and non-local endpoints", () => {
  assert.throws(
    () => new OllamaProvider({ model: " ", baseURL: "http://localhost:11434/v1" }),
    /model must not be empty/u,
  );
  for (const baseURL of [
    "not-a-url",
    "http://example.com/v1",
    "http://localhost.example.com/v1",
    "http://user:password@localhost:11434/v1",
    "http://localhost:11434/v1?token=value",
  ]) {
    assert.throws(
      () => new OllamaProvider({ model: "llama3.1:latest", baseURL }),
      /localhost URL/u,
    );
  }
});

test("Ollama propagates HTTP failures and cancellation", async () => {
  const provider = new OllamaProvider({
    model: "llama3.1:latest",
    baseURL: "http://localhost:11434/v1",
    fetch: async () => Response.json(
      { error: { message: "Model not found" } },
      { status: 404 },
    ),
  });
  await assert.rejects(
    provider.generate(new AbortController().signal, [], []),
    { status: 404 },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider.generate(controller.signal, [], []),
    /aborted/u,
  );
});
