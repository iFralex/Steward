#!/usr/bin/env -S node --import tsx
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Store } from "../../mail-mirror/src/store.ts";
import { blobsDir, dbPath } from "../../mail-mirror/src/paths.ts";
import { LlmWikiApiClient } from "../../llm-wiki/mcp-server/src/api-client.ts";
import { PromoteState } from "./state.ts";
import { stateDbPath } from "./paths.ts";
import { loadConfig } from "./config.ts";
import { gatewayChat } from "./llm.ts";
import { runBatch, type RunDeps } from "./run.ts";
import { makeFsWikiPromoter } from "./wiki.ts";
import { evaluate, type LabelledItem } from "./eval.ts";
import { migratePromotedThreadNotes } from "./migrate-thread-notes.ts";
import { syncThreadAttachments } from "./attachments.ts";
import { syncPromotedThreadAttachments } from "./sync-promoted-attachments.ts";

// resolveSourcesDir now lives in the wiki mcp-server (shared with the file
// "add to wiki" CLI). Imported for local use and re-exported for existing importers.
import { resolveSourcesDir } from "../../llm-wiki/mcp-server/src/project-path.ts";
export { resolveSourcesDir };

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const cfg = loadConfig();
  const store = Store.openReadonly(dbPath());
  const state = PromoteState.open(stateDbPath());
  const apiClient = new LlmWikiApiClient({ baseUrl: process.env.LLM_WIKI_API_BASE_URL });
  // The user's own email addresses across all mirrored accounts — lets triage
  // judge whether the user is personally involved (vs a passive list subscriber).
  const userAddrs = [
    ...new Set(
      (store.raw.prepare("SELECT emails FROM accounts").all() as { emails: string | null }[])
        .flatMap((r) => (r.emails ?? "").split(/[,;\s]+/))
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const deps: RunDeps = {
    store, state, wiki: apiClient,
    chat: gatewayChat({ endpoint: cfg.llmEndpoint, model: cfg.triageModel, apiKey: cfg.apiKey, usage: { service: "mail-promoter", action: "triage" } }),
    roleOf: (a, m) => store.roleForMailbox(a, m),
    accountLabelOf: (a) => (store.raw.prepare("SELECT emails FROM accounts WHERE uuid=?").get(a) as { emails: string } | undefined)?.emails ?? a,
    userAddrs,
    model: cfg.triageModel,
  };
  if (cmd === "backfill") {
    // Usage: mail-promoter backfill [limit]   (concurrency via MAIL_PROMOTER_CONCURRENCY, default 10)
    const limit = process.argv[3] ? Number(process.argv[3]) : undefined;
    const concurrency = Number(process.env.MAIL_PROMOTER_CONCURRENCY ?? 10);
    // Write notes straight to the project's sources dir on disk — the app need not
    // be running during the backfill. Indexing is a single rescan afterwards.
    const sourcesDir = resolveSourcesDir();
    deps.wiki = makeFsWikiPromoter(sourcesDir);
    const maxAttachmentBytes = Number(process.env.MAIL_PROMOTER_ATTACHMENT_MAX_MB ?? 100) * 1024 * 1024;
    deps.syncAttachments = (threadId, selectedAttachmentIds) => syncThreadAttachments({
      store,
      threadId,
      blobRoot: blobsDir(),
      sourcesDir,
      maxBytes: maxAttachmentBytes,
      includeIds: selectedAttachmentIds,
    }).attachments;
    console.log(`promote backfill: limit=${limit ?? "all"} concurrency=${concurrency} model=${cfg.triageModel}`);
    console.log(`promote backfill: writing notes to ${sourcesDir} (app can be closed)`);
    const t = await runBatch(deps, { limit, concurrency });
    console.log(`promote backfill: promoted ${t.promoted}, skipped ${t.skipped}, filtered ${t.filtered}, deferred ${t.deferred}`);
    if (t.promoted > 0) {
      console.log("rescan: open LLM Wiki, then run 'mail-promoter rescan' to index all notes in one pass.");
      try { await apiClient.rescan("current"); console.log("rescan: completato"); }
      catch { console.log("rescan: app non in esecuzione — riapri LLM Wiki e lancia 'mail-promoter rescan'."); }
    }
  } else if (cmd === "rescan") {
    console.log("rescan: indicizzazione di tutte le note nel progetto corrente...");
    await apiClient.rescan("current");
    console.log("rescan: completato");
  } else if (cmd === "migrate-thread-notes") {
    const sourcesDir = resolveSourcesDir();
    const r = migratePromotedThreadNotes(state, sourcesDir);
    console.log(`thread-note migration: ${sourcesDir}`);
    console.log(`  migrated: ${r.migrated}`);
    console.log(`  already canonical: ${r.alreadyCanonical}`);
    console.log(`  state recovered: ${r.recoveredState}`);
    console.log(`  missing: ${r.missing}`);
    console.log(`  conflicts: ${r.conflicts}`);
    console.log(`  duplicate notes removed: ${r.duplicateNotesRemoved}`);
    console.log(`  canonical notes replaced by newer copy: ${r.canonicalNotesReplaced}`);
  } else if (cmd === "sync-attachments") {
    const sourcesDir = resolveSourcesDir();
    const maxBytes = Number(process.env.MAIL_PROMOTER_ATTACHMENT_MAX_MB ?? 100) * 1024 * 1024;
    const r = syncPromotedThreadAttachments({
      store,
      state,
      blobRoot: blobsDir(),
      sourcesDir,
      maxBytes,
    });
    console.log(`attachment sync: ${sourcesDir}`);
    console.log(`  promoted threads checked: ${r.threads}`);
    console.log(`  notes updated: ${r.notesUpdated}`);
    console.log(`  attachments linked: ${r.attachmentsLinked}`);
    console.log(`  blobs copied: ${r.blobsCopied}`);
    console.log(`  blobs already present: ${r.blobsAlreadyPresent}`);
    console.log(`  skipped unsupported/missing/oversize: ${r.skippedAttachments}`);
    console.log(`  missing notes: ${r.missingNotes}`);
  } else if (cmd === "status") {
    const c = state.counts();
    console.log(`promoter state: ${stateDbPath()}`);
    console.log(`  promoted: ${c.promoted}  skipped: ${c.skipped}`);
  } else if (cmd === "eval") {
    const fixturePath = process.argv[3];
    if (!fixturePath) {
      console.error("usage: mail-promoter eval <fixture.json>");
      process.exit(1);
    }
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { items: LabelledItem[] };
    const modelsRaw = process.env.MAIL_PROMOTER_EVAL_MODELS ?? cfg.triageModel;
    const models = modelsRaw.split(",").map((m) => m.trim()).filter(Boolean);
    for (const model of models) {
      const chat = gatewayChat({ endpoint: cfg.llmEndpoint, model, apiKey: cfg.apiKey, usage: { service: "mail-promoter", action: "eval" } });
      const r = await evaluate(fixture.items, chat);
      console.log(`model=${model} precision=${r.precision.toFixed(3)} recall=${r.recall.toFixed(3)} tp=${r.tp} fp=${r.fp} tn=${r.tn} fn=${r.fn}`);
    }
    state.close();
    store.close();
    return;
  } else {
    console.log("usage: mail-promoter <backfill|rescan|migrate-thread-notes|sync-attachments|status|eval>");
    process.exit(1);
  }
  state.close();
  store.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
