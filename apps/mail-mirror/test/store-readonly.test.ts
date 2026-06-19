import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";

test("openReadonly reads an existing DB; writes throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "ro-"));
  const path = join(dir, "mail.db");
  const w = Store.open(path);
  w.raw.prepare("INSERT INTO sync_state(key,value) VALUES ('k','v')").run();
  w.close();

  const r = Store.openReadonly(path);
  assert.equal(r.getState("k"), "v");
  assert.throws(() => r.setState("x", "y")); // read-only connection rejects writes
  r.close();
});
