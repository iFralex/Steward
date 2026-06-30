import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFile, resolveToken, filesFromOutput } from "../src/core/file-registry.ts";

test("registerFile registers a real file; resolveToken returns it; dedups by path", () => {
  const dir = mkdtempSync(join(tmpdir(), "freg-"));
  const p = join(dir, "report.pdf");
  writeFileSync(p, "hello");
  const ref = registerFile(p);
  assert.ok(ref);
  assert.equal(ref.name, "report.pdf");
  assert.equal(ref.mime, "application/pdf");
  assert.equal(ref.size, 5);
  assert.equal(resolveToken(ref.token)?.path, p);
  assert.equal(registerFile(p)?.token, ref.token, "same path → same token");
});

test("registerFile returns null for a missing path or a directory", () => {
  assert.equal(registerFile("/no/such/file.xyz"), null);
  assert.equal(registerFile(tmpdir()), null);
});

test("filesFromOutput registers on-disk absolute paths found in the output (dedup, skip non-files)", () => {
  const dir = mkdtempSync(join(tmpdir(), "freg-"));
  const p = join(dir, "a.png");
  writeFileSync(p, "x");
  const refs = filesFromOutput({ path: p, note: "not a path", nested: ["/no/such/x", p] });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, "a.png");
  assert.equal(refs[0].mime, "image/png");
});

test("resolveToken returns null for an unknown token", () => {
  assert.equal(resolveToken("nope"), null);
});
