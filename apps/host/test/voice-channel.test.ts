import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
process.env.CHATS_DIR = mkdtempSync(join(tmpdir(), "voice-channel-chats-"));
import { loadVoiceChannelConfig } from "../src/config.ts";
import {
  conductVoiceApproval, formatVoiceApprovalRequest, parseVoiceApprovalReply,
  ringbackCallPrompt, voiceToolPolicy, VoiceBusyError, VoiceCallCoordinator,
} from "../src/core/voice-channel.ts";
import { chatStore } from "../src/core/chat-store.ts";
import { localizedOpeningLine, voiceMessages } from "../src/core/voice-i18n.ts";

test("voice config is disabled unless explicitly selected", () => {
  assert.deepEqual(loadVoiceChannelConfig({}), { transport: "disabled" });
});

test("ringback config keeps a stable transport-neutral launcher boundary", () => {
  assert.deepEqual(loadVoiceChannelConfig({
    STEWARD_VOICE_TRANSPORT: "ringback",
    STEWARD_RINGBACK_LAUNCHER: "/opt/steward/ringback/run_voice_mcp.sh",
    STEWARD_VOICE_OPENING_LINE: "Pronto?",
  }), {
    transport: "ringback",
    launcher: "/opt/steward/ringback/run_voice_mcp.sh",
    openingLine: "Pronto?",
    preflightTimeoutMs: 10_000,
  });
});

test("StreamCore already has a config shape without pretending it is implemented", () => {
  const config = loadVoiceChannelConfig({ STEWARD_VOICE_TRANSPORT: "streamcore" });
  assert.equal(config.transport, "streamcore");
  assert.equal(config.baseUrl, "http://127.0.0.1:8080");

  const coordinator = new VoiceCallCoordinator({ voice: config } as any, undefined, { language: () => "en" });
  assert.deepEqual({ ...coordinator.status(), updatedAt: 0 }, {
    enabled: false,
    transport: "streamcore",
    state: "disabled",
    updatedAt: 0,
    detail: "StreamCore transport is reserved but not implemented yet.",
  });
});

