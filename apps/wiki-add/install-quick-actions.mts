/**
 * Installs two Finder Quick Actions (macOS Services) that call `wiki-add`:
 *   - "Aggiungi a LLM Wiki"          → add selection (folders mirror structure)
 *   - "Aggiungi a LLM Wiki — Scegli…" → pick which files from a folder
 *
 * Each is a Run Shell Script Automator service written to ~/Library/Services.
 * Assign keyboard shortcuts in System Settings → Keyboard → Keyboard Shortcuts →
 * Services. Override the invocation with WIKI_ADD_CMD (e.g. the bundled build).
 *
 *   node --import tsx apps/wiki-add/install-quick-actions.mts
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ENTRY = fileURLToPath(new URL("./src/index.ts", import.meta.url));
// Base command the shell script runs; "$@" (the selected paths) is appended.
const BASE_CMD = process.env.WIKI_ADD_CMD ?? `"${process.execPath}" --import tsx "${ENTRY}"`;
const SERVICES_DIR = join(homedir(), "Library", "Services");

function infoPlist(menuName: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>NSServices</key>
  <array><dict>
    <key>NSMenuItem</key><dict><key>default</key><string>${menuName}</string></dict>
    <key>NSMessage</key><string>runWorkflowAsService</string>
    <key>NSRequiredContext</key><dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>
    <key>NSSendFileTypes</key><array><string>public.item</string></array>
  </dict></array>
</dict></plist>
`;
}

function documentWflow(command: string): string {
  const inputUUID = randomUUID().toUpperCase();
  const outputUUID = randomUUID().toUpperCase();
  const actionUUID = randomUUID().toUpperCase();
  const script = `${command} "$@"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>AMApplicationBuild</key><string>521</string>
  <key>AMApplicationVersion</key><string>2.10</string>
  <key>AMDocumentVersion</key><string>2</string>
  <key>actions</key>
  <array><dict>
    <key>action</key><dict>
      <key>AMAccepts</key><dict>
        <key>Container</key><string>List</string>
        <key>Optional</key><true/>
        <key>Types</key><array><string>com.apple.cocoa.string</string></array>
      </dict>
      <key>AMActionVersion</key><string>2.0.3</string>
      <key>AMApplication</key><array><string>Automator</string></array>
      <key>AMParameterProperties</key><dict>
        <key>COMMAND_STRING</key><dict/>
        <key>CheckedForUserDefaultShell</key><dict/>
        <key>inputMethod</key><dict/>
        <key>shell</key><dict/>
        <key>source</key><dict/>
      </dict>
      <key>AMProvides</key><dict>
        <key>Container</key><string>List</string>
        <key>Types</key><array><string>com.apple.cocoa.string</string></array>
      </dict>
      <key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
      <key>ActionName</key><string>Run Shell Script</string>
      <key>ActionParameters</key><dict>
        <key>COMMAND_STRING</key><string>${escapeXml(script)}</string>
        <key>CheckedForUserDefaultShell</key><true/>
        <key>inputMethod</key><integer>1</integer>
        <key>shell</key><string>/bin/bash</string>
        <key>source</key><string></string>
      </dict>
      <key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
      <key>CFBundleVersion</key><string>2.0.3</string>
      <key>CanShowSelectedItemsWhenRun</key><false/>
      <key>CanShowWhenRun</key><true/>
      <key>Category</key><array><string>AMCategoryUtilities</string></array>
      <key>Class Name</key><string>RunShellScriptAction</string>
      <key>InputUUID</key><string>${inputUUID}</string>
      <key>Keywords</key><array><string>Shell</string></array>
      <key>OutputUUID</key><string>${outputUUID}</string>
      <key>UUID</key><string>${actionUUID}</string>
      <key>UnlocalizedApplications</key><array><string>Automator</string></array>
      <key>arguments</key><dict/>
      <key>isViewVisible</key><integer>1</integer>
    </dict>
    <key>isViewVisible</key><integer>1</integer>
  </dict></array>
  <key>connectors</key><dict/>
  <key>workflowMetaData</key><dict>
    <key>applicationBundleIDsByPath</key><dict/>
    <key>applicationPaths</key><array/>
    <key>inputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject</string>
    <key>outputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
    <key>presentationMode</key><integer>11</integer>
    <key>processesInput</key><integer>0</integer>
    <key>serviceApplicationBundleID</key><string>com.apple.finder</string>
    <key>serviceInputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject</string>
    <key>serviceInputTypeIdentifierIndex</key><integer>0</integer>
    <key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
    <key>serviceOutputTypeIdentifierIndex</key><integer>0</integer>
    <key>systemImageName</key><string>NSActionTemplate</string>
    <key>useAutomaticInputType</key><integer>0</integer>
    <key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict></plist>
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function installWorkflow(menuName: string, command: string): string {
  const bundle = join(SERVICES_DIR, `${menuName}.workflow`);
  const contents = join(bundle, "Contents");
  mkdirSync(contents, { recursive: true });
  writeFileSync(join(contents, "Info.plist"), infoPlist(menuName));
  writeFileSync(join(contents, "document.wflow"), documentWflow(command));
  for (const f of ["Info.plist", "document.wflow"]) {
    execFileSync("plutil", ["-lint", join(contents, f)], { stdio: "pipe" });
  }
  return bundle;
}

const services: { name: string; cmd: string }[] = [
  { name: "Aggiungi a LLM Wiki", cmd: BASE_CMD },
  { name: "Aggiungi a LLM Wiki — Scegli…", cmd: `${BASE_CMD} --pick` },
];

for (const s of services) installWorkflow(s.name, s.cmd);

// Rebuild the Services database so the items appear (and pick up removed ones).
try { execFileSync("/System/Library/CoreServices/pbs", ["-flush"], { stdio: "pipe" }); } catch { /* best-effort */ }

console.log("Installed Finder Quick Actions:");
for (const s of services) console.log(`  ${s.name}`);
console.log("\nUse: right-click a file/folder → Quick Actions.");
console.log("\nKeyboard shortcut (one-time): System Settings → Keyboard → Keyboard Shortcuts →");
console.log("Services → General → tick each item and set a shortcut (e.g. ⌃⌥⌘L).");
console.log("(macOS does not allow assigning a Service shortcut reliably from a script.)");
