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

test("voice approval summarizes an agent watch instead of reading raw JSON", () => {
  const prompt = formatVoiceApprovalRequest({
    tool: "create_agent_watch",
    input: {
      source: "time", at: "2026-09-21T09:00:00+02:00", instruction: "Chiamami per il riepilogo",
      rules: [{ id: "call", event: "time.reached", grants: [{ tool: "mcp__voice__call_start", maxInvocations: 1 }],
        continuation: { outcomes: ["not_answered"], afterMinutes: 1, maxAttempts: 2 } }],
    },
  }, "it");
  assert.match(prompt, /Alle/);
  assert.match(prompt, /Chiamami per il riepilogo/);
  assert.match(prompt, /una chiamata/);
  assert.match(prompt, /riprova una volta dopo un minuto/);
  assert.doesNotMatch(prompt, /\"source\"/);
  assert.doesNotMatch(prompt, /mcp__voice__call_start/);
});

test("voice approval states when a failed call may use a fallback push", () => {
  const prompt = formatVoiceApprovalRequest({
    tool: "create_agent_watch",
    input: {
      source: "time", instruction: "Chiamami",
      rules: [{ id: "call", event: "time.reached", voiceFallback: "push",
        grants: [{ tool: "mcp__voice__call_start" }] }],
    },
  }, "it");
  assert.match(prompt, /notifica push di ripiego/);
});

test("voice approval propagates an end-to-end media failure", async () => {
  await assert.rejects(
    conductVoiceApproval("Approva?", async () =>
      '[CALL FAILED] {"code":"media_stalled","message":"Remote media stalled.","retryable":true}'),
    /Remote media stalled/,
  );
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
  assert.deepEqual(result, { decision: "allow", repeats: 1, reason: "spoken-command", utterances: ["ripeti", "approva"] });
  assert.equal(repeated, 1);
});

test("voice approval commands are exact and ambiguity fails closed", () => {
  assert.equal(parseVoiceApprovalReply('User replied: "approva"', "it"), "allow");
  assert.equal(parseVoiceApprovalReply('User replied: "confermo"', "it"), "allow");
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
  let idleCalls = 0;
  const turn = new Promise<any>((resolve) => { finishTurn = resolve; });
  let coordinator: VoiceCallCoordinator;
  coordinator = new VoiceCallCoordinator(fakeConfig(), undefined, {
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
    onIdle: () => { idleCalls += 1; assert.equal(coordinator.isBusy(), false); },
  });

  const first = await coordinator.start(undefined, "request-1");
  assert.equal(first.chatId, "voice-chat");
  assert.equal(first.requestId, "request-1");
  assert.equal(coordinator.isBusy(), true);
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
  assert.equal(idleCalls, 1);
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

test("interrupted media triggers one callback in the same chat without replaying actions", async () => {
  const chat = chatStore().createChat("Recovery");
  const prompts: string[] = [];
  const calls: string[] = [];
  const usage: any[] = [];
  const audit: any[] = [];
  let finished!: () => void;
  const completion = new Promise<void>((resolve) => { finished = resolve; });
  const coordinator = new VoiceCallCoordinator(fakeConfig(), (chatId, error) => {
    calls.push(`${chatId}:${error?.message ?? "ok"}`);
    finished();
  }, {
    bridge: async () => fakeBridge(), createChat: () => chat,
    createRunner: (emit) => ({
      runTurn: async () => { throw new Error("hidden prompt expected"); },
      runAutomaticTurn: async (chatId, prompt) => {
        assert.equal(chatId, chat.id);
        prompts.push(prompt);
        emit({ type: "tool_call", tool: "mcp__voice__call_start" } as any);
        emit({ type: "tool_result", tool: "mcp__voice__call_start", ok: true, output: "connected" } as any);
        if (prompts.length === 1) {
          emit({ type: "tool_result", tool: "mcp__voice__listen", ok: true,
            output: '[CALL FAILED] {"code":"media_interrupted","message":"RTP stopped","retryable":true}' } as any);
        }
        return { ok: true, messageId: "done", text: "done" };
      },
      abort: async () => {},
    }),
    audit: ((entry: any) => audit.push(entry)) as any,
    usage: (entry) => usage.push(entry), language: () => "it", sleep: async () => {},
  });
  await coordinator.start(undefined, "recover-1");
  await completion;
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /stessa chat/);
  assert.match(prompts[1], /Non ripetere un tool con effetti esterni/);
  assert.deepEqual(calls, [`${chat.id}:ok`]);
  assert.deepEqual(usage.map((entry) => entry.outcome), ["media_interrupted", "completed"]);
  assert.equal(audit.filter((entry) => entry.eventType === "voice.recovery_scheduled").length, 1);
  assert.equal(coordinator.status().lastCall?.ok, true);
});

test("an interrupted voice approval retains the media failure after NO ACTIVE CALL", async () => {
  const chat = chatStore().createChat("Approval recovery");
  const audit: any[] = [];
  const usage: any[] = [];
  const finished: Array<{ chatId: string; error?: Error }> = [];
  let resolveFinished!: () => void;
  const completion = new Promise<void>((resolve) => { resolveFinished = resolve; });
  const bridge = fakeBridge();
  bridge.callTool = async (tool: string) => [{ type: "text", text: tool === "mcp__voice__call_status"
    ? '{"ready":true,"phase":"idle"}'
    : '[CALL FAILED] {"code":"media_interrupted","message":"RTP stopped during approval","retryable":true}' }];
  let turns = 0;
  const coordinator = new VoiceCallCoordinator(fakeConfig(), (chatId, error) => {
    finished.push({ chatId, error });
    resolveFinished();
  }, {
    bridge: async () => bridge, createChat: () => chat,
    createRunner: (emit, _scope, session) => ({
      runTurn: async () => { throw new Error("hidden prompt expected"); },
      runAutomaticTurn: async () => {
        turns += 1;
        emit({ type: "tool_call", tool: "mcp__voice__call_start" } as any);
        emit({ type: "tool_result", tool: "mcp__voice__call_start", ok: true, output: "connected" } as any);
        if (turns === 1) {
          const approval = await session!.requestApproval({
            tool: "create_agent_watch", input: { source: "time", afterMinutes: 1 }, chatId: chat.id,
          });
          assert.equal(approval.decision, "deny");
          emit({ type: "tool_result", tool: "mcp__voice__converse", ok: false,
            output: "[NO ACTIVE CALL] — call call_start first" } as any);
          return { ok: false, error: "agent stopped after channel error", aborted: false, messageId: null, text: "" };
        }
        return { ok: true, messageId: "recovered", text: "continued" };
      },
      abort: async () => {},
    }),
    audit: ((entry: any) => audit.push(entry)) as any,
    usage: (entry) => usage.push(entry), language: () => "it", sleep: async () => {},
  });

  await coordinator.start(undefined, "approval-recovery");
  await completion;
  assert.equal(turns, 2);
  assert.deepEqual(usage.map((entry) => entry.outcome), ["media_interrupted", "completed"]);
  assert.equal(audit.find((entry) => entry.eventType === "voice.call_failed")?.payload?.diagnostic?.code, "media_interrupted");
  assert.equal(audit.filter((entry) => entry.eventType === "voice.recovery_scheduled").length, 1);
  assert.deepEqual(finished, [{ chatId: chat.id, error: undefined }]);
});

test("a failed recovery never calls again", async () => {
  const chat = chatStore().createChat("Recovery limit");
  let attempts = 0;
  let originalDialClaims = 0;
  const originalGuard = {
    beforeExecute: async (tool: string) => {
      if (tool === "mcp__voice__call_start") return { allowed: ++originalDialClaims === 1 };
      return { allowed: false };
    },
  };
  const coordinator = new VoiceCallCoordinator(fakeConfig(), undefined, {
    bridge: async () => fakeBridge(), createRunner: (emit, scope) => ({
      runTurn: async () => { throw new Error("hidden prompt expected"); },
      runAutomaticTurn: async () => {
        attempts += 1;
        assert.equal((await scope!.executionGuard!.beforeExecute("mcp__voice__call_start", {})).allowed, true);
        assert.equal((await scope!.executionGuard!.beforeExecute("mcp__mail__send_email", {})).allowed, false);
        emit({ type: "tool_call", tool: "mcp__voice__call_start" } as any);
        emit({ type: "tool_result", tool: "mcp__voice__call_start", ok: true,
          output: '[CALL FAILED] {"code":"media_interrupted","message":"RTP stopped","retryable":true}' } as any);
        return { ok: true, messageId: null, text: "" };
      },
      abort: async () => {},
    }),
    audit: (() => {}) as any, usage: () => {}, language: () => "en", sleep: async () => {},
  });
  const summary = await coordinator.runWatchEvent(chat.id, "Initial watcher event", "watch-recovery", {
    allowedTools: ["mcp__voice__call_start"], executionGuard: originalGuard,
  });
  assert.equal(attempts, 2);
  assert.equal(originalDialClaims, 1);
  assert.equal(summary.failureCode, "media_interrupted");
  assert.equal(summary.ok, false);
});
