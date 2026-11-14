import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signBundle } from "./mac-signing.mjs";

const script = new URL("./steward-deploy.mjs", import.meta.url).pathname;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "steward-deploy-test-"));
  const bundle = join(dir, "candidate", "Steward.app");
  for (const path of ["Contents/MacOS", "Contents/Resources/node/bin", "Contents/Resources/services/host", "Contents/Resources/web"]) {
    mkdirSync(join(bundle, path), { recursive: true });
  }
  cpSync("/usr/bin/true", join(bundle, "Contents/MacOS/StewardLauncher"));
  cpSync("/usr/bin/true", join(bundle, "Contents/Resources/node/bin/node"));
  writeFileSync(join(bundle, "Contents/Resources/services/host/index.js"), "// test\n");
  writeFileSync(join(bundle, "Contents/Resources/web/index.html"), "<html></html>\n");
  writeFileSync(join(bundle, "Contents/Info.plist"), '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.steward.launcher</string><key>CFBundleExecutable</key><string>StewardLauncher</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n');
  if (process.platform === "darwin") signBundle(bundle);
  const config = join(dir, "config.env");
  writeFileSync(config, `HOST_PORT=59999\nWATCH_DB=${join(dir, "missing-watch.db")}\nCHATS_DIR=${join(dir, "missing-chats")}\nAUDIT_DIR=${join(dir, "missing-audit")}\nUSAGE_DIR=${join(dir, "missing-usage")}\nACTION_CENTER_DIR=${join(dir, "missing-actions")}\nCUSTOM_VALUE=keep-me\n`);
  const env = { ...process.env, STEWARD_BACKUP_HOME: join(dir, "home"), STEWARD_DEPLOY_ROOT: join(dir, "deploy"), STEWARD_APP_PATH: join(dir, "installed", "Steward.app"), STEWARD_CONFIG_FILE: config, STEWARD_VOICE_NETWORK_SETTINGS_FILE: join(dir, "voice-network.json") };
  const call = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8" });
  return { dir, bundle, config, env, call };
}

test("native deployment stages, switches, verifies and rolls back without changing config", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const args = ["--no-voice", "--no-launch", `--bundle=${f.bundle}`];
  let result = f.call("install", ...args);
  assert.equal(result.status, 0, result.stderr);
  const stateFile = join(f.env.STEWARD_DEPLOY_ROOT, "state.json");
  const first = JSON.parse(readFileSync(stateFile, "utf8")).current;
  assert.equal(lstatSync(f.env.STEWARD_APP_PATH).isSymbolicLink(), false);
  assert.equal(f.call("verify").status, 0);
  assert.match(readFileSync(f.config, "utf8"), /CUSTOM_VALUE=keep-me/);
  result = f.call("update", ...args);
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(JSON.parse(readFileSync(stateFile, "utf8")).current, first);
  assert.equal(f.call("rollback", "--no-launch").status, 0);
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).current, first);
  assert.equal(lstatSync(f.env.STEWARD_APP_PATH).isSymbolicLink(), false);
  assert.equal(f.call("verify").status, 0);
  assert.ok(existsSync(join(f.env.STEWARD_DEPLOY_ROOT, "backups")));
});

test("deployment can place its operational snapshot on a separate volume", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  f.env.STEWARD_DEPLOY_BACKUP_ROOT = join(f.dir, "separate-backups");
  const result = f.call("install", "--no-voice", "--no-launch", `--bundle=${f.bundle}`);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(readFileSync(join(f.env.STEWARD_DEPLOY_ROOT, "state.json"), "utf8"));
  assert.ok(existsSync(join(f.env.STEWARD_DEPLOY_BACKUP_ROOT, state.current, "manifest.json")));
  assert.equal(existsSync(join(f.env.STEWARD_DEPLOY_ROOT, "backups", state.current)), false);
});

