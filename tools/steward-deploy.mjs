#!/usr/bin/env node
/** Native macOS installer/updater. Releases are immutable; user data stays outside them. */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, mkdirSync, cpSync, renameSync, symlinkSync, unlinkSync, writeFileSync, realpathSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const home = homedir();
const support = join(home, "Library", "Application Support", "Steward");
const root = resolve(process.env.STEWARD_DEPLOY_ROOT ?? join(support, "deploy"));
const appLink = resolve(process.env.STEWARD_APP_PATH ?? "/Applications/Steward.app");
const configFile = resolve(process.env.STEWARD_CONFIG_FILE ?? join(support, "config.env"));
const stateFile = join(root, "state.json");
const lockDir = join(root, ".deploy.lock");
const command = process.argv[2] ?? "doctor";
const options = new Set(process.argv.slice(3));
const sipUserArg = process.argv.find((arg) => arg.startsWith("--sip-user="))?.slice(11);
const testBundle = process.argv.find((arg) => arg.startsWith("--bundle="))?.slice(9);
const noVoice = options.has("--no-voice");
const skipLaunch = options.has("--no-launch");

function run(program, args, extraEnv = {}) {
  const result = spawnSync(program, args, { cwd: repo, env: { ...process.env, ...extraEnv }, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} exited with ${result.status}`);
}
function capture(program, args) {
  const result = spawnSync(program, args, { cwd: repo, encoding: "utf8" });
  if (result.error || result.status !== 0) return "";
  return result.stdout.trim();
}
function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }
function atomicWrite(path, value, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, value, { mode });
  renameSync(temp, path);
}
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function isLink(path) { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } }
function linkTarget() { return isLink(appLink) ? realpathSync(appLink) : null; }
function samePath(a, b) { return !!a && !!b && existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b); }
function configValues() {
  const values = {};
  if (!existsSync(configFile)) return values;
  for (const line of readFileSync(configFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}
function updateConfig(patch) {
  const previous = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
  let lines = previous.split(/\r?\n/).filter((line) => !Object.keys(patch).some((key) => new RegExp(`^\\s*${key}\\s*=`).test(line)));
  lines = lines.filter((line, i) => i < lines.length - 1 || line !== "");
  for (const [key, value] of Object.entries(patch)) lines.push(`${key}=${JSON.stringify(value)}`);
  atomicWrite(configFile, `${lines.join("\n")}\n`);
  return previous;
}
function output(label, ok, detail) { console.log(`${ok ? "OK" : "MISSING"} ${label}: ${detail}`); return ok; }
function doctor() {
  let ok = true;
  const mac = process.platform === "darwin";
  ok = output("macOS", mac, process.platform) && ok;
  ok = output("Apple Silicon", process.arch === "arm64", process.arch) && ok;
  ok = output("Homebrew ARM", existsSync("/opt/homebrew/bin/brew"), "/opt/homebrew/bin/brew") && ok;
  for (const program of ["node", "npm", "swift", "cargo", "git", "shasum", "sqlite3"]) {
    ok = output(program, !!capture("/usr/bin/which", [program]), capture("/usr/bin/which", [program]) || `install ${program}`) && ok;
  }
  const state = readJson(stateFile);
  const current = linkTarget();
  output("Steward app", !!current && existsSync(join(current, "Contents", "MacOS", "StewardLauncher")), current ?? "not installed by steward-deploy");
  output("configuration", existsSync(configFile), configFile);
  const values = configValues();
  const launcher = values.STEWARD_RINGBACK_LAUNCHER;
  if (values.STEWARD_VOICE_TRANSPORT === "ringback") {
    const healthy = !!launcher && existsSync(launcher) && capture(launcher, ["--doctor"]).includes('"ok":true');
    output("Ringback", healthy, launcher ?? "launcher not configured");
    ok = healthy && ok;
  }
  if (values.STEWARD_VOICE_EXIT_NODE_ID) {
    output("voice exit node", true, "configured via STEWARD_VOICE_EXIT_NODE_ID");
    const tailscale = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    ok = output("Tailscale", existsSync(tailscale), tailscale) && ok;
  }
  if (state?.current && !samePath(current, join(root, "releases", state.current, "Steward.app"))) {
    output("release pointer", false, "state and app link disagree");
    ok = false;
  }
  return ok;
}
function validBundle(path) {
  for (const rel of ["Contents/MacOS/StewardLauncher", "Contents/Resources/node/bin/node", "Contents/Resources/services/host/index.js", "Contents/Resources/web/index.html", "Contents/Info.plist"]) {
    if (!existsSync(join(path, rel))) throw new Error(`Incomplete app bundle: ${rel}`);
  }
  if (process.platform === "darwin") {
    const arch = capture("/usr/bin/file", [join(path, "Contents", "MacOS", "StewardLauncher")]);
    if (!arch.includes("arm64")) throw new Error("App launcher is not arm64");
  }
}
function sipIdentity(source, target) {
  if (!source || !existsSync(source)) return false;
  const lines = readFileSync(source, "utf8").split(/\r?\n/)
    .filter((line) => /^export VOICE_SIP_(?:ID|USER|PROXY|TRANSPORT)=/.test(line));
  if (!lines.some((line) => line.startsWith("export VOICE_SIP_USER="))) return false;
  const content = readFileSync(target, "utf8").split(/\r?\n/)
    .filter((line) => !/^export VOICE_SIP_(?:ID|USER|PROXY|TRANSPORT|PASS)=/.test(line));
  atomicWrite(target, `${content.join("\n")}\n${lines.join("\n")}\n`);
  return true;
}
function checkQuiet() {
  // Do not switch bundles while a call, watcher delivery, or another host is running.
  const port = Number(configValues().HOST_PORT || 4317);
  const probe = spawnSync("/usr/bin/curl", ["--silent", "--max-time", "2", "--output", "/dev/null", "--write-out", "%{http_code}", `http://127.0.0.1:${port}/health`], { encoding: "utf8" });
  if (probe.stdout?.startsWith("200")) throw new Error(`Steward is running on port ${port}. Quit the app and retry the cutover; no release was changed.`);
  const processes = capture("/bin/ps", ["-axo", "command="]);
  const activeBundle = linkTarget() ?? appLink;
  if (processes.split("\n").some((line) => line.includes(join(activeBundle, "Contents", "MacOS", "StewardLauncher")) || line.includes(join(appLink, "Contents", "MacOS", "StewardLauncher")))) {
    throw new Error("StewardLauncher is still running. Quit Steward before switching releases.");
  }
}
function healthReady() {
  const port = Number(configValues().HOST_PORT || 4317);
  const probe = spawnSync("/usr/bin/curl", ["--silent", "--max-time", "2", "--output", "/dev/null", "--write-out", "%{http_code}", `http://127.0.0.1:${port}/health`], { encoding: "utf8" });
  return probe.stdout?.startsWith("200") === true;
}
function waitMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function smoke() {
  if (skipLaunch) return;
  run("/usr/bin/open", [appLink]);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (healthReady()) return;
    waitMs(1_000);
  }
  // Ask only this application to quit. If it stays alive, do not replace its files.
  spawnSync("/usr/bin/osascript", ["-e", 'tell application id "com.steward.launcher" to quit'], { timeout: 5_000 });
  for (let i = 0; i < 10 && healthReady(); i++) waitMs(1_000);
  if (healthReady()) throw new Error("New host did not pass its smoke test and is still running. Quit Steward, then run rollback.");
  rollback();
  throw new Error("New host failed to start within 60 seconds; app and voice configuration were rolled back.");
}
function snapshotData(id) {
  const backupDir = join(root, "backups", id);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const values = configValues();
  const dbs = [
    ["chats", join(values.CHATS_DIR || join(home, "Library/Application Support/steward-chats"), "chats.db")],
    ["audit", join(values.AUDIT_DIR || join(home, "Library/Application Support/steward-audit"), "audit.db")],
    ["usage", join(values.USAGE_DIR || join(home, "Library/Application Support/steward-usage"), "usage.db")],
    ["watches", values.WATCH_DB || join(support, "watches.db")],
    ["actions", values.ACTION_CENTER_DB || join(values.ACTION_CENTER_DIR || join(home, "Library/Application Support/action-center"), "actions.db")],
  ];
  const recorded = [];
  for (const [name, source] of dbs) {
    if (!existsSync(source)) continue;
    const dest = join(backupDir, `${name}.db`);
    run("/usr/bin/sqlite3", [source, `.backup '${dest.replaceAll("'", "''")}'`]);
    recorded.push({ name, source, backup: dest, sha256: sha256(dest) });
  }
  if (existsSync(configFile)) cpSync(configFile, join(backupDir, "config.env"));
  atomicWrite(join(backupDir, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), databases: recorded }, null, 2) + "\n");
  console.log(`Pre-update data snapshot: ${backupDir}`);
}
function swapLink(target) {
  mkdirSync(dirname(appLink), { recursive: true });
  const temp = `${appLink}.${randomUUID()}.tmp`;
  symlinkSync(target, temp);
  renameSync(temp, appLink);
}
function releaseId() { return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`; }
function stage() {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This installer requires an Apple Silicon Mac");
  const id = releaseId();
  const dir = join(root, "releases", id);
  mkdirSync(dir, { recursive: true });
  if (!testBundle) {
    run("npm", ["ci"]);
    run("npm", ["ci", "--prefix", "apps/llm-wiki"]);
    run("npm", ["run", "package:mac"]);
  }
  const bundle = resolve(testBundle ?? join(repo, "dist", "mac", "Steward.app"));
  validBundle(bundle);
  cpSync(bundle, join(dir, "Steward.app"), { recursive: true, dereference: true });
  validBundle(join(dir, "Steward.app"));
  const oldLauncher = configValues().STEWARD_RINGBACK_LAUNCHER;
  if (!noVoice) {
    const ringback = join(dir, "ringback");
    run(join(repo, "tools", "setup-ringback.sh"), [], {
      STEWARD_RINGBACK_DIR: ringback,
      PJPROJECT_DIR: join(dir, "pjproject-2.17"),
      STEWARD_PACKAGED_APP: join(dir, "Steward.app"),
    });
    const oldEnv = oldLauncher ? join(dirname(oldLauncher), "voice.env") : "";
    const inheritedSip = sipIdentity(oldEnv, join(ringback, "voice.env"));
    if (sipUserArg) {
      run(join(repo, "tools", "configure-ringback-sip.sh"), [sipUserArg], { STEWARD_RINGBACK_DIR: ringback });
    }
    if (!inheritedSip && !sipUserArg) throw new Error("No SIP identity to carry forward. Rerun with --sip-user=YOUR_LINPHONE_NAME.");
    if (!capture(join(ringback, "steward-run-voice-mcp.sh"), ["--doctor"]).includes('"ok":true')) {
      throw new Error("Staged Ringback failed its runtime check. Configure a SIP identity or inspect its build before cutover.");
    }
  }
  const meta = { id, createdAt: new Date().toISOString(), commit: capture("git", ["rev-parse", "HEAD"]), lockSha256: sha256(join(repo, "package-lock.json")), voice: !noVoice };
  atomicWrite(join(dir, "release.json"), JSON.stringify(meta, null, 2) + "\n", 0o644);
  console.log(`Staged release ${id}`);
  return id;
}
function assertRelease(id) {
  if (!/^[0-9TZ-]+-[0-9a-f]{8}$/.test(id)) throw new Error("Invalid release id");
  const dir = join(root, "releases", id);
  const meta = readJson(join(dir, "release.json"));
  if (meta?.id !== id) throw new Error(`Release ${id} is incomplete`);
  validBundle(join(dir, "Steward.app"));
  if (meta.voice && !existsSync(join(dir, "ringback", "steward-run-voice-mcp.sh"))) throw new Error("Ringback missing from release");
  return { dir, meta };
}
function cutover(id) {
  const { dir, meta } = assertRelease(id);
  checkQuiet();
  snapshotData(id);
  const state = readJson(stateFile) ?? {};
  if (state.current === id) return;
  let previousApp = linkTarget();
  let adoptedLegacy = null;
  if (existsSync(appLink) && !isLink(appLink)) {
    const legacy = join(root, "releases", `legacy-${releaseId()}`);
    mkdirSync(legacy, { recursive: true });
    renameSync(appLink, join(legacy, "Steward.app"));
    adoptedLegacy = join(legacy, "Steward.app");
    previousApp = adoptedLegacy;
  }
  const oldConfig = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
  const values = configValues();
  try {
    swapLink(join(dir, "Steward.app"));
    const patch = {};
    if (meta.voice) {
      patch.STEWARD_VOICE_TRANSPORT = values.STEWARD_VOICE_TRANSPORT || "ringback";
      patch.STEWARD_RINGBACK_LAUNCHER = join(dir, "ringback", "steward-run-voice-mcp.sh");
    }
    // Migrate the existing selected peer into environment configuration once.
    // Never overwrite an explicit value supplied by the user.
    if (!values.STEWARD_VOICE_EXIT_NODE_ID) {
      const savedNetwork = readJson(process.env.STEWARD_VOICE_NETWORK_SETTINGS_FILE ?? join(support, "voice-network.json"));
      if (typeof savedNetwork?.exitNodeId === "string" && savedNetwork.exitNodeId.trim()) {
        patch.STEWARD_VOICE_EXIT_NODE_ID = savedNetwork.exitNodeId.trim();
      }
    }
    if (Object.keys(patch).length) updateConfig(patch);
    atomicWrite(stateFile, JSON.stringify({ current: id, previous: state.current ?? null, previousApp, previousConfig: oldConfig }, null, 2) + "\n");
    console.log(`Installed ${id} at ${appLink}. User data and credentials were not moved.`);
  } catch (error) {
    if (previousApp) swapLink(previousApp);
    else if (isLink(appLink)) unlinkSync(appLink);
    if (oldConfig !== null) atomicWrite(configFile, oldConfig);
    if (adoptedLegacy) {
      if (isLink(appLink)) unlinkSync(appLink);
      renameSync(adoptedLegacy, appLink);
    }
    throw error;
  }
}
function rollback() {
  checkQuiet();
  const state = readJson(stateFile);
  if (!state?.previousApp) throw new Error("No previous app release is available for rollback");
  validBundle(state.previousApp);
  const currentApp = linkTarget();
  const currentConfig = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
  swapLink(state.previousApp);
  if (state.previousConfig !== null) atomicWrite(configFile, state.previousConfig);
  atomicWrite(stateFile, JSON.stringify({ current: state.previous ?? null, previous: state.current, previousApp: currentApp, previousConfig: currentConfig, legacyApp: state.previous ? null : state.previousApp }, null, 2) + "\n");
  console.log(`Rolled back app to ${state.previousApp}. Persistent data was not changed.`);
}
function verify() {
  const state = readJson(stateFile);
  if (state?.legacyApp) {
    if (!samePath(linkTarget(), state.legacyApp)) throw new Error("Legacy rollback pointer does not match the app link");
    validBundle(state.legacyApp);
    console.log("Verified legacy app rollback");
    return;
  }
  if (!state?.current) throw new Error("No managed release installed");
  const { dir, meta } = assertRelease(state.current);
  if (!samePath(linkTarget(), join(dir, "Steward.app"))) throw new Error("App link does not point to the recorded release");
  if (meta.voice) {
    const launcher = configValues().STEWARD_RINGBACK_LAUNCHER;
    if (launcher !== join(dir, "ringback", "steward-run-voice-mcp.sh")) throw new Error("Ringback config points outside current release");
    if (!capture(launcher, ["--doctor"]).includes('"ok":true')) throw new Error("Ringback runtime check failed");
  }
  console.log(`Verified release ${state.current}`);
}
function withLock(fn) {
  mkdirSync(root, { recursive: true });
  try { mkdirSync(lockDir); } catch { throw new Error("Another deployment is running (or a stale lock exists). Inspect .deploy.lock before retrying."); }
  try { fn(); } finally { rmdirSync(lockDir); }
}

try {
  switch (command) {
    case "doctor": if (!doctor()) process.exitCode = 1; break;
    case "install": case "update": withLock(() => { const id = stage(); if (!options.has("--stage-only")) { cutover(id); verify(); smoke(); } }); break;
    case "activate": withLock(() => { const id = process.argv[3]; if (!id) throw new Error("Usage: activate RELEASE_ID"); cutover(id); verify(); smoke(); }); break;
    case "rollback": withLock(() => { rollback(); verify(); }); break;
    case "verify": verify(); break;
    default: throw new Error("Usage: steward-deploy.mjs doctor|install|update|activate RELEASE_ID|rollback|verify [--stage-only] [--no-voice] [--sip-user=NAME] [--bundle=PATH]");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
