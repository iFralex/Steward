#!/usr/bin/env -S node --import tsx
import { fileURLToPath } from "node:url";
import { Store } from "./store.ts";
import { BlobStore } from "./blobstore.ts";
import { backfill, reconcile, type SyncDeps } from "./sync.ts";
import { startWatch } from "./watch.ts";
import { findMailRoot, canRead } from "./locator.ts";
import { dbPath, blobsDir } from "./paths.ts";
import { loadEmbedConfig } from "./embed-config.ts";
import { embedText } from "./embed-client.ts";
import { embedBackfill, startEmbedWorker, type EmbedDeps } from "./embed.ts";

function deps(): SyncDeps {
  return { store: Store.open(dbPath()), blobs: new BlobStore(blobsDir()) };
}

export function makeEmbedDeps(store: Store): EmbedDeps | null {
  const cfg = loadEmbedConfig();
  if (!cfg) return null;
  store.enableVectors();
  return { store, model: cfg.model, embed: (text) => embedText(text, cfg) };
}

function requireMailRoot(): string {
  const root = findMailRoot();
  if (!root) {
    console.error("No Apple Mail store found under ~/Library/Mail/V*.");
    process.exit(2);
  }
  if (!canRead(root)) {
    console.error("Cannot read the Mail store. Grant Full Disk Access to this process in");
    console.error("System Settings -> Privacy & Security -> Full Disk Access, then retry.");
    process.exit(3);
  }
  return root;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "backfill") {
    const root = requireMailRoot();
    const d = deps();
    const res = await backfill(d, root);
    console.log(`backfill: ingested ${res.ingested}`);
    d.store.close();
  } else if (cmd === "reconcile") {
    const root = requireMailRoot();
    const d = deps();
    const res = await reconcile(d, root);
    console.log(`reconcile: ingested ${res.ingested}, deleted ${res.deleted}`);
    d.store.close();
  } else if (cmd === "embed") {
    const d = deps();
    const ed = makeEmbedDeps(d.store);
    if (!ed) {
      console.log("Embedding disabled: set MAIL_EMBED_ENDPOINT (and MAIL_EMBED_MODEL) to enable semantic search.");
      d.store.close();
      return;
    }
    let total = 0;
    for (;;) {
      const res = await embedBackfill(ed, { limit: 200 });
      total += res.embedded;
      if (res.unavailable) { console.log(`embed: endpoint unavailable after ${total} embedded`); break; }
      if (res.embedded === 0) { console.log(`embed: done, ${total} embedded`); break; }
      console.log(`embed: ${total} so far...`);
    }
    d.store.close();
  } else if (cmd === "watch") {
    const root = requireMailRoot();
    const d = deps();
    startWatch(d, root);
    const ed = makeEmbedDeps(d.store);
    if (ed) { startEmbedWorker(ed); console.log("embed worker started"); }
    else console.log("embedding disabled (set MAIL_EMBED_ENDPOINT to enable)");
    console.log(`watching ${root} (Ctrl+C to stop)`);
  } else if (cmd === "status") {
    const d = deps();
    const total = d.store.raw.prepare("SELECT COUNT(*) c FROM messages WHERE deleted=0").get() as { c: number };
    const full = d.store.raw.prepare("SELECT COUNT(*) c FROM messages WHERE body_state='full' AND deleted=0").get() as { c: number };
    const threads = d.store.raw.prepare("SELECT COUNT(*) c FROM threads").get() as { c: number };
    const embedded = d.store.embeddedCount();
    console.log(`messages: ${total.c} (full bodies: ${full.c}), threads: ${threads.c}`);
    console.log(`embedded: ${embedded}`);
    console.log(`db: ${dbPath()}`);
    d.store.close();
  } else {
    console.log("usage: mail-mirror <backfill|watch|reconcile|status|embed>");
    process.exit(1);
  }
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
