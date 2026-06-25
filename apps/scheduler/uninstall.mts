/**
 * Stop and remove the scheduler LaunchAgent.
 * Run: npm --prefix apps/scheduler run uninstall-agent
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const plistPath = join(homedir(), "Library", "LaunchAgents", "com.llmwiki.scheduler.plist");
try { execFileSync("launchctl", ["unload", plistPath], { stdio: "inherit" }); } catch { /* not loaded */ }
if (existsSync(plistPath)) { rmSync(plistPath); console.log(`removed ${plistPath}`); }
else console.log("nothing to remove");
