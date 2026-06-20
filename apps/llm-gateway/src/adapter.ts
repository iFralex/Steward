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
