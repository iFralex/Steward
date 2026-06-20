# LLM Gateway — Phase 2 Implementation Plan (`sub-*` Agent-SDK adapter)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Claude on the **subscription** as `sub-*` models behind the gateway, via a small OpenAI-compatible HTTP adapter that wraps a headless, no-tools, single-shot Claude Agent SDK `query()`.

**Architecture:** A pure core (`adapter-core.ts`) translates an OpenAI chat-completion request into a prompt + system prompt, runs an injected `runQuery`, accumulates the assistant text, and returns a minimal OpenAI `chat.completion`. A thin `node:http` server (`adapter.ts`) wires the core to the real SDK `query()` (with a deny-all PreToolUse hook and `settingSources: []`), exposes `/v1/chat/completions` + `/v1/models`, and refuses to start if `ANTHROPIC_API_KEY` is set (so it bills the subscription, not the API). LiteLLM registers the adapter as an `openai/`-compatible backend → `sub-*`.

**Tech Stack:** TypeScript (ESM, `tsx`, `node:test`, `node:http`), `@anthropic-ai/claude-agent-sdk`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-20-llm-gateway-design.md` (Phase 2 / the `sub-*` tier).
- The adapter process MUST run WITHOUT `ANTHROPIC_API_KEY` (else it bills the API instead of the subscription). Assert at startup with a clear error; refuse to start otherwise. (Mirrors the host: `apps/host/src/config.ts` comments that the host runs on the subscription with `ANTHROPIC_API_KEY` unset.)
- The adapter is **low volume only** — single-shot, no agentic tool loop. Tools are blocked by a deny-all `PreToolUse` hook AND no `mcpServers`; `settingSources: []` isolates it from the user's Claude Code settings.
- `sub-*` model IDs are CONFIGURATION (placeholder; chosen later) — do not hardcode a Claude model into logic. The Agent SDK `model` option is omitted by default (subscription default) unless `SUB_MODEL` env is set.
- Reuse the SDK's `query()` — do NOT hand-roll an agent loop. Pattern is `apps/host/src/core/agent-runner.ts`; hook shape is `apps/host/src/core/permission-gate.ts`.
- Do not change any other package. Build on the existing `apps/llm-gateway` package from Phase 1.
- Tests: from `apps/llm-gateway`, `node --import tsx --test "test/**/*.test.ts"`. Keep `tsc --noEmit` clean.

## SDK reference (verified in `apps/host`)

- `import { query, type Options } from "@anthropic-ai/claude-agent-sdk"`.
- `for await (const message of query({ prompt, options }))`; an assistant message has `message.type === "assistant"` and `message.message.content` is an array of blocks; a text block has `block.type === "text"` and `block.text: string`.
- A deny PreToolUse hook returns `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: string } }`. Hook type is `HookCallback`; its input has `input.hook_event_name`.
- `Options` fields used here: `model?`, `systemPrompt?`, `settingSources`, `permissionMode`, `hooks`.

---

### Task 1: `adapter-core` — request translation + completion assembly (pure)

**Files:**
- Modify: `apps/llm-gateway/package.json` (add `@anthropic-ai/claude-agent-sdk` dependency)
- Create: `apps/llm-gateway/src/adapter-core.ts`
- Test: `apps/llm-gateway/test/adapter-core.test.ts`

**Interfaces:**
- Consumes: nothing (an injected `runQuery`).
- Produces:
  - type `ChatMessage = { role: "system" | "user" | "assistant"; content: string }`.
  - type `OpenAIChatRequest = { model?: string; messages: ChatMessage[] }`.
  - `splitPrompt(messages: ChatMessage[]): { systemPrompt: string | undefined; prompt: string }` — system messages joined into `systemPrompt` (undefined if none); non-system messages rendered into a single `prompt` string (a single user message passes through as-is; multiple turns render as `role: content` lines).
  - `type RunQuery = (args: { prompt: string; systemPrompt?: string; model?: string }) => AsyncIterable<unknown>` — the injected SDK seam.
  - `collectAssistantText(messages: AsyncIterable<unknown>): Promise<string>` — concatenates the `.text` of every `text` block of every `assistant` message.
  - `handleChatCompletion(body: OpenAIChatRequest, runQuery: RunQuery, now?: () => number): Promise<object>` — returns a minimal OpenAI `chat.completion` object (`id`, `object: "chat.completion"`, `created`, `model`, `choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }]`).

- [ ] **Step 1: Write the failing test**

```ts
// apps/llm-gateway/test/adapter-core.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitPrompt, collectAssistantText, handleChatCompletion, type ChatMessage } from "../src/adapter-core.ts";

