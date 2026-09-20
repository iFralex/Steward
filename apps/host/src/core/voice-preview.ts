import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { VoiceLang } from "./voice-i18n.ts";
import {
  MAX_SPEECH_RATE_WPM, MIN_SPEECH_RATE_WPM, listSystemVoices,
} from "./voice-settings.ts";

const execFileAsync = promisify(execFile);

export interface VoicePreviewInput {
  language: VoiceLang;
  rateWpm: unknown;
  voice: unknown;
}

interface VoicePreviewDeps {
  runSay?: (args: string[]) => Promise<void>;
}

const SAMPLE_TEXT: Record<VoiceLang, string> = {
  en: "Hello, I am Steward. This is a preview of the selected voice and speaking speed.",
  it: "Ciao, sono Steward. Questa è una prova della voce e della velocità selezionate.",
};

export async function renderVoicePreview(input: VoicePreviewInput, deps: VoicePreviewDeps = {}): Promise<Buffer> {
  if (typeof input.rateWpm !== "number" || !Number.isInteger(input.rateWpm)
    || input.rateWpm < MIN_SPEECH_RATE_WPM || input.rateWpm > MAX_SPEECH_RATE_WPM) {
    throw new Error(`rateWpm must be an integer from ${MIN_SPEECH_RATE_WPM} to ${MAX_SPEECH_RATE_WPM}`);
  }
  const voices = listSystemVoices(input.language);
  const preferred = input.language === "it" ? "Alice" : "Samantha";
  const selected = input.voice === "auto"
    ? voices.find((voice) => voice.name === preferred) ?? voices[0]
    : voices.find((voice) => voice.name === input.voice);
  if (!selected) throw new Error(`No matching installed ${input.language} system voice`);

  const workDir = await mkdtemp(join(tmpdir(), "steward-voice-preview-"));
  const output = join(workDir, "preview.wav");
  const args = [
    "-v", selected.name, "-r", String(input.rateWpm),
    "--file-format=WAVE", "--data-format=LEI16@22050", "-o", output,
    SAMPLE_TEXT[input.language],
  ];
  try {
    if (deps.runSay) await deps.runSay(args);
    else await execFileAsync(process.env.STEWARD_SAY_BIN ?? "/usr/bin/say", args, { timeout: 15_000 });
    const audio = await readFile(output);
    if (audio.length < 44) throw new Error("The system voice produced no preview audio");
    return audio;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
