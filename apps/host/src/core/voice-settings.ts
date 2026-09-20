import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordAudit } from "@steward/audit-log";
import { stewardConfigDir } from "../config.ts";

export const MIN_SPEECH_RATE_WPM = 100;
export const MAX_SPEECH_RATE_WPM = 300;
export const DEFAULT_SPEECH_RATE_WPM = 175;
export const VOICE_CHOICES = ["auto", "Alice", "Samantha"] as const;
export type VoiceChoice = typeof VOICE_CHOICES[number];

export interface VoiceSettings {
  rateWpm: number;
  voice: VoiceChoice;
}

export interface VoiceSettingsInput {
  rateWpm?: unknown;
  voice?: unknown;
}

const DEFAULTS: VoiceSettings = { rateWpm: DEFAULT_SPEECH_RATE_WPM, voice: "auto" };

export function voiceSettingsPath(): string {
  return process.env.STEWARD_VOICE_SETTINGS_FILE ?? join(stewardConfigDir(), "voice-settings.json");
}

export function voiceCallOverridePath(): string {
  return process.env.STEWARD_VOICE_CALL_SETTINGS_FILE ?? join(stewardConfigDir(), "voice-call-settings.json");
}

export function getVoiceSettings(): VoiceSettings {
  try {
    if (!existsSync(voiceSettingsPath())) return { ...DEFAULTS };
    const value = JSON.parse(readFileSync(voiceSettingsPath(), "utf8")) as Partial<VoiceSettings>;
    return {
      rateWpm: validRate(value.rateWpm) ? value.rateWpm : DEFAULTS.rateWpm,
      voice: isVoiceChoice(value.voice) ? value.voice : DEFAULTS.voice,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setVoiceSettings(input: VoiceSettingsInput, actor: "user" | "assistant" = "user"): VoiceSettings {
  const current = getVoiceSettings();
  const next: VoiceSettings = {
    rateWpm: input.rateWpm === undefined ? current.rateWpm : requireRate(input.rateWpm),
    voice: input.voice === undefined ? current.voice : requireVoice(input.voice),
  };
  writeFileSync(voiceSettingsPath(), JSON.stringify(next), { mode: 0o600 });
  recordAudit({
    actor, eventType: "settings.voice", risk: "low", summary: "Voice settings updated",
    ok: true, payload: next,
  });
  return next;
}

export function setCallSpeechRate(rateWpm: number): number {
  const rate = requireRate(rateWpm);
  writeFileSync(voiceCallOverridePath(), JSON.stringify({ rateWpm: rate }), { mode: 0o600 });
  return rate;
}

export function clearCallVoiceOverride(): void {
  try { unlinkSync(voiceCallOverridePath()); } catch { /* absent is the normal idle state */ }
}

function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= MIN_SPEECH_RATE_WPM && value <= MAX_SPEECH_RATE_WPM;
}

function requireRate(value: unknown): number {
  if (!validRate(value)) throw new Error(`rateWpm must be an integer from ${MIN_SPEECH_RATE_WPM} to ${MAX_SPEECH_RATE_WPM}`);
  return value;
}

function isVoiceChoice(value: unknown): value is VoiceChoice {
  return typeof value === "string" && (VOICE_CHOICES as readonly string[]).includes(value);
}

function requireVoice(value: unknown): VoiceChoice {
  if (!isVoiceChoice(value)) throw new Error(`voice must be one of: ${VOICE_CHOICES.join(", ")}`);
  return value;
}