async function* fakeQuery(text: string): AsyncIterable<unknown> {
  yield { type: "system", session_id: "s1" };
  yield { type: "assistant", message: { content: [{ type: "text", text }] } };
  yield { type: "assistant", message: { content: [{ type: "tool_use", name: "x", input: {} }] } };
}

test("splitPrompt separates system from a single user message", () => {
  const msgs: ChatMessage[] = [
    { role: "system", content: "You classify." },
    { role: "user", content: "Is this junk?" },
  ];
  const r = splitPrompt(msgs);
  assert.equal(r.systemPrompt, "You classify.");
  assert.equal(r.prompt, "Is this junk?");
});

test("splitPrompt renders multiple turns and has no systemPrompt when absent", () => {
  const r = splitPrompt([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "bye" },
  ]);
  assert.equal(r.systemPrompt, undefined);
  assert.equal(r.prompt, "user: hi\n\nassistant: hello\n\nuser: bye");
});

test("collectAssistantText concatenates only text blocks of assistant messages", async () => {
  assert.equal(await collectAssistantText(fakeQuery("hello world")), "hello world");
});

test("handleChatCompletion returns an OpenAI chat.completion with the assistant text", async () => {
  const runQuery = (_a: { prompt: string }) => fakeQuery('{"ok":true}');
  const res = (await handleChatCompletion(
    { model: "claude-opus-sub", messages: [{ role: "user", content: "go" }] },
    runQuery,
    () => 1000,
  )) as any;
  assert.equal(res.object, "chat.completion");
  assert.equal(res.created, 1);
  assert.equal(res.model, "claude-opus-sub");
  assert.equal(res.choices[0].message.role, "assistant");
  assert.equal(res.choices[0].message.content, '{"ok":true}');
  assert.equal(res.choices[0].finish_reason, "stop");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/llm-gateway && node --import tsx --test test/adapter-core.test.ts`
Expected: FAIL (module `adapter-core.ts` not found).

- [ ] **Step 3: Add the dependency and implement the core**

In `apps/llm-gateway/package.json`, add a `dependencies` block (the package had none in Phase 1):

```json
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.179"
  },
```

Then run `npm install` at the repo root so the dependency resolves.

`apps/llm-gateway/src/adapter-core.ts`:

```ts
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type OpenAIChatRequest = { model?: string; messages: ChatMessage[] };
export type RunQuery = (args: { prompt: string; systemPrompt?: string; model?: string }) => AsyncIterable<unknown>;

/** Split OpenAI messages into the Agent SDK's systemPrompt + a single prompt string. */
export function splitPrompt(messages: ChatMessage[]): { systemPrompt: string | undefined; prompt: string } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  const prompt = rest.length === 1 ? rest[0].content : rest.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  return { systemPrompt: system.length ? system : undefined, prompt };
}

/** Concatenate the text of every text block of every assistant message in the stream. */
export async function collectAssistantText(messages: AsyncIterable<unknown>): Promise<string> {
  let out = "";
  for await (const m of messages) {
    const msg = m as { type?: string; message?: { content?: { type?: string; text?: string }[] } };
    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message!.content!) {
        if (block.type === "text" && typeof block.text === "string") out += block.text;
      }
    }
  }
  return out;
}

