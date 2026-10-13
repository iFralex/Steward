#!/usr/bin/env node
/**
 * Offline Steward model replay.
 *
 * `catalog` reads Pi session JSONL files and builds privacy-local decision
 * points. `run` submits selected decision points to an OpenAI-compatible local
 * endpoint. It never executes a tool: tool calls are captured as model output.
 */
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { buildMcpBridge } from "../packages/mcp-bridge/src/index.ts";
import { loadConfig } from "../apps/host/src/config.ts";
import { buildAskUserTool } from "../apps/host/src/core/ask-user-tool.ts";
import { buildClipboardTool } from "../apps/host/src/core/clipboard-tool.ts";
import { buildWatchTools } from "../apps/host/src/core/watch-tools.ts";

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const chatsDir = process.env.CHATS_DIR ?? join(homedir(), "Library", "Application Support", "steward-chats");
const outputDir = option("output", ".local-evals/steward-qwen38");
const catalogPath = join(outputDir, "catalog.json");

if (command === "catalog") await catalog();
else if (command === "run") await run();
else {
  console.error("usage: node --import tsx tools/steward-local-model-eval.mjs catalog|run [options]");
  process.exitCode = 2;
}

async function catalog() {
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const config = loadConfig();
  const tools = await loadTools(config);
  const db = new Database(join(chatsDir, "chats.db"), { readonly: true, fileMustExist: true });
  const chats = db.prepare("SELECT id, title, session_file FROM chats WHERE session_file IS NOT NULL").all();
  db.close();
  const points = [];
  for (const chat of chats) {
    let entries;
    try {
      entries = readFileSync(chat.session_file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      continue;
    }
    const history = [];
    let userTurn = 0;
    let decision = 0;
    for (const entry of entries) {
      if (entry.type !== "message" || !entry.message) continue;
      const message = entry.message;
      if (message.role === "user") userTurn += 1;
      if (message.role === "assistant") {
        decision += 1;
        const responseModel = message.responseModel ?? message.model ?? "";
        if (responseModel === "deepseek-v4-flash") {
          const expected = assistantExpected(message);
          const usage = message.usage ?? {};
          const promptTokens = Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0);
          points.push({
            id: `${chat.id}:${entry.id}`,
            chatId: chat.id,
            session: basename(chat.session_file),
            entryId: entry.id,
            timestamp: entry.timestamp ?? message.timestamp ?? null,
            userTurn,
            decision,
            category: categoryFor(expected.toolCalls.map((call) => call.name)),
            promptTokens,
            outputTokens: Number(usage.output ?? 0),
            history: structuredClone(history),
            expected,
          });
        }
      }
      const converted = toOpenAiMessage(message);
      if (converted) history.push(converted);
    }
  }
  const summaries = points.map(summary);
  const report = {
    generatedAt: new Date().toISOString(),
    model: "deepseek-v4-flash",
    chats: chats.length,
    decisions: points.length,
    tools: tools.length,
    promptTokens: distribution(points.map((p) => p.promptTokens)),
    contextBuckets: bucketCounts(points),
    categories: countBy(points, (p) => p.category),
    candidates: stratifiedCandidates(summaries),
  };
  writeFileSync(catalogPath, JSON.stringify({ report, systemPrompt: config.systemPrompt, tools, points }, null, 2), { mode: 0o600 });
  writeFileSync(join(outputDir, "catalog-summary.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}

async function run() {
  const catalogData = JSON.parse(readFileSync(catalogPath, "utf8"));
  const baseUrl = option("base-url", "http://127.0.0.1:18123/v1").replace(/\/$/, "");
  const label = option("label", "local");
  const idsFile = option("ids", "");
  const limit = Number(option("limit", "12"));
  const maxHistoricalTokens = Number(option("max-historical-tokens", "12000"));
  const requestedIds = idsFile ? readFileSync(idsFile, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  const byId = new Map(catalogData.points.map((p) => [p.id, p]));
  let selected = requestedIds.length
    ? requestedIds.map((id) => byId.get(id)).filter(Boolean)
    : defaultSelection(catalogData.points, maxHistoricalTokens, limit);
  selected = selected.slice(0, limit);
  const results = [];
  for (const [index, point] of selected.entries()) {
    const historicalTime = point.timestamp ? new Date(point.timestamp).toISOString() : "unknown";
    const body = {
      model: option("model", "qwen3.8-local"),
      messages: [
        { role: "system", content: `${catalogData.systemPrompt}\n\nOffline evaluation only. Do not claim that tools were executed. Historical snapshot time: ${historicalTime}.` },
        ...point.history,
      ],
      tools: catalogData.tools,
      tool_choice: "auto",
      temperature: 0,
      max_tokens: Math.max(256, Math.min(1024, point.outputTokens * 2 + 128)),
      chat_template_kwargs: { enable_thinking: false },
    };
    const started = Date.now();
    let status = 0;
    let response;
    let error = null;
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10 * 60_000),
      });
      status = res.status;
      const text = await res.text();
      response = JSON.parse(text);
      if (!res.ok) error = response?.error?.message ?? `HTTP ${res.status}`;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const actual = response ? responseExpected(response) : { text: "", toolCalls: [] };
    const score = compare(point.expected, actual);
    results.push({
      id: point.id,
      category: point.category,
      historicalPromptTokens: point.promptTokens,
      expected: point.expected,
      actual,
      score,
      status,
      error,
      durationMs: Date.now() - started,
      usage: response?.usage ?? null,
      timings: response?.timings ?? null,
    });
    console.log(`[${index + 1}/${selected.length}] ${point.id} ${point.category} tools=${score.toolSequenceExact ? "exact" : "different"} ${error ?? "ok"}`);
  }
  const aggregate = aggregateResults(results);
  const artifact = { generatedAt: new Date().toISOString(), label, baseUrl, aggregate, results };
  const path = join(outputDir, `results-${safeLabel(label)}.json`);
  writeFileSync(path, JSON.stringify(artifact, null, 2), { mode: 0o600 });
  writeFileSync(join(outputDir, `summary-${safeLabel(label)}.json`), JSON.stringify({ generatedAt: artifact.generatedAt, label, aggregate, results: results.map(resultSummary) }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(aggregate, null, 2));
}

async function loadTools(config) {
  const bridge = await buildMcpBridge(config.mcpServers);
  try {
    const hostTools = [buildClipboardTool(), ...buildWatchTools("offline-eval"), buildAskUserTool(async () => "")];
    return [...bridge.tools, ...hostTools].map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? { type: "object", properties: {} } },
    }));
  } finally {
    await bridge.close();
  }
}

