import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordAudit } from "@steward/audit-log";
import { stewardConfigDir } from "../config.ts";
import { getUserLang } from "./notification-lang.ts";
import type { VoiceLang } from "./voice-i18n.ts";

export const MIN_SPEECH_RATE_WPM = 100;
export const MAX_SPEECH_RATE_WPM = 300;
export const DEFAULT_SPEECH_RATE_WPM = 175;

export interface SystemVoice {
  name: string;
  locale: string;
}

export interface VoiceSettings {
  rateWpm: number;
  /** Selection for the requested/current Steward language. */
  voice: string;
  /** Independent selections prevent an Italian voice being reused in English. */
  voices: Record<VoiceLang, string>;
  language: VoiceLang;
}

export interface VoiceSettingsInput {
  rateWpm?: unknown;
  voice?: unknown;
}

interface PersistedVoiceSettings {
  rateWpm: number;
  voices: Record<VoiceLang, string>;
}

const DEFAULT_VOICES: Record<VoiceLang, string> = { en: "auto", it: "auto" };
let cachedVoices: { at: number; values: SystemVoice[] } | undefined;

export function voiceSettingsPath(): string {
  return process.env.STEWARD_VOICE_SETTINGS_FILE ?? join(stewardConfigDir(), "voice-settings.json");
}

export function voiceCallOverridePath(): string {
  return process.env.STEWARD_VOICE_CALL_SETTINGS_FILE ?? join(stewardConfigDir(), "voice-call-settings.json");
}

export function getVoiceSettings(language: VoiceLang = getUserLang()): VoiceSettings {
  const persisted = readPersistedSettings();
  return { ...persisted, voice: persisted.voices[language], language };
}

export function setVoiceSettings(
  input: VoiceSettingsInput,
  actor: "user" | "assistant" = "user",
  language: VoiceLang = getUserLang(),
): VoiceSettings {
  const current = readPersistedSettings();
  const voices = { ...current.voices };
  if (input.voice !== undefined) voices[language] = requireVoice(input.voice, language);
  const next: PersistedVoiceSettings = {
    rateWpm: input.rateWpm === undefined ? current.rateWpm : requireRate(input.rateWpm),
    voices,
  };
  writeFileSync(voiceSettingsPath(), JSON.stringify(next), { mode: 0o600 });
  recordAudit({
    actor, eventType: "settings.voice", risk: "low", summary: "Voice settings updated",
    ok: true, payload: { ...next, language, voice: next.voices[language] },
  });
  return { ...next, voice: next.voices[language], language };
}

export function listSystemVoices(language: VoiceLang): SystemVoice[] {
  return allSystemVoices().filter((voice) => voice.locale.toLowerCase().startsWith(`${language}_`));
}

export function setCallSpeechRate(rateWpm: number): number {
  const rate = requireRate(rateWpm);
  writeFileSync(voiceCallOverridePath(), JSON.stringify({ rateWpm: rate }), { mode: 0o600 });
  return rate;
}

export function clearCallVoiceOverride(): void {
  try { unlinkSync(voiceCallOverridePath()); } catch { /* absent is the normal idle state */ }
}

function readPersistedSettings(): PersistedVoiceSettings {
  try {
    if (!existsSync(voiceSettingsPath())) return defaults();
    const value = JSON.parse(readFileSync(voiceSettingsPath(), "utf8")) as {
      rateWpm?: unknown; voice?: unknown; voices?: { en?: unknown; it?: unknown };
    };
    const voices = { ...DEFAULT_VOICES };
    if (typeof value.voices?.en === "string" && value.voices.en.trim()) voices.en = value.voices.en;
    if (typeof value.voices?.it === "string" && value.voices.it.trim()) voices.it = value.voices.it;
    // Migrate the first implementation, which stored one global Alice/Samantha choice.
    if (!value.voices && typeof value.voice === "string" && value.voice !== "auto") {
      const installed = allSystemVoices().find((candidate) => candidate.name === value.voice);
      if (installed?.locale.toLowerCase().startsWith("it_")) voices.it = value.voice;
      if (installed?.locale.toLowerCase().startsWith("en_")) voices.en = value.voice;
    }
    return {
      rateWpm: validRate(value.rateWpm) ? value.rateWpm : DEFAULT_SPEECH_RATE_WPM,
      voices,
    };
  } catch {
    return defaults();
  }
}

function allSystemVoices(): SystemVoice[] {
  const injected = process.env.STEWARD_SYSTEM_VOICES;
  if (!injected && cachedVoices && Date.now() - cachedVoices.at < 60_000) return cachedVoices.values;
  try {
    const raw = injected ?? execFileSync("/usr/bin/say", ["-v", "?"], { encoding: "utf8", timeout: 5_000 });
    const values = raw.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]{2,3})\s+#/);
      return match ? [{ name: match[1].trim(), locale: match[2] }] : [];
    }).sort((a, b) => a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name));
    if (!injected) cachedVoices = { at: Date.now(), values };
    return values;
  } catch {
    return [];
  }
}

function defaults(): PersistedVoiceSettings {
  return { rateWpm: DEFAULT_SPEECH_RATE_WPM, voices: { ...DEFAULT_VOICES } };
}

function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= MIN_SPEECH_RATE_WPM && value <= MAX_SPEECH_RATE_WPM;
}

function requireRate(value: unknown): number {
  if (!validRate(value)) throw new Error(`rateWpm must be an integer from ${MIN_SPEECH_RATE_WPM} to ${MAX_SPEECH_RATE_WPM}`);
  return value;
}

function requireVoice(value: unknown, language: VoiceLang): string {
  if (value === "auto") return value;
  if (typeof value !== "string" || !listSystemVoices(language).some((voice) => voice.name === value)) {
    throw new Error(`voice must be auto or an installed ${language} system voice`);
  }
  return value;
}