test("deployment can reuse a healthy existing voice runtime", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const launcher = join(f.dir, "voice.sh");
  writeFileSync(launcher, '#!/bin/sh\nprintf \'{"ok":true}\\n\'\n');
  chmodSync(launcher, 0o755);
  writeFileSync(f.config, readFileSync(f.config, "utf8") + `STEWARD_RINGBACK_LAUNCHER=${launcher}\nSTEWARD_VOICE_TRANSPORT=ringback\n`);
  const result = f.call("install", "--reuse-existing-voice", "--no-launch", `--bundle=${f.bundle}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.call("verify").status, 0);
  assert.match(readFileSync(f.config, "utf8"), /STEWARD_VOICE_TRANSPORT="ringback"/);
  rmSync(launcher);
  assert.notEqual(f.call("verify").status, 0);
});

test("native SQLite cutover refuses an unverified bundle and preserves the installed app", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  cpSync(process.execPath, join(f.bundle, "Contents/Resources/node/bin/node"));
  if (process.platform === "darwin") signBundle(f.bundle);
  const args = ["--no-voice", "--no-launch", `--bundle=${f.bundle}`];
  assert.equal(f.call("install", ...args).status, 0);
  const stateFile = join(f.env.STEWARD_DEPLOY_ROOT, "state.json");
  const before = JSON.parse(readFileSync(stateFile, "utf8")).current;
  const result = f.call("update", ...args, "--native-sqlite");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SQLite and sqlite-vec probe failed/);
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).current, before);
});

test("an incomplete bundle cannot replace a working release", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const args = ["--no-voice", "--no-launch", `--bundle=${f.bundle}`];
  assert.equal(f.call("install", ...args).status, 0);
  const installed = realpathSync(f.env.STEWARD_APP_PATH);
  const broken = join(f.dir, "broken", "Steward.app");
  mkdirSync(broken, { recursive: true });
  const result = f.call("update", "--no-voice", "--no-launch", `--bundle=${broken}`);
  assert.notEqual(result.status, 0);
  assert.equal(realpathSync(f.env.STEWARD_APP_PATH), installed);
});

test("an existing app symlink becomes a real bundle and remains recoverable", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  mkdirSync(join(f.dir, "installed"), { recursive: true });
  symlinkSync(f.bundle, f.env.STEWARD_APP_PATH);
  const result = f.call("install", "--no-voice", "--no-launch", `--bundle=${f.bundle}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lstatSync(f.env.STEWARD_APP_PATH).isSymbolicLink(), false);
  assert.equal(f.call("verify").status, 0);
  assert.equal(f.call("rollback", "--no-launch").status, 0);
  assert.equal(lstatSync(f.env.STEWARD_APP_PATH).isSymbolicLink(), false);
  assert.ok(existsSync(f.bundle));
});

test("verify rejects a modified installed copy", { skip: process.platform !== "darwin" }, (t) => {
  const f = fixture();
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  assert.equal(f.call("install", "--no-voice", "--no-launch", `--bundle=${f.bundle}`).status, 0);
  writeFileSync(join(f.env.STEWARD_APP_PATH, "Contents/Resources/web/index.html"), "tampered");
  const result = f.call("verify");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /codesign/);
});

test("a signed bundle altered after packaging cannot replace a working release", { skip: process.platform !== "darwin" }, (t) => {
  const f = fixture();
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const args = ["--no-voice", "--no-launch", `--bundle=${f.bundle}`];
  assert.equal(f.call("install", ...args).status, 0);
  const installed = realpathSync(f.env.STEWARD_APP_PATH);
  writeFileSync(join(f.bundle, "Contents/Resources/services/host/index.js"), "// modified after signing\n");
  const result = f.call("update", ...args);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /codesign/);
  assert.equal(realpathSync(f.env.STEWARD_APP_PATH), installed);
});

test("a responding host blocks cutover and leaves the installed release intact", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const args = ["--no-voice", "--no-launch", `--bundle=${f.bundle}`];
  const installedResult = f.call("install", ...args);
  assert.equal(installedResult.status, 0, installedResult.stderr);
  const installed = realpathSync(f.env.STEWARD_APP_PATH);
  const server = spawn(process.execPath, ["-e", "require('http').createServer((req,res)=>{res.writeHead(200);res.end('ok')}).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { stdio: ["ignore", "pipe", "pipe"] });
  let serverError = "";
  server.stderr.on("data", (chunk) => { serverError += chunk; });
  try {
    const port = await new Promise((resolve, reject) => {
      let data = "";
      server.stdout.on("data", (chunk) => { data += chunk; if (data.includes("\n")) resolve(Number(data.trim())); });
      server.once("error", reject);
      server.once("exit", () => reject(new Error("test host exited early")));
    }).catch((error) => {
      if (serverError.includes("EPERM")) { t.skip("sandbox forbids opening a local test socket"); return null; }
      throw error;
    });
    if (port === null) return;
    writeFileSync(f.config, `HOST_PORT=${port}\nWATCH_DB=${join(f.dir, "missing-watch.db")}\n`);
    const result = f.call("update", ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Quit the app/);
    assert.equal(realpathSync(f.env.STEWARD_APP_PATH), installed);
  } finally {
    server.kill();
  }
});
