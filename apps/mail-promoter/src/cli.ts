#!/usr/bin/env -S node --import tsx
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Store } from "../../mail-mirror/src/store.ts";
import { dbPath } from "../../mail-mirror/src/paths.ts";
import { LlmWikiApiClient } from "../../llm-wiki/mcp-server/src/api-client.ts";
import { PromoteState } from "./state.ts";
import { stateDbPath } from "./paths.ts";
import { loadConfig } from "./config.ts";
import { gatewayChat } from "./llm.ts";
import { runBatch, type RunDeps } from "./run.ts";
import { evaluate, type LabelledItem } from "./eval.ts";

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const cfg = loadConfig();
  const store = Store.openReadonly(dbPath());
  const state = PromoteState.open(stateDbPath());
  const wiki = new LlmWikiApiClient({ baseUrl: process.env.LLM_WIKI_API_BASE_URL });
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
    store, state, wiki,
    chat: gatewayChat({ endpoint: cfg.llmEndpoint, model: cfg.triageModel, apiKey: cfg.apiKey }),
    roleOf: (a, m) => store.roleForMailbox(a, m),
    accountLabelOf: (a) => (store.raw.prepare("SELECT emails FROM accounts WHERE uuid=?").get(a) as { emails: string } | undefined)?.emails ?? a,
    userAddrs,
    model: cfg.triageModel,
  };
  if (cmd === "backfill") {
    // Usage: mail-promoter backfill [limit]   (concurrency via MAIL_PROMOTER_CONCURRENCY, default 10)
    const limit = process.argv[3] ? Number(process.argv[3]) : undefined;
    const concurrency = Number(process.env.MAIL_PROMOTER_CONCURRENCY ?? 10);
    console.log(`promote backfill: limit=${limit ?? "all"} concurrency=${concurrency} model=${cfg.triageModel}`);
    const t = await runBatch(deps, { limit, concurrency });
    console.log(`promote backfill: promoted ${t.promoted}, skipped ${t.skipped}, filtered ${t.filtered}, deferred ${t.deferred}`);
    if (t.promoted > 0) {
      console.log("rescan: indicizzazione finale di tutte le note in un'unica passata...");
      try { await wiki.rescan("current"); console.log("rescan: completato"); }
      catch (e) { console.error(`rescan finale fallito (rilancia 'mail-promoter rescan'): ${(e as Error).message}`); }
    }
  } else if (cmd === "rescan") {
    console.log("rescan: indicizzazione di tutte le note nel progetto corrente...");
    await wiki.rescan("current");
    console.log("rescan: completato");
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
      const chat = gatewayChat({ endpoint: cfg.llmEndpoint, model, apiKey: cfg.apiKey });
      const r = await evaluate(fixture.items, chat);
      console.log(`model=${model} precision=${r.precision.toFixed(3)} recall=${r.recall.toFixed(3)} tp=${r.tp} fp=${r.fp} tn=${r.tn} fn=${r.fn}`);
    }
    state.close();
    store.close();
    return;
  } else {
    console.log("usage: mail-promoter <backfill|rescan|status|eval>");
    process.exit(1);
  }
  state.close();
  store.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
