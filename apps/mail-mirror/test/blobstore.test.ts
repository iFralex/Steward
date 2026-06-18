import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../src/blobstore.ts";

test("put is content-addressed and idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "blob-"));
  const bs = new BlobStore(dir);
  const a = bs.put(Buffer.from("hello"));
  const b = bs.put(Buffer.from("hello"));
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.relPath, b.relPath);
  assert.ok(existsSync(bs.absPath(a.relPath)));
  assert.notEqual(a.sha256, bs.put(Buffer.from("world")).sha256);
});
