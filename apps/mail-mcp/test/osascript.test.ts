import assert from "node:assert/strict";
import { test } from "node:test";
import { forceQuitMail, mapOsaError, runOsa } from "../src/osascript.ts";

test("mapOsaError gives a friendly message for Mail not running / not authorized", () => {
  assert.match(
    mapOsaError("execution error: Mail got an error: Application isn't running. (-600)"),
    /Mail\.app.*not.*running/i,
  );
  assert.match(
    mapOsaError("execution error: Not authorized to send Apple events to Mail. (-1743)"),
    /Automation permission/i,
  );
  assert.match(mapOsaError("some other failure"), /some other failure/);
});

test("runOsa uses the injected exec and returns its output", async () => {
  const out = await runOsa("script", { exec: async (s) => `ran:${s}` });
  assert.equal(out, "ran:script");
});

test("mapOsaError flags the transient -609 connection error", () => {
  assert.match(mapOsaError("execution error: ... (-609)"), /-609/);
});

test("runOsa retries once on a transient -609 failure", async () => {
  let calls = 0;
  const out = await runOsa("script", {
    exec: async () => {
      calls += 1;
      if (calls === 1) throw new Error("Mail connection was temporarily invalid (-609).");
      return "ok";
    },
  });
  assert.equal(out, "ok");
  assert.equal(calls, 2);
});

test("runOsa does not retry a transient -609 failure when isTransient is disabled (write path)", async () => {
  let calls = 0;
  await assert.rejects(() => runOsa("script", {
    isTransient: () => false,
    exec: async () => {
      calls += 1;
      throw new Error("Mail connection was temporarily invalid (-609).");
    },
  }));
  assert.equal(calls, 1);
});

test("forceQuitMail runs killall -9 Mail", async () => {
  const calls: { bin: string; args: string[] }[] = [];
  await forceQuitMail(async (bin, args) => { calls.push({ bin, args }); });
  assert.deepEqual(calls, [{ bin: "killall", args: ["-9", "Mail"] }]);
});

test("forceQuitMail never rejects, even when the quit itself fails (e.g. Mail already dead)", async () => {
  await assert.doesNotReject(forceQuitMail(async () => { throw new Error("No matching processes"); }));
});

test("runOsa forwards an explicit onStall through to the shared stall watcher (same wiring forceQuitMail relies on)", async () => {
  let stallCount = 0;
  let resolveExec!: (v: string) => void;
  const pending = runOsa("script", {
    timeoutMs: 40,
    onStall: () => { stallCount += 1; },
    exec: () => new Promise((resolve) => { resolveExec = resolve; }),
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(stallCount, 1);
  resolveExec("done");
  assert.equal(await pending, "done");
});
