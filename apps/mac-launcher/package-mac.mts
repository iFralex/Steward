import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const APP_NAME = "LLM Wiki";
const BUNDLE_ID = "com.llmwiki.launcher";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const appDir = join(repoRoot, "dist", "mac", `${APP_NAME}.app`);
const contentsDir = join(appDir, "Contents");
const macosDir = join(contentsDir, "MacOS");
const resourcesDir = join(contentsDir, "Resources");
const servicesDir = join(resourcesDir, "services");
const llmWikiBundleDir = join(resourcesDir, "llm-wiki");
const nodeDir = join(resourcesDir, "node", "bin");
const nodePath = join(nodeDir, "node");
const nodeModulesDir = join(resourcesDir, "node_modules");
const debugPackage = process.env.PACKAGE_DEBUG === "1";
const skipLLMWikiBuild = process.env.PACKAGE_SKIP_LLM_WIKI_BUILD === "1";

const entries: Record<string, string> = {
  "host/index.js": "apps/host/src/index.ts",
  "llm-gateway/gateway.js": "apps/llm-gateway/src/gateway.ts",
  "scheduler/index.js": "apps/scheduler/src/index.ts",
  "mcp/llm-wiki.js": "apps/llm-wiki/mcp-server/src/index.ts",
  "mcp/mail.js": "apps/mail-mcp/src/index.ts",
  "mcp/calendar.js": "apps/calendar-mcp/src/index.ts",
  "mcp/contacts.js": "apps/contacts-mcp/src/index.ts",
  "mcp/action-center.js": "apps/action-center/src/index.ts",
  "mcp/shell.js": "apps/shell-mcp/src/index.ts",
  "cli/mail-mirror.js": "apps/mail-mirror/src/cli.ts",
  "cli/mail-promoter.js": "apps/mail-promoter/src/cli.ts",
  "cli/action-center.js": "apps/action-center/src/cli.ts",
  "cli/write-ops.js": "apps/scheduler/src/write-ops-cli.ts",
  "cli/calendar.js": "apps/calendar-mcp/src/cli.ts",
  "cli/contacts.js": "apps/contacts-mcp/src/cli.ts",
};

function run(cmd: string, args: string[]): void {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
}

function esbuild(outFile: string, entry: string): void {
  mkdirSync(dirname(outFile), { recursive: true });
  const args = [
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    "--external:better-sqlite3",
    "--external:sqlite-vec",
    "--external:fsevents",
    "--external:ws",
    "--banner:js=import { createRequire as __llmWikiCreateRequire } from 'node:module'; const require = __llmWikiCreateRequire(import.meta.url);",
    "--outfile=" + outFile,
  ];
  if (debugPackage) {
    args.splice(5, 0, "--sourcemap");
  }
  run(join(repoRoot, "node_modules", ".bin", "esbuild"), args);
}

function packageRoot(specifier: string, fromDir = repoRoot): string {
  const resolver = createRequire(join(fromDir, "__package_probe__.js"));
  try {
    return dirname(resolver.resolve(`${specifier}/package.json`));
  } catch {
    const located = findPackageRootInNodeModules(specifier, fromDir);
    if (located) {
      return located;
    }
    let current = dirname(resolver.resolve(specifier));
    while (current !== dirname(current)) {
      if (existsSync(join(current, "package.json"))) {
        return current;
      }
      current = dirname(current);
    }
    throw new Error(`Could not resolve package root for ${specifier}`);
  }
}

function findPackageRootInNodeModules(specifier: string, fromDir: string): string | null {
  let current = fromDir;
  while (true) {
    const candidate = join(current, "node_modules", specifier);
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function packageJson(root: string): { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

function copyPackageClosure(specifier: string, seen = new Set<string>(), fromDir = repoRoot): void {
  const root = packageRoot(specifier, fromDir);
  const realRoot = realpathSync(root);
  if (seen.has(realRoot)) return;
  seen.add(realRoot);

  const rel = relative(join(repoRoot, "node_modules"), root);
  if (rel.startsWith("..")) {
    throw new Error(`Package ${specifier} resolved outside root node_modules: ${root}`);
  }
  const dest = join(nodeModulesDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(root, dest, { recursive: true, dereference: true });

  const json = packageJson(root);
  for (const dep of Object.keys(json.dependencies ?? {})) {
    copyPackageClosure(dep, seen, root);
  }
  for (const dep of Object.keys(json.optionalDependencies ?? {})) {
    try {
      copyPackageClosure(dep, seen, root);
    } catch {
      // Optional platform packages are often absent by design.
    }
  }
}

function copyRuntimeNodeModules(): void {
  mkdirSync(nodeModulesDir, { recursive: true });
  const seen = new Set<string>();
  for (const pkg of ["better-sqlite3", "sqlite-vec", "ws"]) {
    copyPackageClosure(pkg, seen);
  }
  console.log(`Copied ${seen.size} runtime packages into ${nodeModulesDir}`);
}

function findLLMWikiAppBundle(): string {
  const candidates = [
    join(repoRoot, "apps", "llm-wiki", "src-tauri", "target", "release", "bundle", "macos", "LLM Wiki.app"),
    join(repoRoot, "apps", "llm-wiki", "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle", "macos", "LLM Wiki.app"),
    join(repoRoot, "apps", "llm-wiki", "src-tauri", "target", "x86_64-apple-darwin", "release", "bundle", "macos", "LLM Wiki.app"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Missing LLM Wiki Tauri app bundle. Checked:\n${candidates.map((c) => `  - ${c}`).join("\n")}`);
  }
  return found;
}

rmSync(appDir, { recursive: true, force: true });
mkdirSync(macosDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });
mkdirSync(servicesDir, { recursive: true });

run("npm", ["run", "build", "-w", "@steward/web"]);
if (skipLLMWikiBuild) {
  console.log("$ PACKAGE_SKIP_LLM_WIKI_BUILD=1: reusing existing LLM Wiki Tauri bundle");
  findLLMWikiAppBundle();
} else {
  run("npm", ["--prefix", "apps/llm-wiki", "run", "tauri", "--", "build", "--bundles", "app"]);
}
run("swift", ["build", "--package-path", "apps/mac-launcher", "-c", "release"]);

for (const [outRel, entry] of Object.entries(entries)) {
  esbuild(join(servicesDir, outRel), entry);
}

writeFileSync(join(servicesDir, "package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");
cpSync(join(repoRoot, "apps", "web", "dist"), join(resourcesDir, "web"), { recursive: true });
mkdirSync(llmWikiBundleDir, { recursive: true });
cpSync(findLLMWikiAppBundle(), join(llmWikiBundleDir, "LLM Wiki.app"), { recursive: true });
copyRuntimeNodeModules();
mkdirSync(nodeDir, { recursive: true });
cpSync(process.execPath, nodePath);
chmodSync(nodePath, 0o755);

const launcher = join(repoRoot, "apps", "mac-launcher", ".build", "release", "LLMWikiLauncher");
if (!existsSync(launcher)) {
  throw new Error(`Missing launcher executable: ${launcher}`);
}
cpSync(launcher, join(macosDir, "LLMWikiLauncher"));
chmodSync(join(macosDir, "LLMWikiLauncher"), 0o755);

writeFileSync(
  join(contentsDir, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>LLMWikiLauncher</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`,
);

console.log("");
console.log(`Built ${appDir}`);
console.log(`Run it with: open "${appDir}"`);
console.log("Config file: ~/Library/Application Support/LLM Wiki/config.env");
console.log("Logs: ~/Library/Logs/LLM Wiki/");
