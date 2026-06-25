/**
 * Add the scheduler .app as a hidden Login Item so it starts at login.
 * Run: npm --prefix apps/scheduler run add-login-item
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const APP_NAME = "LLM Wiki Scheduler";
const app = join(homedir(), "Applications", `${APP_NAME}.app`);
const script = `tell application "System Events"
  if not (exists login item "${APP_NAME}") then
    make login item at end with properties {path:"${app}", hidden:true, name:"${APP_NAME}"}
  end if
end tell`;
execFileSync("osascript", ["-e", script], { stdio: "inherit" });
console.log(`Added Login Item: ${APP_NAME} (starts hidden at login)`);