function assistantExpected(message) {
  const text = (message.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  const toolCalls = (message.content ?? []).filter((c) => c.type === "toolCall").map((c) => ({
    id: c.id,
    name: c.name,
    arguments: c.arguments ?? {},
  }));
  return { text, toolCalls };
}

function toOpenAiMessage(message) {
  if (message.role === "user") {
    return { role: "user", content: (message.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("") };
  }
  if (message.role === "assistant") {
    const expected = assistantExpected(message);
    return {
      role: "assistant",
      content: expected.text || null,
      ...(expected.toolCalls.length ? { tool_calls: expected.toolCalls.map((call) => ({
        id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })) } : {}),
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      name: message.toolName,
      content: (message.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join(""),
    };
  }
  return null;
}

function responseExpected(response) {
  const message = response?.choices?.[0]?.message ?? {};
  return {
    text: typeof message.content === "string" ? message.content : "",
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => ({
      id: call.id,
      name: call.function?.name ?? "",
      arguments: parseArguments(call.function?.arguments),
    })) : [],
  };
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value ?? "{}"); } catch { return { __invalidJson: String(value ?? "") }; }
}

function compare(expected, actual) {
  const expectedNames = expected.toolCalls.map((c) => c.name);
  const actualNames = actual.toolCalls.map((c) => c.name);
  const expectedSet = new Set(expectedNames);
  const actualSet = new Set(actualNames);
  const intersection = [...expectedSet].filter((name) => actualSet.has(name)).length;
  const precision = actualSet.size ? intersection / actualSet.size : expectedSet.size ? 0 : 1;
  const recall = expectedSet.size ? intersection / expectedSet.size : actualSet.size ? 0 : 1;
  const argScores = [];
  for (const expectedCall of expected.toolCalls) {
    const actualCall = actual.toolCalls.find((call) => call.name === expectedCall.name);
    if (!actualCall) continue;
    const expectedKeys = Object.keys(expectedCall.arguments ?? {});
    const actualKeys = Object.keys(actualCall.arguments ?? {});
    const keyHits = expectedKeys.filter((key) => actualKeys.includes(key)).length;
    const valueHits = expectedKeys.filter((key) => actualKeys.includes(key) && JSON.stringify(expectedCall.arguments[key]) === JSON.stringify(actualCall.arguments[key])).length;
    argScores.push({
      name: expectedCall.name,
      keyRecall: expectedKeys.length ? keyHits / expectedKeys.length : 1,
      exactValueRate: expectedKeys.length ? valueHits / expectedKeys.length : 1,
      validJson: !("__invalidJson" in (actualCall.arguments ?? {})),
    });
  }
  return {
    expectedKind: expectedNames.length ? "tool" : "text",
    actualKind: actualNames.length ? "tool" : "text",
    kindMatch: Boolean(expectedNames.length) === Boolean(actualNames.length),
    toolSequenceExact: JSON.stringify(expectedNames) === JSON.stringify(actualNames),
    toolPrecision: precision,
    toolRecall: recall,
    argumentScores: argScores,
  };
}

