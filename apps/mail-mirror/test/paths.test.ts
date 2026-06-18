import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeDir, dbPath, blobsDir } from "../src/paths.ts";

test("storeDir honours MAIL_MIRROR_DIR and creates it 0700", () => {
  const base = mkdtempSync(join(tmpdir(), "md-"));
  process.env.MAIL_MIRROR_DIR = join(base, "mm");
  const d = storeDir();
  assert.equal(d, join(base, "mm"));
  assert.ok(dbPath().endsWith("mail.db"));
  assert.ok(blobsDir().endsWith("blobs"));
  const mode = statSync(d).mode & 0o777;
  assert.equal(mode, 0o700);
  delete process.env.MAIL_MIRROR_DIR;
});