test("Ringback voice prompt delegates sensitive approvals to the host", () => {
  const prompt = ringbackCallPrompt("Ciao, sono Steward.", "it");
  assert.match(prompt, /mcp__voice__call_start/);
  assert.match(prompt, /mcp__voice__converse/);
  assert.match(prompt, /mcp__voice__call_end/);
  assert.match(prompt, /sottoprotocollo vocale dell'host/i);
  assert.match(prompt, /non riprovare/i);
  assert.match(prompt, /Ciao, sono Steward\./);
});

test("Ringback opening prompt follows Steward's persisted user language", () => {
  const italian = ringbackCallPrompt(localizedOpeningLine(undefined, "it"), "it");
  const english = ringbackCallPrompt(localizedOpeningLine(undefined, "en"), "en");

  assert.match(italian, /Ciao, sono Steward\. Come posso aiutarti\?/);
  assert.match(italian, /Parla in italiano/);
  assert.doesNotMatch(italian, /Speak English/);
  assert.match(english, /Hi, this is Steward\. How can I help\?/);
  assert.match(english, /Speak English/);
  assert.doesNotMatch(english, /Parla in italiano/);
});

test("voice calls preserve the PWA policy and only add call/scoped grants", () => {
  const policy: Parameters<typeof voiceToolPolicy>[0] = {
    default: "gate", denyPrefixes: ["blocked__"], rules: { read: "allow", forbidden: "deny" },
  };
  const voice = voiceToolPolicy(policy, ["preapproved"]);
  assert.equal(voice.default, "gate");
  assert.deepEqual(voice.denyPrefixes, ["blocked__"]);
  assert.deepEqual(voice.rules, {
    read: "allow", forbidden: "deny", mcp__voice__call_start: "allow", preapproved: "allow",
  });
});

test("voice approval renders the complete immutable request", () => {
  const prompt = formatVoiceApprovalRequest({
    tool: "mcp__mail__send_email",
    input: { to: ["sorella@example.com"], subject: "Arrivo", body: "Sto arrivando" },
    preview: { recipients: 1 },
  }, "it");
  assert.match(prompt, /mcp__mail__send_email/);
  assert.match(prompt, /sorella@example\.com/);
  assert.match(prompt, /Sto arrivando/);
  assert.match(prompt, /recipients/);
});

test("ripeti rereads the exact same approval request before accepting", async () => {
  const spoken: string[] = [];
  const replies = ['User replied: "ripeti"', 'User replied: "approva"'];
  let repeated = 0;
  const result = await conductVoiceApproval("RICHIESTA IDENTICA", async (text) => {
    spoken.push(text);
    return replies.shift();
  }, "it", () => { repeated += 1; });
  assert.deepEqual(spoken, ["RICHIESTA IDENTICA", "RICHIESTA IDENTICA"]);
  assert.deepEqual(result, { decision: "allow", repeats: 1, reason: "spoken-command" });
  assert.equal(repeated, 1);
});

test("voice approval commands are exact and ambiguity fails closed", () => {
  assert.equal(parseVoiceApprovalReply('User replied: "approva"', "it"), "allow");
  assert.equal(parseVoiceApprovalReply('User replied: "rifiuta"', "it"), "deny");
  assert.equal(parseVoiceApprovalReply('User replied: "rileggi la richiesta"', "it"), "repeat");
  assert.equal(parseVoiceApprovalReply('User replied: "forse sì"', "it"), "unknown");
});

test("English voice copy and commands come from the matching i18n catalog", () => {
  const prompt = formatVoiceApprovalRequest({ tool: "send", input: { subject: "Hello" } }, "en");
  assert.match(prompt, /^Approval request\./);
  assert.match(prompt, /Say approve.*reject.*repeat/);
  assert.equal(parseVoiceApprovalReply('User replied: "approve"', "en"), "allow");
  assert.equal(parseVoiceApprovalReply('User replied: "reject"', "en"), "deny");
  assert.equal(parseVoiceApprovalReply('User replied: "repeat"', "en"), "repeat");
  assert.equal(parseVoiceApprovalReply('User replied: "approva"', "en"), "unknown");
});

test("default and legacy opening lines follow the selected language, custom text does not", () => {
  assert.equal(localizedOpeningLine("", "en"), voiceMessages("en").defaultOpeningLine);
  assert.equal(localizedOpeningLine("Ciao, sono Steward. Come posso aiutarti?", "en"), voiceMessages("en").defaultOpeningLine);
  assert.equal(localizedOpeningLine("Pronto, test personalizzato", "en"), "Pronto, test personalizzato");
});

test("Ringback macOS TTS adapter applies locale, persistent voice settings, and the call override", () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-tts-i18n-"));
  const langFile = join(dir, "lang.json");
  const settingsFile = join(dir, "voice-settings.json");
  const callSettingsFile = join(dir, "voice-call-settings.json");
  const sayLog = join(dir, "say.log");
  const fakeSay = join(dir, "say");
  const adapter = new URL("../../../tools/ringback-say-localized.sh", import.meta.url).pathname;
  writeFileSync(fakeSay, '#!/bin/bash\nprintf "%s\\n" "$@" > "$STEWARD_SAY_LOG"\n');
  chmodSync(fakeSay, 0o700);
  const run = (lang: "en" | "it") => {
    writeFileSync(langFile, JSON.stringify({ lang }));
    const result = spawnSync("/bin/bash", [adapter, join(dir, "out.wav"), "Test"], {
      env: {
        ...process.env,
        STEWARD_USER_LANG_FILE: langFile,
        STEWARD_VOICE_SETTINGS_FILE: settingsFile,
        STEWARD_VOICE_CALL_SETTINGS_FILE: callSettingsFile,
        STEWARD_SAY_BIN: fakeSay,
        STEWARD_SAY_LOG: sayLog,
      },
    });
    assert.equal(result.status, 0, result.stderr.toString());
    return readFileSync(sayLog, "utf8");
  };
  assert.match(run("it"), /Alice/);
  assert.match(run("en"), /Samantha/);
  writeFileSync(settingsFile, JSON.stringify({
    rateWpm: 205,
    voices: { it: "Eddy (Italiano (Italia))", en: "Daniel" },
  }));
  assert.match(run("it"), /Eddy \(Italiano \(Italia\)\)\n-r\n205/);
  assert.match(run("en"), /Daniel\n-r\n205/);
  writeFileSync(callSettingsFile, JSON.stringify({ rateWpm: 120 }));
  assert.match(run("en"), /Daniel\n-r\n120/);
});

