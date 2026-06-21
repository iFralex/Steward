import assert from "node:assert/strict";
import { test } from "node:test";
import { esc, runOsa } from "../src/index.ts";

test("esc escapes backslashes and quotes", () => {
  assert.equal(esc('a"b\\c'), 'a\\"b\\\\c');
});

test("runOsa returns stdout from the injected exec", async () => {
  const out = await runOsa("script", { exec: async () => "hello\n" });
  assert.equal(out, "hello\n");
});

test("runOsa retries once on a transient error then succeeds", async () => {
  let calls = 0;
  const out = await runOsa("s", {
    exec: async () => {
      calls++;
      if (calls === 1) throw new Error("connection is invalid (-609)");
      return "ok";
    },
  });
  assert.equal(out, "ok");
  assert.equal(calls, 2);
});

test("runOsa maps a non-transient error via mapError and does not retry", async () => {
  let calls = 0;
  await assert.rejects(
    runOsa("s", {
      exec: async () => { calls++; throw new Error("-1743 Not authorized"); },
      mapError: () => "AUTOMATION_BLOCKED",
    }),
    /AUTOMATION_BLOCKED/,
  );
  assert.equal(calls, 1);
});
