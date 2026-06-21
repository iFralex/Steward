#!/usr/bin/env -S node --import tsx
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AppleStore } from "./apple-store.ts";
import { IndexDb } from "./index-db.ts";
import { syncIndex } from "./sync.ts";
import { loadEmbedConfig } from "./embed-config.ts";
import { applePath, indexDbPath } from "./paths.ts";

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "index" || cmd === "sync") {
    if (!existsSync(applePath())) { console.error("Apple Calendar store not found. Grant Full Disk Access."); process.exit(3); }
    const idxPath = indexDbPath();
    mkdirSync(dirname(idxPath), { recursive: true });
    const store = AppleStore.openReadonly(applePath());
    const index = IndexDb.open(idxPath);
    const res = await syncIndex({ store, index, embedConfig: loadEmbedConfig() });
    console.log(`sync: upserted ${res.upserted}, embedded ${res.embedded}, deleted ${res.deleted}`);
    store.close(); index.close();
  } else if (cmd === "status") {
    const idxPath = indexDbPath();
    if (!existsSync(idxPath)) { console.log("index: not built yet"); return; }
    const index = IndexDb.open(idxPath);
    console.log(`indexed events: ${index.allUids().length}`);
    console.log(`db: ${idxPath}`);
    index.close();
  } else {
    console.log("usage: calendar-mcp <index|sync|status>");
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
