import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "../src/core/chat-store.ts";

test("deleteChat removes the Pi session file; purgeTemporary too", () => {
  const dir = mkdtempSync(join(tmpdir(), "chats-"));
  const store = new ChatStore(new Database(":memory:"), dir);
  const chat = store.createChat("x");
  const file = join(dir, "session-x.jsonl");
  writeFileSync(file, "");
  store.setSessionFile(chat.id, file);
  store.deleteChat(chat.id);
  assert.equal(existsSync(file), false);

  const tmp = store.createChat("t", { temporary: true });
  const file2 = join(dir, "session-t.jsonl");
  writeFileSync(file2, "");
  store.setSessionFile(tmp.id, file2);
  store.purgeTemporary();
  assert.equal(existsSync(file2), false);
});
