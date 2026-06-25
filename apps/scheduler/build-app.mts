/**
 * Build a minimal macOS .app wrapper around the scheduler daemon.
 *
 * Why an .app: macOS TCC (Full Disk Access) is granted per bundle. Once you add
 * this .app to Full Disk Access, the node process it launches — and the mail
 * CLIs that node spawns — inherit FDA, so `mail-reconcile` can read ~/Library/Mail.
 * Running as a normal app (not a bare launchd exec) also lets tsx/esbuild start
 * normally. Auto-start at login is a Login Item (added separately).
 *
 * Run: npm --prefix apps/scheduler run build-app
 */
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_NAME = "LLM Wiki Scheduler";
const BUNDLE_ID = "com.llmwiki.scheduler";
const node = process.execPath;
const nodeDir = node.replace(/\/[^/]+$/, "");
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const entry = join(repoRoot, "apps", "scheduler", "src", "index.ts");

const appDir = join(homedir(), "Applications", `${APP_NAME}.app`);
const macosDir = join(appDir, "Contents", "MacOS");
const execPath = join(macosDir, "scheduler");

mkdirSync(macosDir, { recursive: true });

writeFileSync(
  join(appDir, "Contents", "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>scheduler</string>
  <key>LSBackgroundOnly</key><true/>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`,
);

// The bundle executable: set a usable env, run the daemon, keep it alive.
const script = `#!/bin/bash
export PATH="${nodeDir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="${homedir()}"
cd "${repoRoot}" || exit 1
# Restart the daemon if it ever exits (cheap supervisor).
while true; do
  "${node}" --import tsx "${entry}" >> /tmp/llmwiki-scheduler.log 2>&1
  echo "$(date -u +%FT%TZ) [app] scheduler exited, restarting in 5s" >> /tmp/llmwiki-scheduler.log
  sleep 5
done
`;
writeFileSync(execPath, script);
chmodSync(execPath, 0o755);

console.log(`Built ${appDir}`);
console.log("");
console.log("Next steps (one-time):");
console.log(`  1) System Settings → Privacy & Security → Full Disk Access → + → add "${APP_NAME}" (in ~/Applications).`);
console.log(`  2) Start it now:  open "${appDir}"`);
console.log("  3) Auto-start at login: run  npm --prefix apps/scheduler run add-login-item");
console.log("Logs: /tmp/llmwiki-scheduler.log");
