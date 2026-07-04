// End-to-end smoke: real .emlx -> mirror ingest -> embed (Ollama) -> FTS + semantic search.
// Writes to a throwaway dir. Needs Full Disk Access + MAIL_EMBED_ENDPOINT/MODEL set.
import { rmSync, mkdirSync } from "node:fs";
import { findMailRoot, canRead, enumerateEmlx } from "./src/locator.ts";
import { Store } from "./src/store.ts";
import { BlobStore } from "./src/blobstore.ts";
import { ingestEmlxFile } from "./src/sync.ts";
import { embedBackfill } from "./src/embed.ts";
import { embedText } from "./src/embed-client.ts";
import { loadEmbedConfig } from "./src/embed-config.ts";
import { searchDb } from "../mail-mcp/src/db-search.ts";

const N = Number(process.env.E2E_N ?? 400);
const DIR = "/tmp/mm-e2e";
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

const root = findMailRoot();
if (!root || !canRead(root)) {
  console.error("Full Disk Access missing — cannot read ~/Library/Mail.");
  process.exit(3);
}

const store = Store.open(`${DIR}/mail.db`);
store.enableVectors();
const blobs = new BlobStore(`${DIR}/blobs`);

const t0 = Date.now();
const entries = enumerateEmlx(root).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, N);
let ingested = 0;
for (const e of entries) if (await ingestEmlxFile({ store, blobs }, e)) ingested++;
console.log(`ingested ${ingested}/${entries.length} recent messages in ${Date.now() - t0}ms`);

const cfg = loadEmbedConfig();
let embedded = 0;
if (cfg) {
  const t1 = Date.now();
  const deps = { store, model: cfg.model, embed: (t: string) => embedText(t, cfg) };
  for (;;) {
    const r = await embedBackfill(deps, { limit: 200 });
    embedded += r.embedded;
    if (r.unavailable || r.embedded === 0) break;
  }
  console.log(`embedded ${embedded} messages in ${Date.now() - t1}ms (vec_dim=${store.getState("vec_dim")})`);
} else {
  console.log("no embedding config -> FTS-only");
}

const embedQuery = cfg ? (t: string) => embedText(t, cfg) : undefined;
const queries = ["trenitalia", "frecciarossa", "sconti treni veloci", "offerte per viaggiare in treno", "spotify", "fattura"];
for (const q of queries) {
  const hits = await searchDb(store, { query: q, limit: 3 }, embedQuery);
  console.log(`\n[${q}] -> ${hits.length}`);
  for (const h of hits) console.log(`   ${h.subject.slice(0, 55)}  ::  ${h.from.slice(0, 32)}`);
}
store.close();
