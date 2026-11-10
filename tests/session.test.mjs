import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { GlobalSessionMgr, Session, SessionManager } from "../internal/context/session.ts";

test("a new session records its identity, workspace, timestamps, and empty history", () => {
  const now = new Date("2026-11-05T00:00:00.000Z");
  const session = new Session("chat-1", "/workspace", now);
  now.setUTCFullYear(2000);

  assert.equal(session.id, "chat-1");
  assert.equal(session.workDir, "/workspace");
  assert.deepEqual(session.createdAt, new Date("2026-11-05T00:00:00.000Z"));
  assert.deepEqual(session.updatedAt, session.createdAt);
  const exposedCreationTime = session.createdAt;
  exposedCreationTime.setUTCFullYear(2000);
  assert.notDeepEqual(session.createdAt, exposedCreationTime);
  assert.deepEqual(session.getWorkingMemory(0), []);
});

test("append updates the timestamp and stores messages independently from callers", async () => {
  const session = new Session("chat-append", "/workspace");
  const toolCall = {
    id: "call-1",
    name: "read_file",
    arguments: { path: "README.md" },
  };
  const message = {
    role: "assistant",
    content: "Reading the file.",
    toolCalls: [toolCall],
  };
  const previousUpdatedAt = session.updatedAt;

  session.append(message);
  toolCall.arguments.path = "changed.md";
  message.content = "mutated";
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.deepEqual(session.getWorkingMemory(0), [{
    role: "assistant",
    content: "Reading the file.",
    toolCalls: [{
      id: "call-1",
      name: "read_file",
      arguments: { path: "README.md" },
    }],
  }]);
  assert.ok(session.updatedAt.getTime() >= previousUpdatedAt.getTime());

  const exposedTimestamp = session.updatedAt;
  exposedTimestamp.setUTCFullYear(2000);
  assert.notDeepEqual(session.updatedAt, exposedTimestamp);
});

test("working memory returns the full history for nonpositive limits", () => {
  const session = new Session("chat-full", "/workspace");
  session.append({ role: "user", content: "first" });
  session.append({ role: "assistant", content: "second" });
  session.append({ role: "user", content: "third" });

  assert.deepEqual(session.getWorkingMemory(0).map(({ content }) => content), [
    "first", "second", "third",
  ]);
  assert.deepEqual(session.getWorkingMemory(-2).map(({ content }) => content), [
    "first", "second", "third",
  ]);
});

test("working memory keeps the most recent messages and drops orphaned tool results", () => {
  const session = new Session("chat-window", "/workspace");
  session.append({ role: "user", content: "old prompt" });
  session.append({
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call-old", name: "read_file", arguments: { path: "a" } }],
  });
  session.append({ role: "user", content: "old tool result", toolCallId: "call-old" });
  session.append({ role: "assistant", content: "old response" });
  session.append({
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "call-1", name: "read_file", arguments: { path: "a" } },
      { id: "call-2", name: "read_file", arguments: { path: "b" } },
    ],
  });
  session.append({ role: "user", content: "tool result 1", toolCallId: "call-1" });
  session.append({ role: "user", content: "tool result 2", toolCallId: "call-2" });
  session.append({ role: "assistant", content: "latest response" });

  const memory = session.getWorkingMemory(3);
  assert.deepEqual(memory.map(({ content }) => content), [
    "latest response",
  ]);
  assert.deepEqual(session.getWorkingMemory(4).map(({ content }) => content), [
    "",
    "tool result 1",
    "tool result 2",
    "latest response",
  ]);
  assert.deepEqual(session.getWorkingMemory(9).map(({ content }) => content), [
    "old prompt",
    "",
    "old tool result",
    "old response",
    "",
    "tool result 1",
    "tool result 2",
    "latest response",
  ]);

  memory.push({ role: "user", content: "external mutation" });
  assert.equal(session.getWorkingMemory(0).at(-1)?.content, "latest response");
});

test("sessions with the same ID are reused and different IDs stay isolated", () => {
  const manager = new SessionManager();
  const first = manager.getOrCreate("chat-1", "/workspace/one");
  const reused = manager.getOrCreate("chat-1", "/workspace/changed");
  const other = manager.getOrCreate("chat-2", "/workspace/two");

  assert.equal(reused, first);
  assert.equal(reused.workDir, "/workspace/one");
  assert.notEqual(other, first);
  first.append({ role: "user", content: "private to chat 1" });
  assert.deepEqual(other.getWorkingMemory(0), []);
});

test("the exported global manager reuses sessions by ID", () => {
  const id = `global-${randomUUID()}`;
  const session = GlobalSessionMgr.getOrCreate(id, "/workspace");
  assert.equal(GlobalSessionMgr.getOrCreate(id, "/ignored"), session);
});
