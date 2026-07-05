import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const source = join(repoRoot, "apps", "mac-launcher", "assets", "steward-icon-source.png");
const publicDir = join(repoRoot, "apps", "web", "public");
const tmpDir = join(repoRoot, "tmp", "web-icons");

if (!existsSync(source)) {
  throw new Error(`Missing icon source: ${source}`);
}

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
}

function png(size, name) {
  const out = join(publicDir, name);
  mkdirSync(dirname(out), { recursive: true });
  run("sips", ["-s", "format", "png", "-z", String(size), String(size), source, "--out", out]);
}

function tmpPng(size, name) {
  const out = join(tmpDir, name);
  mkdirSync(dirname(out), { recursive: true });
  run("sips", ["-s", "format", "png", "-z", String(size), String(size), source, "--out", out]);
  return out;
}

rmSync(tmpDir, { recursive: true, force: true });

png(64, "pwa-64x64.png");
png(180, "apple-touch-icon-180x180.png");
png(192, "pwa-192x192.png");
png(512, "pwa-512x512.png");
png(512, "maskable-icon-512x512.png");

const favicon16 = tmpPng(16, "favicon-16.png");
const favicon32 = tmpPng(32, "favicon-32.png");
const favicon48 = tmpPng(48, "favicon-48.png");
run("magick", [
  favicon16,
  favicon32,
  favicon48,
  join(publicDir, "favicon.ico"),
]);
