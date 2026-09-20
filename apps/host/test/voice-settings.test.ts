import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "steward-voice-settings-"));
const oldSettingsFile = process.env.STEWARD_VOICE_SETTINGS_FILE;
const oldCallSettingsFile = process.env.STEWARD_VOICE_CALL_SETTINGS_FILE;
const oldSystemVoices = process.env.STEWARD_SYSTEM_VOICES;
process.env.STEWARD_VOICE_SETTINGS_FILE = join(dir, "voice-settings.json");
process.env.STEWARD_VOICE_CALL_SETTINGS_FILE = join(dir, "voice-call-settings.json");
process.env.AUDIT_DIR = join(dir, "audit");
process.env.STEWARD_SYSTEM_VOICES = [
  "Alice               it_IT    # Ciao! Mi chiamo Alice.",
  "Eddy (Italiano (Italia)) it_IT    # Ciao! Mi chiamo Eddy.",
  "Daniel              en_GB    # Hello! My name is Daniel.",
  "Samantha            en_US    # Hello! My name is Samantha.",
].join("\n");

import {
  clearCallVoiceOverride, getVoiceSettings, listSystemVoices, setCallSpeechRate, setVoiceSettings,
  voiceCallOverridePath,
} from "../src/core/voice-settings.ts";
import { buildVoiceSettingsTool } from "../src/core/voice-settings-tool.ts";
import { Session } from "../src/core/session.ts";
import { renderVoicePreview } from "../src/core/voice-preview.ts";

before(() => clearCallVoiceOverride());
after(() => {
  clearCallVoiceOverride();
  if (oldSettingsFile === undefined) delete process.env.STEWARD_VOICE_SETTINGS_FILE;
  else process.env.STEWARD_VOICE_SETTINGS_FILE = oldSettingsFile;
  if (oldCallSettingsFile === undefined) delete process.env.STEWARD_VOICE_CALL_SETTINGS_FILE;
  else process.env.STEWARD_VOICE_CALL_SETTINGS_FILE = oldCallSettingsFile;
  if (oldSystemVoices === undefined) delete process.env.STEWARD_SYSTEM_VOICES;
  else process.env.STEWARD_SYSTEM_VOICES = oldSystemVoices;
});

test("voice settings have safe defaults and validate persisted values", () => {
  assert.deepEqual(getVoiceSettings("it"), {
    rateWpm: 175, voice: "auto", voices: { en: "auto", it: "auto" }, language: "it",
  });
  assert.deepEqual(setVoiceSettings({ rateWpm: 210, voice: "Eddy (Italiano (Italia))" }, "user", "it"), {
    rateWpm: 210,
    voice: "Eddy (Italiano (Italia))",
    voices: { en: "auto", it: "Eddy (Italiano (Italia))" },
    language: "it",
  });
  assert.equal(getVoiceSettings("en").voice, "auto");
  assert.deepEqual(listSystemVoices("it").map((voice) => voice.name), ["Alice", "Eddy (Italiano (Italia))"]);
  assert.throws(() => setVoiceSettings({ rateWpm: 99 }, "user", "it"), /100 to 300/);
  assert.throws(() => setVoiceSettings({ voice: "Samantha" }, "user", "it"), /installed it system voice/);
});

test("the per-call rate is stored separately and removed at call end", () => {
  assert.equal(setCallSpeechRate(135), 135);
  assert.deepEqual(JSON.parse(readFileSync(voiceCallOverridePath(), "utf8")), { rateWpm: 135 });
  clearCallVoiceOverride();
  assert.equal(existsSync(voiceCallOverridePath()), false);
});

test("the call-only tool applies a temporary rate without requesting approval", async () => {
  const events: any[] = [];
  const tool = buildVoiceSettingsTool(new Session((event) => events.push(event), 1_000), "voice-chat", "it") as any;
  assert.match(tool.description, /telefonata/);
  const output = await tool.execute("call-1", { rateWpm: 145, scope: "call" });
  assert.equal(events.some((event) => event.type === "approval_request"), false);
  assert.equal(JSON.parse(output.content[0].text).rateWpm, 145);
});

test("persisting a speech rate through the call-only tool requires approval", async () => {
  let approval: any;
  const session = new Session((event) => { if (event.type === "approval_request") approval = event; }, 1_000);
  const tool = buildVoiceSettingsTool(session, "voice-chat", "en") as any;
  const pending = tool.execute("call-2", { rateWpm: 190, scope: "default" });
  assert.equal(approval.tool, "set_default_voice_speech_rate");
  assert.equal(session.resolveApproval(approval.requestId, { decision: "allow" }), true);
  const output = await pending;
  assert.equal(JSON.parse(output.content[0].text).rateWpm, 190);
  assert.equal(getVoiceSettings("en").rateWpm, 190);
});

test("voice preview renders the unsaved voice, rate, and localized sample", async () => {
  let args: string[] = [];
  const audio = await renderVoicePreview({ language: "it", rateWpm: 155, voice: "Eddy (Italiano (Italia))" }, {
    runSay: async (received) => {
      args = received;
      const output = received[received.indexOf("-o") + 1];
      writeFileSync(output, Buffer.alloc(64, 1));
    },
  });
  assert.equal(audio.length, 64);
  assert.deepEqual(args.slice(0, 4), ["-v", "Eddy (Italiano (Italia))", "-r", "155"]);
  assert.match(args.at(-1) ?? "", /Ciao, sono Steward/);
});

test("automatic preview chooses the preferred installed voice for the language", async () => {
  let selected = "";
  await renderVoicePreview({ language: "en", rateWpm: 175, voice: "auto" }, {
    runSay: async (args) => {
      selected = args[1];
      writeFileSync(args[args.indexOf("-o") + 1], Buffer.alloc(64, 1));
    },
  });
  assert.equal(selected, "Samantha");
  await assert.rejects(
    renderVoicePreview({ language: "it", rateWpm: 175, voice: "Samantha" }, { runSay: async () => {} }),
    /No matching installed it system voice/,
  );
});