test("a gated call tool is approved through Ringback and recorded in Usage and Audit", async () => {
  const audit: any[] = [];
  const toolUsage: any[] = [];
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const bridge = fakeBridge();
  bridge.callTool = async (tool: string) => tool === "mcp__voice__call_status"
    ? [{ type: "text", text: '{"ready":true,"phase":"idle"}' }]
    : [{ type: "text", text: 'User replied: "approva"' }];
  const coordinator = new VoiceCallCoordinator(fakeConfig(), () => { finish(); }, {
    bridge: async () => bridge,
    createChat: () => ({ id: "voice-approval-chat" }),
    createRunner: (emit, _scope, session) => ({
      runTurn: async () => {
        emit({ type: "tool_call", tool: "mcp__voice__call_start" } as any);
        const outcome = await session!.requestApproval({
          tool: "mcp__mail__send_email",
          input: { to: ["sorella@example.com"], subject: "Arrivo", body: "Sto arrivando" },
          preview: { recipients: 1 },
          chatId: "voice-approval-chat",
        });
        assert.equal(outcome.decision, "allow");
        return { ok: true, messageId: "done", text: "inviata" };
      },
      abort: async () => {},
    }),
    audit: ((event: any) => audit.push(event)) as any,
    usage: () => {}, toolUsage: (record) => toolUsage.push(record), language: () => "it", sleep: async () => {},
  });

  await coordinator.start(undefined, "voice-approval-request");
  await finished;
  assert.equal(audit.some((event) => event.eventType === "voice.approval_prompted"), true);
  assert.equal(audit.some((event) => event.eventType === "voice.approval_allow"), true);
  assert.equal(toolUsage.length, 1);
  assert.equal(toolUsage[0].tool, "voice.approval");
  assert.equal(toolUsage[0].ok, true);
});

function fakeConfig() {
  return {
    voice: {
      transport: "ringback",
      launcher: "/tmp/ringback",
      openingLine: "Pronto?",
      preflightTimeoutMs: 1_000,
    },
    mcpServers: {},
    gateway: {},
    policy: { default: "deny", rules: {} },
    approvalTimeoutMs: 1_000,
  } as any;
}

function fakeBridge(status = '{"ready":true,"phase":"idle"}') {
  return {
    tools: ["call_start", "call_status", "call_end", "converse"].map((name) => ({ name: `mcp__voice__${name}` })),
    callTool: async () => [{ type: "text", text: status }],
    close: async () => {},
  } as any;
}

