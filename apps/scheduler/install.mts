/**
 * Install the scheduler as a macOS LaunchAgent: writes the plist and loads it.
 * RunAtLoad + KeepAlive → starts at login and restarts if it ever dies.
 * Run: npm --prefix apps/scheduler run install-agent
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const LABEL = "com.llmwiki.scheduler";
const node = process.execPath;
const entry = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const agentsDir = join(homedir(), "Library", "LaunchAgents");
const plistPath = join(agentsDir, `${LABEL}.plist`);
const nodeDir = node.replace(/\/[^/]+$/, "");
// launchd starts with a near-empty environment; give the daemon (and the CLIs
// it spawns) a usable PATH and HOME so node/tsx resolve.
const pathEnv = `${nodeDir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>--import</string><string>tsx</string>
    <string>${entry}</string>
  </array>
  <key>WorkingDirectory</key><string>${repoRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${pathEnv}</string>
    <key>HOME</key><string>${homedir()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/llmwiki-scheduler.log</string>
  <key>StandardErrorPath</key><string>/tmp/llmwiki-scheduler.err</string>
</dict>
</plist>
`;

mkdirSync(agentsDir, { recursive: true });
writeFileSync(plistPath, plist);
console.log(`wrote ${plistPath}`);
try { execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" }); } catch { /* not loaded yet */ }
execFileSync("launchctl", ["load", plistPath], { stdio: "inherit" });
console.log(`loaded ${LABEL}. Logs: /tmp/llmwiki-scheduler.log (errors: /tmp/llmwiki-scheduler.err)`);
