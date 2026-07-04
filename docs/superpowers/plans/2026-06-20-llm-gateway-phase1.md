# LLM Gateway — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a single OpenAI-compatible LLM gateway (LiteLLM) with a `local-*` tier (Ollama chat + bge-m3 embeddings) and an `api-*` tier (OpenRouter free models with model/key rotation), provide a lenient JSON extractor for free-model output, and repoint mail-mirror + llm-wiki at the gateway.

**Architecture:** A new `apps/llm-gateway` package holds the LiteLLM proxy config (model_list + router resilience), a pure `extract-json` utility, env/README docs, and a smoke harness. Phase 1 ships no custom long-running service — LiteLLM is the only process; the `sub-*` Agent-SDK adapter is Phase 2. Existing services repoint by changing only their endpoint base URL (they are already endpoint-agnostic).

**Tech Stack:** LiteLLM (Python proxy), TypeScript (ESM, `tsx`, `node:test`), Ollama, OpenRouter.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-20-llm-gateway-design.md`.
- Three tiers are a NAMING CONVENTION: `local-*` (Ollama/LM Studio), `api-*` (OpenRouter free), `sub-*` (Phase 2). Concrete model IDs are CONFIGURATION (placeholders here, chosen later) — do not hardcode a model choice into code.
- `api-*` resilience (model rotation, API-key-pool rotation, backoff/cooldown) is provided by LiteLLM's native router via config — NOT hand-rolled. Proxy fallback is OUT OF SCOPE.
- Do NOT change the LOGIC of `apps/mail-mirror`, `apps/llm-wiki`, or `packages/embedding` — only their endpoint base URL (env). The wiki embedding test gate (90/90) must stay green and is NOT pointed at the gateway in tests (runtime config only).
- The Phase 2 `sub-*` adapter process must run WITHOUT `ANTHROPIC_API_KEY` — not in scope here, but do not add anything that sets it.
- Tests: from `apps/llm-gateway`, `node --import tsx --test "test/**/*.test.ts"`. Keep `tsc --noEmit` clean.
- Workspace: this is an npm-workspaces monorepo (`apps/*`); follow the existing package shape (see `apps/mail-mirror/package.json`).

---

### Task 1: Package scaffold + `extract-json` utility

**Files:**
- Create: `apps/llm-gateway/package.json`
- Create: `apps/llm-gateway/tsconfig.json`
- Create: `apps/llm-gateway/src/extract-json.ts`
- Test: `apps/llm-gateway/test/extract-json.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `extractJson(text: string): unknown` — strips ```` ```json ```` / ```` ``` ```` fences and single backticks, normalizes curly quotes (`“”‘’` → `"'`), removes zero-width/BOM chars, finds the first `{…}` or `[…]` (DOTALL, non-greedy), and `JSON.parse`s it. Throws `Error` when no JSON is found or parsing fails. Non-string input throws `TypeError`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/llm-gateway/test/extract-json.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJson } from "../src/extract-json.ts";

test("parses a bare JSON object", () => {
  assert.deepEqual(extractJson('{"a": 1, "b": "x"}'), { a: 1, b: "x" });
});

test("strips a ```json fence and surrounding prose", () => {
  const s = 'Sure! Here is the result:\n```json\n{"role": "drafts"}\n```\nLet me know.';
  assert.deepEqual(extractJson(s), { role: "drafts" });
});

test("normalizes curly quotes and parses", () => {
  assert.deepEqual(extractJson('{“key”: “value”}'), { key: "value" });
});

test("extracts the first array", () => {
  assert.deepEqual(extractJson('noise [1, 2, 3] trailing'), [1, 2, 3]);
});

test("strips zero-width / BOM chars", () => {
  assert.deepEqual(extractJson('﻿{"a":​1}'), { a: 1 });
});

test("throws when there is no JSON", () => {
  assert.throws(() => extractJson("just prose, no json here"), /no JSON/i);
});

test("throws TypeError on non-string input", () => {
  // @ts-expect-error intentional wrong type
  assert.throws(() => extractJson(42), TypeError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/llm-gateway && node --import tsx --test test/extract-json.test.ts`
Expected: FAIL (module `extract-json.ts` not found).

- [ ] **Step 3: Implement the package scaffold + util**

`apps/llm-gateway/package.json`:

```json
{
  "name": "@steward/llm-gateway",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test \"test/**/*.test.ts\""
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.5.0"
  }
}
```

`apps/llm-gateway/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

`apps/llm-gateway/src/extract-json.ts`:

