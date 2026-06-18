import assert from "node:assert/strict";
import { test } from "node:test";
import { mapOsaError, runOsa } from "../src/osascript.ts";

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
