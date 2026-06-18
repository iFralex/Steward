#!/usr/bin/env -S node --import tsx
import { Store } from "./store.ts";
import { BlobStore } from "./blobstore.ts";
import { backfill, reconcile, type SyncDeps } from "./sync.ts";
import { startWatch } from "./watch.ts";
import { findMailRoot, canRead } from "./locator.ts";
import { dbPath, blobsDir } from "./paths.ts";

function deps(): SyncDeps {
  return { store: Store.open(dbPath()), blobs: new BlobStore(blobsDir()) };
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
  } else if (cmd === "watch") {
    const root = requireMailRoot();
    const d = deps();
    startWatch(d, root);
    console.log(`watching ${root} (Ctrl+C to stop)`);
  } else if (cmd === "status") {
    const d = deps();
    const total = d.store.raw.prepare("SELECT COUNT(*) c FROM messages WHERE deleted=0").get() as { c: number };
    const full = d.store.raw.prepare("SELECT COUNT(*) c FROM messages WHERE body_state='full' AND deleted=0").get() as { c: number };
    const threads = d.store.raw.prepare("SELECT COUNT(*) c FROM threads").get() as { c: number };
    console.log(`messages: ${total.c} (full bodies: ${full.c}), threads: ${threads.c}`);
    console.log(`db: ${dbPath()}`);
    d.store.close();
  } else {
    console.log("usage: mail-mirror <backfill|watch|reconcile|status>");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