test("preflight runs before chat creation and duplicate request ids are idempotent", async () => {
  let emit: ((event: any) => void) | undefined;
  let finishTurn: ((result: any) => void) | undefined;
  const turn = new Promise<any>((resolve) => { finishTurn = resolve; });
  const coordinator = new VoiceCallCoordinator(fakeConfig(), undefined, {
    bridge: async () => fakeBridge(),
    createChat: () => ({ id: "voice-chat" }),
    createRunner: (handler) => {
      emit = handler;
      return { runTurn: async () => turn, abort: async () => {} };
    },
    audit: (() => {}) as any,
    usage: () => {},
    now: () => 1234,
    sleep: async () => {},
  });

  const first = await coordinator.start(undefined, "request-1");
  assert.equal(first.chatId, "voice-chat");
  assert.equal(first.requestId, "request-1");
  const duplicate = await coordinator.start(undefined, "request-1");
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(() => coordinator.start(undefined, "request-2"), VoiceBusyError);

  emit?.({ type: "tool_call", tool: "mcp__voice__call_start" });
  assert.equal(coordinator.status().state, "ringing");
  emit?.({ type: "tool_result", tool: "mcp__voice__call_start", ok: true, output: 'User replied: "ciao"' });
  assert.equal(coordinator.status().state, "processing");
  finishTurn?.({ ok: true, messageId: null, text: "done" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.status().state, "idle");
  assert.equal(coordinator.status().lastCall?.ok, true);
});

test("a quick call uses a hidden host control turn instead of a visible user message", async () => {
  let automaticActor: string | undefined;
  let visibleTurnCalled = false;
  const coordinator = new VoiceCallCoordinator(fakeConfig(), undefined, {
    bridge: async () => fakeBridge(),
    createChat: () => ({ id: "quick-call-chat" }),
    createRunner: (emit) => ({
      runTurn: async () => {
        visibleTurnCalled = true;
        throw new Error("quick-call control prompts must stay hidden");
      },
      runAutomaticTurn: async (_chatId, _prompt, actor) => {
        automaticActor = actor;
        emit({ type: "tool_call", tool: "mcp__voice__call_start" } as any);
        emit({ type: "tool_result", tool: "mcp__voice__call_start", ok: true, output: "connected" } as any);
        return { ok: true, messageId: "done", text: "done" };
      },
      abort: async () => {},
    }),
    audit: (() => {}) as any,
    usage: () => {},
    sleep: async () => {},
  });

  await coordinator.start(undefined, "hidden-quick-call");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(visibleTurnCalled, false);
  assert.equal(automaticActor, "host");
  assert.equal(coordinator.status().lastCall?.ok, true);
});

test("a resolved TurnResult with ok false marks the call as failed", async () => {
  let finishedError: Error | undefined;
  const coordinator = new VoiceCallCoordinator(fakeConfig(), (_chatId, error) => { finishedError = error; }, {
    bridge: async () => fakeBridge(),
    createChat: () => ({ id: "failed-chat" }),
    createRunner: () => ({
      runTurn: async () => ({ ok: false, error: "agent unavailable", aborted: false, messageId: null, text: "" }),
      abort: async () => {},
    }),
    audit: (() => {}) as any,
    usage: () => {},
    sleep: async () => {},
  });

  await coordinator.start(undefined, "request-failure");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finishedError?.message, "agent unavailable");
  assert.equal(coordinator.status().state, "idle");
  assert.equal(coordinator.status().lastCall?.ok, false);
  assert.equal(coordinator.status().retryable, true);
});

test("a pre-authorized watch event continues the originating chat and waits for the call", async () => {
  const chat = chatStore().createChat("Treno per Bologna");
  let automaticPrompt = "";
  const coordinator = new VoiceCallCoordinator(fakeConfig(), undefined, {
    bridge: async () => fakeBridge(),
    createRunner: (emit) => ({
      runTurn: async () => { throw new Error("watch events must use the automatic turn path"); },
      runAutomaticTurn: async (chatId, prompt) => {
        assert.equal(chatId, chat.id);
        automaticPrompt = prompt;
        emit({ type: "tool_call", tool: "mcp__voice__call_start" } as any);
        emit({ type: "tool_result", tool: "mcp__voice__call_start", ok: true, output: 'User replied: "A che ora arrivo?"' } as any);
        return { ok: true, messageId: "answer", text: "Chiamata conclusa" };
      },
      abort: async () => {},
    }),
    audit: (() => {}) as any,
    usage: () => {},
    sleep: async () => {},
  });

  const summary = await coordinator.runWatchEvent(chat.id, "Evento treno strutturato", "watch-event-1");

  assert.equal(summary.chatId, chat.id);
  assert.equal(summary.ok, true);
  assert.equal(automaticPrompt, "Evento treno strutturato");
  assert.equal(coordinator.status().state, "idle");
});

test("a watch call carries other granted capabilities into the same scoped voice turn", async () => {
  const chat = chatStore().createChat("Evento combinato");
  let seenScope: { allowedTools: string[] } | undefined;
  let closed = false;
  const coordinator = new VoiceCallCoordinator(fakeConfig(), undefined, {
    bridge: async () => fakeBridge(),
    createRunner: (emit, scope) => {
      seenScope = scope;
      return {
        runTurn: async () => { throw new Error("unexpected interactive turn"); },
        runAutomaticTurn: async () => {
          emit({ type: "tool_call", tool: "mcp__voice__call_start" } as any);
          emit({ type: "tool_result", tool: "mcp__voice__call_start", ok: true, output: "connected" } as any);
          return { ok: true, messageId: "m", text: "done" };
        },
        abort: async () => {},
        close: async () => { closed = true; },
      };
    },
    audit: (() => {}) as any, usage: () => {}, sleep: async () => {},
  });
  const guard = { beforeExecute: async () => ({ allowed: true }) };
  const summary = await coordinator.runWatchEvent(chat.id, "call and update", "combined-1", {
    allowedTools: ["mcp__calendar__update_event"], executionGuard: guard,
  });
  assert.equal(summary.ok, true);
  assert.deepEqual(seenScope?.allowedTools, ["mcp__calendar__update_event"]);
  assert.equal(closed, true);
});

