import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate, runCommand, runPipeline, runCommandLine, parsePipeline, isSensitivePath, expandTilde, clip } from "../src/exec.ts";

test("sips is not allowed in read mode (it mutates images in place)", () => {
  assert.match(validate("sips", ["-r", "90", "/tmp/x.jpg"], "read") ?? "", /not allowed|changes files/);
  assert.equal(validate("sips", ["-r", "90", "/tmp/x.jpg"], "write"), null);
});

test("validate: read binary allowed, write binary denied in read mode", () => {
  assert.equal(validate("cat", ["/tmp/x"], "read"), null);
  assert.match(validate("rm", ["/tmp/x"], "read") ?? "", /run_write_command/);
});

test("validate: write mode allows write + read binaries but not others", () => {
  assert.equal(validate("mv", ["/tmp/a", "/tmp/b"], "write"), null);
  assert.equal(validate("cat", ["/tmp/x"], "write"), null); // read binaries ok as pipeline stages
  assert.match(validate("python3", [], "write") ?? "", /not allowed in write/);
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

test("clip caps lines and reports the total", () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const r = clip(text, 120, 100_000);
  assert.equal(r.clipped, true);
  assert.equal(r.totalLines, 500);
  assert.equal(r.text.split("\n").length, 120);
});

test("runCommand truncates a huge directory listing and hints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-mcp-"));
  for (let i = 0; i < 400; i++) writeFileSync(join(dir, `f${String(i).padStart(3, "0")}.txt`), "x");
  const res = await runCommand("ls", ["-1", dir], { mode: "read" });
  assert.equal(res.ok, true);
  assert.equal(res.truncated, true);
  assert.ok((res.totalLines ?? 0) >= 400);
  assert.ok(res.stdout.split("\n").length <= 120);
  assert.match(res.hint ?? "", /truncated/i);
});

test("runPipeline wires stages: ls -t | head -1 returns the newest entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-mcp-"));
  writeFileSync(join(dir, "old.txt"), "x");
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(dir, "new.txt"), "x");
  const res = await runPipeline([
    { command: "ls", args: ["-t", dir] },
    { command: "head", args: ["-1"] },
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.stdout.trim(), "new.txt");
});

test("runPipeline: grep filter + head compose", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-mcp-"));
  writeFileSync(join(dir, "a.pdf"), "x");
  writeFileSync(join(dir, "b.txt"), "x");
  writeFileSync(join(dir, "c.pdf"), "x");
  const res = await runPipeline([
    { command: "ls", args: ["-1", dir] },
    { command: "grep", args: ["-i", "\\.pdf$"] },
    { command: "wc", args: ["-l"] },
  ]);
  assert.equal(res.ok, true);
  assert.equal(Number(res.stdout.trim()), 2);
});

test("runPipeline validates every stage against the read allowlist", async () => {
  const res = await runPipeline([
    { command: "ls", args: ["/tmp"] },
    { command: "rm", args: ["-rf", "/tmp/x"] },
  ]);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /stage 'rm'.*run_write_command/);
});

test("runPipeline blocks sensitive paths in any stage", async () => {
  const res = await runPipeline([{ command: "cat", args: ["/Users/x/.ssh/id_rsa"] }]);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /sensitive/);
});

test("parsePipeline: words, quotes, and pipe splitting", () => {
  const r = parsePipeline(`ls -t "my dir" | grep -i '\\.pdf$' | head -1`);
  assert.ok("stages" in r);
  if ("stages" in r) {
    assert.deepEqual(r.stages[0], { command: "ls", args: ["-t", "my dir"] });
    assert.deepEqual(r.stages[1], { command: "grep", args: ["-i", "\\.pdf$"] });
    assert.deepEqual(r.stages[2], { command: "head", args: ["-1"] });
  }
});

test("parsePipeline rejects shell operators and empty stages", () => {
  for (const bad of ["cat a; rm b", "cat a > b", "cat a && cat b", "echo `id`", "cat $(whoami)"]) {
    const r = parsePipeline(bad);
    assert.ok("error" in r, `expected error for: ${bad}`);
  }
  assert.ok("error" in parsePipeline("ls | | wc -l"));
  assert.ok("error" in parsePipeline('cat "unbalanced'));
});

test("runCommandLine parses natural syntax: ls -t | head -1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-mcp-"));
  writeFileSync(join(dir, "old.txt"), "x");
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(dir, "new.txt"), "x");
  const res = await runCommandLine(`ls -t ${dir} | head -1`, "read");
  assert.equal(res.ok, true);
  assert.equal(res.stdout.trim(), "new.txt");
});

test("runCommandLine read mode refuses a write binary with a helpful message", async () => {
  const res = await runCommandLine("rm -rf /tmp/whatever", "read");
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /run_write_command/);
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
