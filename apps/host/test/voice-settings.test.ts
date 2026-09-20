import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "steward-voice-settings-"));
const oldSettingsFile = process.env.STEWARD_VOICE_SETTINGS_FILE;
const oldCallSettingsFile = process.env.STEWARD_VOICE_CALL_SETTINGS_FILE;
process.env.STEWARD_VOICE_SETTINGS_FILE = join(dir, "voice-settings.json");
process.env.STEWARD_VOICE_CALL_SETTINGS_FILE = join(dir, "voice-call-settings.json");
process.env.AUDIT_DIR = join(dir, "audit");

import {
  clearCallVoiceOverride, getVoiceSettings, setCallSpeechRate, setVoiceSettings,
  voiceCallOverridePath,
} from "../src/core/voice-settings.ts";
import { buildVoiceSettingsTool } from "../src/core/voice-settings-tool.ts";
import { Session } from "../src/core/session.ts";

before(() => clearCallVoiceOverride());
after(() => {
  clearCallVoiceOverride();
  if (oldSettingsFile === undefined) delete process.env.STEWARD_VOICE_SETTINGS_FILE;
  else process.env.STEWARD_VOICE_SETTINGS_FILE = oldSettingsFile;
  if (oldCallSettingsFile === undefined) delete process.env.STEWARD_VOICE_CALL_SETTINGS_FILE;
  else process.env.STEWARD_VOICE_CALL_SETTINGS_FILE = oldCallSettingsFile;
});

test("voice settings have safe defaults and validate persisted values", () => {
  assert.deepEqual(getVoiceSettings(), { rateWpm: 175, voice: "auto" });
  assert.deepEqual(setVoiceSettings({ rateWpm: 210, voice: "Alice" }), { rateWpm: 210, voice: "Alice" });
  assert.deepEqual(getVoiceSettings(), { rateWpm: 210, voice: "Alice" });
  assert.throws(() => setVoiceSettings({ rateWpm: 99 }), /100 to 300/);
  assert.throws(() => setVoiceSettings({ voice: "Unknown" }), /voice must be one of/);
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
  assert.equal(getVoiceSettings().rateWpm, 190);
});