/** Run one OpenAI chat-completion request through the injected query and shape the response. */
export async function handleChatCompletion(
  body: OpenAIChatRequest,
  runQuery: RunQuery,
  now: () => number = Date.now,
): Promise<object> {
  const { systemPrompt, prompt } = splitPrompt(body.messages ?? []);
  const content = await collectAssistantText(runQuery({ prompt, systemPrompt, model: body.model }));
  const created = Math.floor(now() / 1000);
  return {
    id: `chatcmpl-sub-${now()}`,
    object: "chat.completion",
    created,
    model: body.model ?? "claude-sub",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/llm-gateway && node --import tsx --test test/adapter-core.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests); tsc clean. (If tsc errors on the SDK import, confirm `npm install` ran at the repo root.)

- [ ] **Step 5: Commit**

```bash
git add apps/llm-gateway/package.json apps/llm-gateway/src/adapter-core.ts apps/llm-gateway/test/adapter-core.test.ts
git commit -m "feat(llm-gateway): sub adapter core (OpenAI request -> Agent-SDK query)"
```

---

### Task 2: `adapter.ts` — HTTP server + real SDK wiring + startup guard

**Files:**
- Create: `apps/llm-gateway/src/adapter.ts`
- Test: `apps/llm-gateway/test/adapter-server.test.ts`

**Interfaces:**
- Consumes: Task 1's `handleChatCompletion`, `RunQuery`, `OpenAIChatRequest`.
- Produces:
  - `assertNoApiKey(env: NodeJS.ProcessEnv): void` — throws an `Error` if `ANTHROPIC_API_KEY` is set (non-empty).
  - `createAdapterServer(deps: { runQuery: RunQuery }): import("node:http").Server` — routes `POST /v1/chat/completions` → `handleChatCompletion`; `GET /v1/models` → `{ object: "list", data: [{ id: "claude-opus-sub", object: "model" }] }`; everything else → 404. On a handler error, responds `500` with `{ error: { message, type: "adapter_error" } }`.
  - `sdkRunQuery: RunQuery` — wraps the real `query()` with a deny-all `PreToolUse` hook, `settingSources: []`, `permissionMode: "default"`, optional `model` (from arg or `SUB_MODEL` env), and the `systemPrompt`.
  - A guarded entry: when run directly, `assertNoApiKey(process.env)` then `createAdapterServer({ runQuery: sdkRunQuery }).listen(PORT)` where `PORT = Number(process.env.SUB_ADAPTER_PORT ?? 4001)`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/llm-gateway/test/adapter-server.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNoApiKey, createAdapterServer } from "../src/adapter.ts";
import type { AddressInfo } from "node:net";

async function* fake(): AsyncIterable<unknown> {
  yield { type: "assistant", message: { content: [{ type: "text", text: "pong" }] } };
}

test("assertNoApiKey throws when ANTHROPIC_API_KEY is set", () => {
  assert.throws(() => assertNoApiKey({ ANTHROPIC_API_KEY: "sk-x" } as NodeJS.ProcessEnv), /ANTHROPIC_API_KEY/);
  assert.doesNotThrow(() => assertNoApiKey({} as NodeJS.ProcessEnv));
});

test("server answers /v1/chat/completions with an OpenAI completion", async () => {
  const server = createAdapterServer({ runQuery: () => fake() });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-sub", messages: [{ role: "user", content: "ping" }] }),
  });
  const body = (await res.json()) as any;
  assert.equal(res.status, 200);
  assert.equal(body.choices[0].message.content, "pong");
  await new Promise<void>((r) => server.close(() => r()));
});

