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
