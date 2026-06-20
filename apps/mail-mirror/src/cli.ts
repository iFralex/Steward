#!/usr/bin/env -S node --import tsx
import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";
import { Store } from "./store.ts";
import { BlobStore } from "./blobstore.ts";
import { backfill, reconcile, ingestEmlxFile, type SyncDeps } from "./sync.ts";
import { refreshIdentity } from "./enrich.ts";
import { startWatch } from "./watch.ts";
import { findMailRoot, canRead, entryForPath } from "./locator.ts";
import { dbPath, blobsDir } from "./paths.ts";
import { loadEmbedConfig } from "./embed-config.ts";
import { embedText, embedTexts } from "./embed-client.ts";
import { embedBackfill, startEmbedWorker, type EmbedDeps } from "./embed.ts";
import { loadRoleClassifier } from "./role-classify.ts";

function deps(): SyncDeps {
  return { store: Store.open(dbPath()), blobs: new BlobStore(blobsDir()) };
}

export function makeEmbedDeps(store: Store): EmbedDeps | null {
  const cfg = loadEmbedConfig();
  if (!cfg) return null;
  store.enableVectors();
  return {
    store,
    model: cfg.model,
    embed: (text) => embedText(text, cfg),
    embedBatch: (texts) => embedTexts(texts, cfg),
  };
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
  const classifyRole = loadRoleClassifier();
  if (cmd === "backfill") {
    const root = requireMailRoot();
    const d = deps();
    const res = await backfill(d, root);
    try { await refreshIdentity({ store: d.store, mailRoot: root, classifyRole }); } catch { /* best-effort */ }
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
      console.log("Embedding disabled (MAIL_EMBED_ENDPOINT=off). Default routes to the LLM gateway at :4000.");
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
    if (ed) { startEmbedWorker(ed); console.log(`embed worker started (gateway: ${process.env.MAIL_EMBED_ENDPOINT ?? "http://127.0.0.1:4000/v1/embeddings"})`); }
    else console.log("embed worker off (MAIL_EMBED_ENDPOINT=off)");
    refreshIdentity({ store: d.store, mailRoot: root, classifyRole }).catch(() => {});
    setInterval(() => refreshIdentity({ store: d.store, mailRoot: root, classifyRole }).catch(() => {}), 300_000);
    console.log(`watching ${root} (Ctrl+C to stop)`);
  } else if (cmd === "status") {
    const d = deps();
    const total = d.store.raw.prepare("SELECT COUNT(*) c FROM messages WHERE deleted=0").get() as { c: number };
    const full = d.store.raw.prepare("SELECT COUNT(*) c FROM messages WHERE body_state='full' AND deleted=0").get() as { c: number };
    const threads = d.store.raw.prepare("SELECT COUNT(*) c FROM threads").get() as { c: number };
    const embedded = d.store.embeddedCount();
    const accts = d.store.raw.prepare("SELECT COUNT(*) c FROM accounts").get() as { c: number };
    const roles = d.store.raw.prepare("SELECT COUNT(*) c FROM mailbox_roles WHERE role IS NOT NULL").get() as { c: number };
    console.log(`messages: ${total.c} (full bodies: ${full.c}), threads: ${threads.c}`);
    console.log(`embedded: ${embedded}`);
    console.log(`accounts: ${accts.c}, classified mailboxes: ${roles.c}`);
    console.log(`db: ${dbPath()}`);
    d.store.close();
  } else if (cmd === "migrate") {
    const root = requireMailRoot();
    const d = deps();
    let n = 0;
    const paths = d.store.raw.prepare("SELECT path FROM message_paths").all() as { path: string }[];
    for (const { path } of paths) {
      let mtimeMs = 0;
      try { mtimeMs = statSync(path).mtimeMs; } catch { continue; }
      if (await ingestEmlxFile(d, entryForPath(root, path, mtimeMs))) n++;
    }
    const ident = await refreshIdentity({ store: d.store, mailRoot: root, classifyRole });
    console.log(`migrate: re-ingested ${n}, accounts ${ident.accounts}, roles ${ident.roles}`);
    d.store.close();
  } else {
    console.log("usage: mail-mirror <backfill|watch|reconcile|status|embed|migrate>");
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
