import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate, runCommand, isSensitivePath, expandTilde } from "../src/exec.ts";

test("validate: read binary allowed, write binary denied in read mode", () => {
  assert.equal(validate("cat", ["/tmp/x"], "read"), null);
  assert.match(validate("rm", ["/tmp/x"], "read") ?? "", /not allowed in read/);
});

test("validate: write binary allowed only in write mode", () => {
  assert.equal(validate("mv", ["/tmp/a", "/tmp/b"], "write"), null);
  assert.match(validate("cat", ["/tmp/x"], "write") ?? "", /not allowed in write/);
});

test("validate: dangerous flags (find -exec/-delete) are rejected", () => {
  assert.match(validate("find", ["/tmp", "-delete"], "read") ?? "", /not allowed/);
  assert.match(validate("find", ["/tmp", "-exec", "rm", "{}", ";"], "read") ?? "", /not allowed/);
});

test("validate: sensitive paths are blocked", () => {
  assert.match(validate("cat", ["/Users/x/.ssh/id_rsa"], "read") ?? "", /sensitive/);
  assert.match(validate("cat", ["~/.aws/credentials"], "read") ?? "", /sensitive/);
  assert.ok(isSensitivePath("/x/Library/Keychains/login.keychain-db"));
  assert.ok(!isSensitivePath("/Users/x/Documents/report.pdf"));
});

test("expandTilde resolves a leading ~/", () => {
  assert.ok(expandTilde("~/Documents").startsWith("/"));
  assert.equal(expandTilde("relative/path"), "relative/path");
});

test("runCommand runs an allowlisted read command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-mcp-"));
  const f = join(dir, "hello.txt");
  writeFileSync(f, "ciao mondo");
  const res = await runCommand("cat", [f], { mode: "read" });
  assert.equal(res.ok, true);
  assert.equal(res.stdout, "ciao mondo");
});

test("runCommand refuses a non-allowlisted binary without spawning it", async () => {
  const res = await runCommand("python3", ["-c", "print(1)"], { mode: "read" });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /not allowed/);
});

test("runCommand: shell metacharacters are inert (no shell)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-mcp-"));
  const f = join(dir, "safe.txt");
  writeFileSync(f, "data");
  // The '; rm -rf' is a literal argument to cat, not a shell command.
  const res = await runCommand("cat", [f, "; rm -rf /"], { mode: "read" });
  // cat fails on the bogus filename but nothing is executed/deleted.
  assert.match(res.stdout, /data/);
});
