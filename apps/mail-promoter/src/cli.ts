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
  const deps: RunDeps = {
    store, state, wiki,
    classifyChat: gatewayChat({ endpoint: cfg.llmEndpoint, model: cfg.classifyModel, apiKey: cfg.apiKey }),
    distillChat: gatewayChat({ endpoint: cfg.llmEndpoint, model: cfg.distillModel, apiKey: cfg.apiKey }),
    roleOf: (a, m) => store.roleForMailbox(a, m),
    accountLabelOf: (a) => (store.raw.prepare("SELECT emails FROM accounts WHERE uuid=?").get(a) as { emails: string } | undefined)?.emails ?? a,
    classifyModel: cfg.classifyModel,
    distillModel: cfg.distillModel,
  };
  if (cmd === "backfill") {
    const t = await runBatch(deps);
    console.log(`promote backfill: promoted ${t.promoted}, skipped ${t.skipped}, filtered ${t.filtered}, deferred ${t.deferred}`);
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
    const modelsRaw = process.env.MAIL_PROMOTER_EVAL_MODELS ?? cfg.classifyModel;
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
    console.log("usage: mail-promoter <backfill|status|eval>");
    process.exit(1);
  }
  state.close();
  store.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