```ts
/**
 * Lenient JSON extraction for free-model output. Free `api-*` models often wrap
 * JSON in code fences or prose and use curly quotes, so structured-output mode
 * is unreliable; callers asking for JSON pass the model's text through here.
 */
export function extractJson(text: string): unknown {
  if (typeof text !== "string") throw new TypeError("extractJson expects a string");
  let s = text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/`/g, "")
    .replace(/[​-‍﻿]/g, "");
  const m = /(\{[\s\S]*?\}|\[[\s\S]*?\])/.exec(s);
  if (!m) throw new Error("extractJson: no JSON object or array found");
  try {
    return JSON.parse(m[0].trim());
  } catch (e) {
    throw new Error(`extractJson: parse failed for ${JSON.stringify(m[0].slice(0, 120))}: ${(e as Error).message}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/llm-gateway && node --import tsx --test test/extract-json.test.ts && npx tsc --noEmit`
Expected: PASS (7 tests); tsc clean. (Run `npm install` at the repo root first if `tsx` is not yet linked into the new workspace.)

- [ ] **Step 5: Commit**

```bash
git add apps/llm-gateway/package.json apps/llm-gateway/tsconfig.json apps/llm-gateway/src/extract-json.ts apps/llm-gateway/test/extract-json.test.ts
git commit -m "feat(llm-gateway): scaffold + lenient extractJson util"
```

---

### Task 2: LiteLLM config + env + README (with repoint instructions)

**Files:**
- Create: `apps/llm-gateway/litellm.config.yaml`
- Create: `apps/llm-gateway/.env.example`
- Create: `apps/llm-gateway/README.md`
- Create: `apps/llm-gateway/test/config-shape.test.ts`

**Interfaces:**
- Consumes: nothing (config + docs).
- Produces: a LiteLLM `model_list` exposing the model-group names `local-chat`, `local-embed`, `api-default`, `api-alt1`, `api-alt2`, with `api-default` fallbacks configured, plus a README documenting the gateway base URL (`http://127.0.0.1:4000`) and the env each consuming service must set to repoint.

- [ ] **Step 1: Write the failing test (config-shape guard)**

```ts
// apps/llm-gateway/test/config-shape.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const yaml = readFileSync(new URL("../litellm.config.yaml", import.meta.url), "utf8");

test("config declares the required model-group names", () => {
  for (const name of ["local-chat", "local-embed", "api-default", "api-alt1", "api-alt2"]) {
    assert.ok(new RegExp(`model_name:\\s*${name}\\b`).test(yaml), `missing model_name: ${name}`);
  }
});

test("api tier rotates keys and falls back across models", () => {
  // at least two api-default deployments (key-pool rotation)
  const apiDefaults = (yaml.match(/model_name:\s*api-default\b/g) ?? []).length;
  assert.ok(apiDefaults >= 2, "expected >=2 api-default deployments for key rotation");
  // a fallbacks mapping from api-default to the alt models
  assert.match(yaml, /fallbacks:/);
  assert.match(yaml, /api-default[\s\S]*api-alt1/);
});

test("api keys and retries come from config, not hardcoded secrets", () => {
  assert.match(yaml, /os\.environ\/OPENROUTER_API_KEY_1/);
  assert.match(yaml, /num_retries:/);
  assert.match(yaml, /cooldown_time:/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/llm-gateway && node --import tsx --test test/config-shape.test.ts`
Expected: FAIL (`litellm.config.yaml` not found).

- [ ] **Step 3: Write the config, env example, and README**

`apps/llm-gateway/litellm.config.yaml` (model IDs are placeholders — chosen later per spec Key Decision 4; the structure is what matters):

```yaml
# LiteLLM gateway. Run: litellm --config litellm.config.yaml --port 4000
# Tiers: local-* (Ollama), api-* (OpenRouter free, with rotation), sub-* (Phase 2).
model_list:
  # --- local tier (Ollama) ---
  - model_name: local-chat
    litellm_params:
      model: ollama/llama3.2            # placeholder local chat model
      api_base: http://127.0.0.1:11434
  - model_name: local-embed
    litellm_params:
      model: ollama/bge-m3             # embeddings (matches the mail/wiki dim)
      api_base: http://127.0.0.1:11434

  # --- api tier (OpenRouter free) ---
  # Key-pool rotation: one deployment per API key under the SAME model_name.
  - model_name: api-default
    litellm_params:
      model: openrouter/nvidia/nemotron-3-super-120b-a12b:free   # placeholder
      api_key: os.environ/OPENROUTER_API_KEY_1
  - model_name: api-default
    litellm_params:
      model: openrouter/nvidia/nemotron-3-super-120b-a12b:free
      api_key: os.environ/OPENROUTER_API_KEY_2
  # Fallback models (different free models), each across the key pool.
  - model_name: api-alt1
    litellm_params:
      model: openrouter/meta-llama/llama-3.3-70b-instruct:free    # placeholder
      api_key: os.environ/OPENROUTER_API_KEY_1
  - model_name: api-alt1
    litellm_params:
      model: openrouter/meta-llama/llama-3.3-70b-instruct:free
      api_key: os.environ/OPENROUTER_API_KEY_2
  - model_name: api-alt2
    litellm_params:
      model: openrouter/google/gemma-3-27b-it:free               # placeholder
      api_key: os.environ/OPENROUTER_API_KEY_1
  - model_name: api-alt2
    litellm_params:
      model: openrouter/google/gemma-3-27b-it:free
      api_key: os.environ/OPENROUTER_API_KEY_2

litellm_settings:
  num_retries: 3
  request_timeout: 60
  # Rotate across free models on failure (rate-limit / 5xx / timeout).
  fallbacks:
    - api-default: ["api-alt1", "api-alt2"]
  context_window_fallbacks:
    - api-default: ["api-alt1", "api-alt2"]

router_settings:
  routing_strategy: simple-shuffle   # spread load across the key pool
  num_retries: 3
  retry_after: 5
  cooldown_time: 30                  # park a deployment that just failed
  allowed_fails: 2
```

`apps/llm-gateway/.env.example`:

```bash
# OpenRouter free-tier keys (one or more; one LiteLLM deployment per key).
OPENROUTER_API_KEY_1=
OPENROUTER_API_KEY_2=

# --- Services repoint here (Phase 1). The gateway runs on :4000. ---
# mail-mirror embeddings + classifier:
#   MAIL_EMBED_ENDPOINT=http://127.0.0.1:4000/v1/embeddings
#   MAIL_EMBED_MODEL=local-embed
#   MAIL_CLASSIFY_ENDPOINT=http://127.0.0.1:4000/v1/chat/completions
#   MAIL_CLASSIFY_MODEL=api-default
# llm-wiki embeddings: point its embedding endpoint at
#   http://127.0.0.1:4000/v1/embeddings  (model: local-embed)
```

`apps/llm-gateway/README.md`:

```markdown
# LLM Gateway

One OpenAI-compatible endpoint for every service. Tiers, selected via `model`:
`local-*` (Ollama), `api-*` (OpenRouter free, with model+key rotation), `sub-*` (Phase 2).

## Run

1. Ollama running locally with the models pulled (`ollama pull bge-m3`, a chat model).
2. `pip install "litellm[proxy]"`
3. Copy `.env.example` to `.env`, set `OPENROUTER_API_KEY_1` (+ `_2` …).
4. `set -a; source .env; set +a; litellm --config litellm.config.yaml --port 4000`

Gateway base URL: `http://127.0.0.1:4000` (`/v1/chat/completions`, `/v1/embeddings`).

## Repoint services (Phase 1)

These are already endpoint-agnostic — change only the env (no code):

- mail-mirror: `MAIL_EMBED_ENDPOINT=http://127.0.0.1:4000/v1/embeddings`,
  `MAIL_EMBED_MODEL=local-embed`, `MAIL_CLASSIFY_ENDPOINT=http://127.0.0.1:4000/v1/chat/completions`,
  `MAIL_CLASSIFY_MODEL=api-default`.
- llm-wiki: point its embedding endpoint at `http://127.0.0.1:4000/v1/embeddings` (model `local-embed`).

## Resilience (api tier)

LiteLLM's router handles it (configured in `litellm.config.yaml`): key-pool
rotation (deployments sharing a `model_name`), model fallback (`fallbacks`),
retries + cooldown. Proxy fallback is out of scope.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/llm-gateway && node --import tsx --test test/config-shape.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/llm-gateway/litellm.config.yaml apps/llm-gateway/.env.example apps/llm-gateway/README.md apps/llm-gateway/test/config-shape.test.ts
git commit -m "feat(llm-gateway): LiteLLM config (local + OpenRouter api tiers) + repoint docs"
```

---

### Task 3: Live smoke harness

**Files:**
- Create: `apps/llm-gateway/scripts/smoke.mts`
- Modify: `apps/llm-gateway/README.md` (add the smoke command)

**Interfaces:**
- Consumes: a running gateway (`GATEWAY_URL`, default `http://127.0.0.1:4000`).
- Produces: a script that does one `local-embed` embeddings round-trip and one `api-default` chat round-trip (the chat reply is passed through `extractJson` when it asks for JSON), printing PASS/FAIL per tier. Exit non-zero on failure. This is an INTEGRATION smoke run by a human with the env up — not part of `npm test`.

- [ ] **Step 1: Write the smoke script**

```ts
// apps/llm-gateway/scripts/smoke.mts
// Live smoke of the running gateway. Needs LiteLLM up + Ollama up + OpenRouter keys.
// Run: node --import tsx scripts/smoke.mts
import { extractJson } from "../src/extract-json.ts";

const BASE = process.env.GATEWAY_URL ?? "http://127.0.0.1:4000";
let failed = false;

async function embed(): Promise<void> {
  const res = await fetch(`${BASE}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "local-embed", input: "hello world" }),
  });
  const data = (await res.json()) as { data?: { embedding: number[] }[] };
  const dim = data.data?.[0]?.embedding?.length ?? 0;
  if (res.ok && dim > 0) console.log(`[local-embed] OK — ${dim}-dim vector`);
  else { console.error(`[local-embed] FAIL — status ${res.status}`); failed = true; }
}

