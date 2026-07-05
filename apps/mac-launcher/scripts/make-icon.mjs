import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const source = join(repoRoot, "apps", "mac-launcher", "assets", "steward-icon-source.png");
const normalized = join(repoRoot, "apps", "mac-launcher", "assets", "steward-icon-1024.png");
const iconsetDir = join(repoRoot, "tmp", "Steward.iconset");
const output = join(repoRoot, "apps", "mac-launcher", "assets", "Steward.icns");

if (!existsSync(source)) {
  throw new Error(`Missing icon source: ${source}`);
}

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
}

rmSync(iconsetDir, { recursive: true, force: true });
mkdirSync(iconsetDir, { recursive: true });
mkdirSync(dirname(output), { recursive: true });

const sizes = [
  ["16", "icon_16x16.png"],
  ["32", "icon_16x16@2x.png"],
  ["32", "icon_32x32.png"],
  ["64", "icon_32x32@2x.png"],
  ["128", "icon_128x128.png"],
  ["256", "icon_128x128@2x.png"],
  ["256", "icon_256x256.png"],
  ["512", "icon_256x256@2x.png"],
  ["512", "icon_512x512.png"],
  ["1024", "icon_512x512@2x.png"],
];

run("sips", ["-s", "format", "png", "-z", "1024", "1024", source, "--out", normalized]);

for (const [size, name] of sizes) {
  run("sips", ["-s", "format", "png", "-z", size, size, normalized, "--out", join(iconsetDir, name)]);
}

const icnsEntries = [
  ["icp4", "icon_16x16.png"],
  ["icp5", "icon_32x32.png"],
  ["icp6", "icon_32x32@2x.png"],
  ["ic07", "icon_128x128.png"],
  ["ic08", "icon_256x256.png"],
  ["ic09", "icon_512x512.png"],
  ["ic10", "icon_512x512@2x.png"],
  ["ic11", "icon_16x16@2x.png"],
  ["ic12", "icon_32x32@2x.png"],
  ["ic13", "icon_128x128@2x.png"],
  ["ic14", "icon_256x256@2x.png"],
];

const parts = [];
let totalLength = 8;
for (const [type, name] of icnsEntries) {
  const data = readFileSync(join(iconsetDir, name));
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(data.length + 8, 4);
  parts.push(header, data);
  totalLength += data.length + 8;
}

const header = Buffer.alloc(8);
header.write("icns", 0, "ascii");
header.writeUInt32BE(totalLength, 4);
writeFileSync(output, Buffer.concat([header, ...parts], totalLength));
console.log(`Wrote ${output}`);
