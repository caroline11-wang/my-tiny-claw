import assert from "node:assert/strict";
import { test } from "node:test";
import { Compactor } from "../internal/context/compactor.ts";

test("threshold includes UTF-8 content and serialized tool arguments", () => {
  const messages = [{ role: "assistant", content: "x".repeat(201), toolCalls: [
    { id: "1", name: "tool", arguments: { input: "中文" } },
  ] }];
  const size = Buffer.byteLength(messages[0].content) + Buffer.byteLength("tool") +
    Buffer.byteLength(JSON.stringify(messages[0].toolCalls[0].arguments));
  assert.deepEqual(new Compactor(size + 1, 0).compact(messages), messages);
  const compacted = new Compactor(size, 0).compact(messages);
  assert.match(compacted[0].content, /已折叠/u);
  assert.deepEqual(compacted[0].toolCalls, messages[0].toolCalls);
  assert.equal(messages[0].content, "x".repeat(201));
});

test("masks old observations and assistant text while preserving calls and other messages", () => {
  const calls = [{ id: "call", name: "read_file", arguments: { path: "test" } }];
  const messages = [
    { role: "system", content: "s".repeat(250) },
    { role: "user", content: "user ".repeat(50) },
    { role: "assistant", content: "a".repeat(201), toolCalls: calls },
    { role: "user", content: "b".repeat(201), toolCallId: "call" },
    { role: "user", content: "c".repeat(200), toolCallId: "small" },
    { role: "assistant", content: "recent" },
  ];
  const original = structuredClone(messages);
  const result = new Compactor(1, 1).compact(messages);
  assert.deepEqual(result[0], messages[0]);
  assert.deepEqual(result[1], messages[1]);
  assert.match(result[2].content, /已折叠/u);
  assert.deepEqual(result[2].toolCalls, calls);
  assert.match(result[3].content, /原始长度: 201 字节/u);
  assert.equal(result[3].toolCallId, "call");
  assert.deepEqual(result.slice(4), messages.slice(4));
  assert.deepEqual(messages, original);
});

test("truncates recent observations at UTF-8 boundaries and leaves small ones intact", () => {
  const content = "😀".repeat(400) + "终";
  const messages = [
    { role: "user", content: "x".repeat(1000), toolCallId: "small" },
    { role: "user", content, toolCallId: "large" },
  ];
  const result = new Compactor(1, 2).compact(messages);
  assert.equal(result[0].content, messages[0].content);
  assert.ok(result[1].content.startsWith("😀".repeat(125)));
  assert.ok(result[1].content.endsWith("终"));
  assert.doesNotMatch(result[1].content, /\uFFFD/u);
  const [head, marker, tail] = result[1].content.split("\n\n");
  assert.equal(Buffer.byteLength(head) + Buffer.byteLength(tail) + Number(marker.match(/中间 (\d+) 字节/u)[1]), Buffer.byteLength(content));
  assert.equal(result[1].toolCallId, "large");
  assert.equal(messages[1].content, content);
});

test("rejects invalid compactor configuration", () => {
  for (const [max, retain] of [[0, 1], [1, -1], [1.5, 1], [1, NaN]]) {
    assert.throws(() => new Compactor(max, retain), RangeError);
  }
});