async function chat(): Promise<void> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "api-default",
      messages: [{ role: "user", content: 'Reply with ONLY this JSON: {"ok": true}' }],
    }),
  });
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content ?? "";
  try {
    const parsed = extractJson(text) as { ok?: boolean };
    if (res.ok && parsed.ok === true) console.log("[api-default] OK — JSON round-trip via OpenRouter");
    else { console.error(`[api-default] FAIL — status ${res.status}, body: ${text.slice(0, 120)}`); failed = true; }
  } catch (e) {
    console.error(`[api-default] FAIL — could not extract JSON: ${(e as Error).message}; body: ${text.slice(0, 120)}`);
    failed = true;
  }
}

await embed();
await chat();
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Add the smoke command to the README**

Append to `apps/llm-gateway/README.md`:

```markdown
## Smoke test (live)

With the gateway running:

    node --import tsx scripts/smoke.mts

Checks a `local-embed` embeddings call and an `api-default` OpenRouter chat
(JSON round-trip via `extractJson`). Exits non-zero on failure.
```

- [ ] **Step 3: Typecheck the script**

Run: `cd apps/llm-gateway && npx tsc --noEmit`
Expected: clean (the script imports `extractJson` and uses global `fetch`).

- [ ] **Step 4: Commit**

```bash
git add apps/llm-gateway/scripts/smoke.mts apps/llm-gateway/README.md
git commit -m "feat(llm-gateway): live smoke harness (local-embed + api-default)"
```