test("server lists models at /v1/models", async () => {
  const server = createAdapterServer({ runQuery: () => fake() });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
  const body = (await res.json()) as any;
  assert.equal(body.object, "list");
  assert.ok(body.data.some((m: { id: string }) => m.id === "claude-opus-sub"));
  await new Promise<void>((r) => server.close(() => r()));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/llm-gateway && node --import tsx --test test/adapter-server.test.ts`
Expected: FAIL (module `adapter.ts` not found).

- [ ] **Step 3: Implement the server**

`apps/llm-gateway/src/adapter.ts`:

```ts
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { query, type Options, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { handleChatCompletion, type OpenAIChatRequest, type RunQuery } from "./adapter-core.ts";

/** Refuse to run if ANTHROPIC_API_KEY is set — the adapter must bill the subscription, not the API. */
export function assertNoApiKey(env: NodeJS.ProcessEnv): void {
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim()) {
    throw new Error(
      "ANTHROPIC_API_KEY is set — the sub-* adapter must run WITHOUT it so it uses the Claude subscription. Unset it and restart.",
    );
  }
}

/** Block every tool — this adapter is a single-shot text completion, not an agent. */
const denyAll: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Tools are disabled in the gateway sub-* adapter (text completion only).",
    },
  };
};

/** Wrap the real SDK query() headlessly (no tools, no inherited settings, single turn). */
export const sdkRunQuery: RunQuery = ({ prompt, systemPrompt, model }) => {
  const options: Options = {
    settingSources: [],
    permissionMode: "default",
    hooks: { PreToolUse: [{ hooks: [denyAll] }] },
    ...(systemPrompt ? { systemPrompt } : {}),
    ...((model && model !== "claude-opus-sub") || process.env.SUB_MODEL
      ? { model: process.env.SUB_MODEL ?? model }
      : {}),
  };
  return query({ prompt, options });
};

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function createAdapterServer(deps: { runQuery: RunQuery }): Server {
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "claude-opus-sub", object: "model" }] }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const body = JSON.parse(await readBody(req)) as OpenAIChatRequest;
        const out = await handleChatCompletion(body, deps.runQuery);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found", type: "adapter_error" } }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err), type: "adapter_error" } }));
    }
  });
}