test("preflight retries once but never creates a chat when Ringback stays unhealthy", async () => {
  let attempts = 0;
  let chats = 0;
  const coordinator = new VoiceCallCoordinator(fakeConfig(), undefined, {
    bridge: async () => {
      attempts += 1;
      throw new Error("MCP offline");
    },
    createChat: () => { chats += 1; return { id: "must-not-exist" }; },
    audit: (() => {}) as any,
    usage: () => {},
    sleep: async () => {},
  });
  await assert.rejects(() => coordinator.start(undefined, "preflight-failure"), /MCP offline/);
  assert.equal(attempts, 2);
  assert.equal(chats, 0);
  assert.equal(coordinator.status().state, "failed");
  assert.equal(coordinator.status().retryable, true);
});

test("preflight rejects Ringback's machine-readable ready false result", async () => {
  let attempts = 0;
  const coordinator = new VoiceCallCoordinator(fakeConfig(), undefined, {
    bridge: async () => {
      attempts += 1;
      return fakeBridge('{"ready":false,"phase":"failed","error":"pjsua init failed"}');
    },
    createChat: () => ({ id: "must-not-exist" }),
    audit: (() => {}) as any,
    usage: () => {},
    sleep: async () => {},
  });
  await assert.rejects(() => coordinator.start(undefined, "unhealthy-engine"), /pjsua init failed/);
  assert.equal(attempts, 2);
  assert.equal(coordinator.status().state, "failed");
});

test("structured SIP failures reach status, Usage, Audit, and completion callback", async () => {
  let emit: ((event: any) => void) | undefined;
  let finishTurn: ((result: any) => void) | undefined;
  let finishedError: Error | undefined;
  const usage: any[] = [];
  const audit: any[] = [];
  const turn = new Promise<any>((resolve) => { finishTurn = resolve; });
  let now = 1_000;
  const coordinator = new VoiceCallCoordinator(fakeConfig(), (_chatId, error) => { finishedError = error; }, {
    bridge: async () => fakeBridge(),
    createChat: () => ({ id: "sip-failure-chat" }),
    createRunner: (handler) => {
      emit = handler;
      return { runTurn: async () => turn, abort: async () => {} };
    },
    audit: ((event: any) => audit.push(event)) as any,
    usage: (record) => usage.push(record),
    now: () => now,
    sleep: async () => {},
  });
  await coordinator.start(undefined, "sip-failure");
  now = 5_000;
  emit?.({
    type: "tool_result", tool: "mcp__voice__call_start", ok: false,
    output: '[CALL FAILED] {"code":"unreachable","message":"Phone unreachable","retryable":true,"sipStatus":480,"sipReason":"Temporarily Unavailable","dialDurationMs":3900}',
  });
  finishTurn?.({ ok: true, messageId: null, text: "done" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(finishedError?.message, "Phone unreachable");
  assert.equal(coordinator.status().lastCall?.failureCode, "unreachable");
  assert.equal(coordinator.status().lastCall?.sipStatus, 480);
  assert.equal(coordinator.status().lastCall?.durationMs, 4_000);
  assert.deepEqual(usage[0], {
    ts: 5_000, sessionId: "sip-failure-chat", transport: "ringback", outcome: "unreachable",
    failureCode: "unreachable", sipStatus: 480, durationMs: 4_000, ok: false,
  });
  const failed = audit.find((event) => event.eventType === "voice.call_failed");
  assert.equal(failed.durationMs, 4_000);
  assert.equal(failed.payload.diagnostic.sipStatus, 480);
});
