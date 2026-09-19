import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushRegistry, type PushSubscriptionJSON, type SendFn } from "../src/core/push.ts";

function sub(endpoint: string): PushSubscriptionJSON {
  return { endpoint, keys: { p256dh: "p", auth: "a" } };
}
function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "push-")), "subs.json");
}

test("sendAll fans out to every subscription", async () => {
  const file = tmpFile();
  const calls: string[] = [];
  const send: SendFn = async (s) => { calls.push(s.endpoint); };
  const reg = new PushRegistry(file, send);
  reg.subscribe(sub("https://a"));
  reg.subscribe(sub("https://b"));

  const report = await reg.sendAll({ title: "Steward", body: "hi" });

  assert.deepEqual(calls.sort(), ["https://a", "https://b"]);
  assert.deepEqual(report, { attempted: 2, delivered: 2, failed: 0, pruned: 0 });
  rmSync(join(file, ".."), { recursive: true, force: true });
});

test("a 410 Gone prunes that subscription; others survive", async () => {
  const file = tmpFile();
  const send: SendFn = async (s) => {
    if (s.endpoint === "https://dead") throw Object.assign(new Error("gone"), { statusCode: 410 });
  };
  const reg = new PushRegistry(file, send);
  reg.subscribe(sub("https://live"));
  reg.subscribe(sub("https://dead"));

  const report = await reg.sendAll({ title: "Steward" });

  assert.deepEqual(reg.list().map((s) => s.endpoint), ["https://live"], "gone sub pruned, live kept");
  assert.deepEqual(report, { attempted: 2, delivered: 1, failed: 1, pruned: 1 });
  rmSync(join(file, ".."), { recursive: true, force: true });
});

test("a non-gone error is swallowed and does NOT prune (best-effort)", async () => {
  const file = tmpFile();
  const send: SendFn = async () => { throw Object.assign(new Error("500"), { statusCode: 500 }); };
  const reg = new PushRegistry(file, send);
  reg.subscribe(sub("https://flaky"));

  const report = await reg.sendAll({ title: "Steward" }); // must not throw

  assert.equal(reg.size, 1, "transient failure keeps the subscription for a retry");
  assert.deepEqual(report, { attempted: 1, delivered: 0, failed: 1, pruned: 0 });
  rmSync(join(file, ".."), { recursive: true, force: true });
});

test("subscriptions persist across registry instances", async () => {
  const file = tmpFile();
  const noop: SendFn = async () => {};
  const a = new PushRegistry(file, noop);
  a.subscribe(sub("https://persisted"));
  assert.ok(existsSync(file), "persisted to disk");

  const b = new PushRegistry(file, noop);
  assert.deepEqual(b.list().map((s) => s.endpoint), ["https://persisted"], "reloaded on construct");
  rmSync(join(file, ".."), { recursive: true, force: true });
});

test("sendAll with no subscriptions is a no-op", async () => {
  const file = tmpFile();
  let called = false;
  const reg = new PushRegistry(file, async () => { called = true; });
  const report = await reg.sendAll({ title: "Steward" });
  assert.equal(called, false);
  assert.deepEqual(report, { attempted: 0, delivered: 0, failed: 0, pruned: 0 });
  rmSync(join(file, ".."), { recursive: true, force: true });
});
