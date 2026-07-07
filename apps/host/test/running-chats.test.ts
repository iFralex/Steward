import assert from "node:assert/strict";
import { test } from "node:test";
import { isRunning, markIdle, markRunning } from "../src/core/running-chats.ts";

test("a chat is not running until markRunning is called for it", () => {
  assert.equal(isRunning("chat-never-touched"), false);
});

test("markRunning marks a chat running; markIdle marks it idle again", () => {
  markRunning("chat-a");
  assert.equal(isRunning("chat-a"), true);
  markIdle("chat-a");
  assert.equal(isRunning("chat-a"), false);
});

test("markIdle on a chat that was never running is a harmless no-op", () => {
  markIdle("chat-never-was-running");
  assert.equal(isRunning("chat-never-was-running"), false);
});

test("running state is tracked independently per chatId", () => {
  markRunning("chat-x");
  assert.equal(isRunning("chat-x"), true);
  assert.equal(isRunning("chat-y"), false);
  markIdle("chat-x");
});