- [ ] **Step 5 (manual, env-dependent): run the live smoke**

With Ollama up, `OPENROUTER_API_KEY_1` set, and LiteLLM running on :4000:
Run: `node --import tsx scripts/smoke.mts`
Expected: `[local-embed] OK …` and `[api-default] OK …`, exit 0. (If OpenRouter free models are all rate-limited at that moment, the router exhausts fallbacks and the api line FAILs — re-run later; this validates the path, not OpenRouter's uptime.)

---

## Self-Review

**Spec coverage (Phase 1 of the gateway spec):**
- LiteLLM proxy, OpenAI-compatible, `local-*` + `api-*` from the start → Task 2 (config). ✅
- `api-*` = OpenRouter free with router resilience (key pool, model fallback, retries/cooldown), proxy out of scope → Task 2 config + `config-shape` test asserting the structure. ✅
- `extract-json` lenient extractor → Task 1. ✅
- Repoint mail-mirror + llm-wiki by base URL only (no logic change) → Task 2 (.env.example + README). ✅
- Parity: wiki gate untouched (gateway not used in its tests) → no task touches `apps/llm-wiki`/`packages/embedding`; constraint honored. ✅
- Embeddings fronted (`local-embed`) → Task 2 config + Task 3 smoke. ✅
- Model IDs are configuration (placeholders) → comments in Task 2; no model hardcoded in code. ✅
- `sub-*` is Phase 2 (not here) → out of scope; no `ANTHROPIC_API_KEY` introduced. ✅

**Placeholder scan:** The model IDs in the YAML are intentional, spec-sanctioned configuration placeholders (Key Decision 4), each labelled `# placeholder`; they are not plan-failure TODOs. No "implement later"/"add error handling"/vague steps. ✅

**Type consistency:** `extractJson(text: string): unknown` defined in Task 1 is consumed in Task 3's smoke with the same signature. Model-group names (`local-chat`, `local-embed`, `api-default`, `api-alt1`, `api-alt2`) are consistent between the config (Task 2), the config-shape test (Task 2), the `.env.example`, and the smoke (`local-embed`, `api-default`, Task 3). ✅

**Note:** Phase 2 (the `sub-*` Agent-SDK adapter) is a separate plan, authored after Phase 1 lands.