function categoryFor(names) {
  if (!names.length) return "final-text";
  const joined = names.join(" ");
  for (const [needle, label] of [
    ["calendar", "calendar"], ["mail", "mail"], ["llm-wiki", "wiki"], ["shell", "files-shell"],
    ["documents", "documents"], ["contacts", "contacts"], ["action-center", "action-center"],
    ["train", "trains"], ["voice", "voice"], ["watch", "watch"],
  ]) if (joined.includes(needle)) return label;
  if (names.includes("ask_user")) return "clarification";
  return "other-tool";
}

function summary(point) {
  return {
    id: point.id,
    timestamp: point.timestamp,
    category: point.category,
    promptTokens: point.promptTokens,
    outputTokens: point.outputTokens,
    historyMessages: point.history.length,
    expectedTools: point.expected.toolCalls.map((call) => call.name),
    expectedTextChars: point.expected.text.length,
  };
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : 0;
  return { count: sorted.length, min: sorted[0] ?? 0, p50: q(0.5), p75: q(0.75), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: sorted.at(-1) ?? 0 };
}

function bucketCounts(points) {
  const buckets = { "<=8k": 0, "8-16k": 0, "16-32k": 0, "32-64k": 0, ">64k": 0 };
  for (const { promptTokens: n } of points) {
    if (n <= 8192) buckets["<=8k"] += 1;
    else if (n <= 16384) buckets["8-16k"] += 1;
    else if (n <= 32768) buckets["16-32k"] += 1;
    else if (n <= 65536) buckets["32-64k"] += 1;
    else buckets[">64k"] += 1;
  }
  return buckets;
}

function countBy(items, key) {
  return Object.fromEntries([...items.reduce((map, item) => map.set(key(item), (map.get(key(item)) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]));
}

function stratifiedCandidates(summaries) {
  const result = {};
  for (const item of summaries) (result[item.category] ??= []).push(item);
  for (const items of Object.values(result)) items.sort((a, b) => a.promptTokens - b.promptTokens);
  return Object.fromEntries(Object.entries(result).map(([category, items]) => [category, pickQuantiles(items)]));
}

function pickQuantiles(items) {
  if (!items.length) return [];
  return [...new Map([0, 0.5, 0.9, 1].map((p) => {
    const item = items[Math.min(items.length - 1, Math.floor((items.length - 1) * p))];
    return [item.id, item];
  })).values()];
}

function defaultSelection(points, maxTokens, limit) {
  const eligible = points.filter((p) => p.promptTokens > 0 && p.promptTokens <= maxTokens);
  const categories = [...new Set(eligible.map((p) => p.category))];
  const selected = [];
  for (const category of categories) {
    const candidates = eligible.filter((p) => p.category === category).sort((a, b) => Math.abs(a.promptTokens - maxTokens * 0.6) - Math.abs(b.promptTokens - maxTokens * 0.6));
    if (candidates[0]) selected.push(candidates[0]);
    if (selected.length >= limit) break;
  }
  for (const point of eligible.sort((a, b) => b.promptTokens - a.promptTokens)) {
    if (selected.length >= limit) break;
    if (!selected.some((item) => item.id === point.id)) selected.push(point);
  }
  return selected;
}

function aggregateResults(results) {
  const ok = results.filter((r) => !r.error);
  const avg = (fn) => ok.length ? ok.reduce((sum, item) => sum + fn(item), 0) / ok.length : 0;
  return {
    requested: results.length,
    completed: ok.length,
    errors: results.length - ok.length,
    kindMatchRate: avg((r) => Number(r.score.kindMatch)),
    exactToolSequenceRate: avg((r) => Number(r.score.toolSequenceExact)),
    meanToolPrecision: avg((r) => r.score.toolPrecision),
    meanToolRecall: avg((r) => r.score.toolRecall),
    meanDurationMs: avg((r) => r.durationMs),
    promptTokens: distribution(ok.map((r) => r.usage?.prompt_tokens ?? 0)),
    outputTokens: distribution(ok.map((r) => r.usage?.completion_tokens ?? 0)),
  };
}

function resultSummary(result) {
  return {
    id: result.id,
    category: result.category,
    historicalPromptTokens: result.historicalPromptTokens,
    expectedTools: result.expected.toolCalls.map((c) => c.name),
    actualTools: result.actual.toolCalls.map((c) => c.name),
    score: result.score,
    error: result.error,
    durationMs: result.durationMs,
    usage: result.usage,
    timings: result.timings,
  };
}

function safeLabel(value) { return value.replace(/[^a-z0-9._-]+/gi, "-"); }