// Direct-run entry (guarded so importing this file in tests does not start a server).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertNoApiKey(process.env);
  const port = Number(process.env.SUB_ADAPTER_PORT ?? 4001);
  createAdapterServer({ runQuery: sdkRunQuery }).listen(port, () => {
    console.log(`sub-* adapter listening on http://127.0.0.1:${port}/v1 (subscription auth)`);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/llm-gateway && node --import tsx --test test/adapter-server.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests); tsc clean. (If the SDK does not export `HookCallback`, import it as `type { HookCallback }` from the SDK — it is exported and used in `apps/host/src/core/permission-gate.ts`.)

- [ ] **Step 5: Commit**

```bash
git add apps/llm-gateway/src/adapter.ts apps/llm-gateway/test/adapter-server.test.ts
git commit -m "feat(llm-gateway): sub-* adapter HTTP server + subscription guard"
```

---

### Task 3: Register `sub-*` in LiteLLM + README run steps

**Files:**
- Modify: `apps/llm-gateway/litellm.config.yaml`
- Modify: `apps/llm-gateway/README.md`
- Modify: `apps/llm-gateway/test/config-shape.test.ts`

**Interfaces:**
- Consumes: the adapter at `http://127.0.0.1:4001/v1` (Task 2).
- Produces: a `sub-opus` model group in the LiteLLM config pointing at the adapter via the `openai/` provider; README run steps for the adapter + LiteLLM; a config-shape assertion that `sub-opus` exists and targets the adapter base.

- [ ] **Step 1: Write the failing test**

Add to `apps/llm-gateway/test/config-shape.test.ts`:

```ts
test("config registers the sub-* adapter tier", () => {
  assert.match(yaml, /model_name:\s*sub-opus\b/);
  assert.match(yaml, /api_base:\s*http:\/\/127\.0\.0\.1:4001\/v1/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/llm-gateway && node --import tsx --test test/config-shape.test.ts`
Expected: FAIL (`sub-opus` not in the YAML).

- [ ] **Step 3: Add the sub tier and document it**

Append to the `model_list:` in `apps/llm-gateway/litellm.config.yaml`:

```yaml
  # --- sub tier (Claude on the subscription, via the Agent-SDK adapter) ---
  # The adapter (apps/llm-gateway/src/adapter.ts) runs WITHOUT ANTHROPIC_API_KEY.
  # Low volume only. api_key is ignored by the adapter (a placeholder satisfies LiteLLM).
  - model_name: sub-opus
    litellm_params:
      model: openai/claude-opus-sub
      api_base: http://127.0.0.1:4001/v1
      api_key: "sub-adapter-ignored"
```

Append to `apps/llm-gateway/README.md` (a new section before "## Smoke test"):

```markdown
## `sub-*` tier (Claude on the subscription)

Low-volume only. Start the adapter in a process WITHOUT `ANTHROPIC_API_KEY`
(so it uses the Claude subscription, not the API):

    cd apps/llm-gateway
    env -u ANTHROPIC_API_KEY node --import tsx src/adapter.ts   # listens on :4001

Then LiteLLM routes `model: sub-opus` to it. Optionally set `SUB_MODEL` to pin a
specific Claude model; otherwise the subscription default applies. The adapter
refuses to start if `ANTHROPIC_API_KEY` is set.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/llm-gateway && node --import tsx --test "test/**/*.test.ts" && npx tsc --noEmit`
Expected: PASS (all package tests, incl. the new sub assertions); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/llm-gateway/litellm.config.yaml apps/llm-gateway/README.md apps/llm-gateway/test/config-shape.test.ts
git commit -m "feat(llm-gateway): register sub-opus tier + adapter run docs"
```

- [ ] **Step 6 (manual, env-dependent): validate end-to-end on the subscription**

In a shell WITHOUT `ANTHROPIC_API_KEY`, with the Claude subscription logged in:
1. `env -u ANTHROPIC_API_KEY node --import tsx src/adapter.ts` (adapter on :4001).
2. `curl -s http://127.0.0.1:4001/v1/chat/completions -H 'content-type: application/json' -d '{"model":"claude-opus-sub","messages":[{"role":"user","content":"Reply with the single word: pong"}]}'`
Expected: a JSON `chat.completion` whose `choices[0].message.content` contains `pong`, billed to the subscription (no API spend).

---

## Self-Review

**Spec coverage (Phase 2 / `sub-*` tier):**
- Adapter wraps headless single-shot `query()` (no tools, `settingSources: []`) → Task 2 (`sdkRunQuery` + `denyAll`). ✅
- OpenAI-compatible `/v1/chat/completions` + `/v1/models` → Task 1 (shape) + Task 2 (server). ✅
- Refuses to run with `ANTHROPIC_API_KEY` (subscription, not API) → Task 2 (`assertNoApiKey` + guarded entry). ✅
- Registered in LiteLLM as `sub-*` → Task 3. ✅
- Low-volume only; model IDs configuration (no hardcoded Claude model; `SUB_MODEL` optional) → Task 2 options logic; documented in Task 3. ✅
- Reuse SDK `query()`, don't hand-roll → Task 2 imports `query`. ✅
- Error path returns OpenAI error shape → Task 2 (catch → 500 `adapter_error`). ✅

**Placeholder scan:** `claude-opus-sub`/`sub-opus`/`SUB_MODEL` are spec-sanctioned configuration names, not plan-failure TODOs. Every code step has complete code. ✅

**Type consistency:** `RunQuery`, `OpenAIChatRequest`, `ChatMessage`, `handleChatCompletion` defined in Task 1 and consumed verbatim in Task 2; `assertNoApiKey`/`createAdapterServer` defined in Task 2 and consumed in its test; the adapter `api_base` (`http://127.0.0.1:4001/v1`) in Task 3 matches the default `SUB_ADAPTER_PORT` 4001 in Task 2. ✅
