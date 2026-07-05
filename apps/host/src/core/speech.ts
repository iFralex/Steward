import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { HostConfig } from "../config.ts";

const execFileAsync = promisify(execFile);
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export interface AudioPayload {
  data?: unknown;
  mimeType?: unknown;
  extension?: unknown;
  filename?: unknown;
}

export class SpeechUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechUnavailableError";
  }
}

export function speechStatus(config: HostConfig): { ok: boolean; detail: string } {
  if (!config.speech.enabled) return { ok: false, detail: "Speech transcription is disabled." };
  if (!config.speech.whisperBin) return { ok: false, detail: "STEWARD_WHISPER_BIN is not configured." };
  if (!config.speech.whisperModel) return { ok: false, detail: "STEWARD_WHISPER_MODEL is not configured." };
  if (!existsSync(config.speech.whisperBin)) return { ok: false, detail: `Missing whisper binary: ${config.speech.whisperBin}` };
  if (!existsSync(config.speech.whisperModel)) return { ok: false, detail: `Missing whisper model: ${config.speech.whisperModel}` };
  return { ok: true, detail: `${basename(config.speech.whisperBin)} using ${basename(config.speech.whisperModel)}` };
}

export async function transcribeAudioPayload(config: HostConfig, payload: AudioPayload): Promise<string> {
  const status = speechStatus(config);
  if (!status.ok) throw new SpeechUnavailableError(status.detail);

  const audio = decodeAudio(payload);
  const workDir = await mkdtemp(join(tmpdir(), "steward-audio-"));
  const inputPath = join(workDir, `input${extensionForMime(audio.mimeType)}`);
  const wavPath = join(workDir, "audio.wav");
  const outBase = join(workDir, "transcript");
  const outTxt = `${outBase}.txt`;

  try {
    await writeFile(inputPath, audio.buffer);
    await execFileAsync("/usr/bin/afconvert", ["--no-filler", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", inputPath, wavPath], {
      timeout: config.speech.convertTimeoutMs,
      maxBuffer: 512 * 1024,
    });

    await runWhisper(config, wavPath, outBase, inputPath);

    const text = (await readFile(outTxt, "utf8")).trim();
    if (!text) throw new Error("Speech transcription returned empty text.");
    return text;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function runWhisper(config: HostConfig, wavPath: string, outBase: string, inputPath: string): Promise<void> {
  try {
    await execFileAsync(config.speech.whisperBin!, [
      "-m", config.speech.whisperModel!,
      "-f", wavPath,
      "-otxt",
      "-of", outBase,
      "-np",
      "-nt",
      "-l", config.speech.language,
    ], {
      env: {
        ...process.env,
        ...whisperRuntimeEnv(config),
      },
      timeout: config.speech.timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (err) {
    const detail = [
      err instanceof Error ? err.message : String(err),
      `input bytes: ${safeSize(inputPath)}`,
      `wav bytes: ${safeSize(wavPath)}`,
    ].join("\n");
    throw new Error(detail);
  }
}

function whisperRuntimeEnv(config: HostConfig): NodeJS.ProcessEnv {
  const bin = config.speech.whisperBin;
  if (!bin) return {};

  const root = dirname(bin);
  const libPath = join(root, "lib");
  const backendPath = firstExisting([
    join(root, "libexec", "libggml-cpu-x64.so"),
    join(root, "libexec", "libggml-cpu-sse42.so"),
    join(root, "libexec", "libggml-blas.so"),
  ]);
  const env: NodeJS.ProcessEnv = {};

  if (existsSync(libPath)) {
    env.DYLD_LIBRARY_PATH = process.env.DYLD_LIBRARY_PATH ? `${libPath}:${process.env.DYLD_LIBRARY_PATH}` : libPath;
  }
  if (backendPath) env.GGML_BACKEND_PATH = backendPath;

  return env;
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

function safeSize(path: string): number | string {
  try {
    return statSync(path).size;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function decodeAudio(payload: AudioPayload): { buffer: Buffer; mimeType: string } {
  if (typeof payload.data !== "string" || !payload.data.trim()) {
    throw new Error("audio.data must be a non-empty base64 string.");
  }
  const parsed = parseBase64(payload.data);
  const mimeType = typeof payload.mimeType === "string" && payload.mimeType.trim() ? payload.mimeType.trim() : parsed.mimeType;
  const extension = typeof payload.extension === "string" && payload.extension.trim() ? payload.extension.trim() : undefined;
  const buffer = Buffer.from(parsed.base64, "base64");
  if (buffer.length === 0) throw new Error("audio.data decoded to an empty file.");
  if (buffer.length > MAX_AUDIO_BYTES) throw new Error(`audio is too large; max ${Math.floor(MAX_AUDIO_BYTES / 1024 / 1024)} MB.`);
  return { buffer, mimeType: extension ?? mimeType };
}

function parseBase64(raw: string): { base64: string; mimeType: string } {
  const match = raw.match(/^data:([^;,]+);base64,(.+)$/s);
  if (match) return { mimeType: match[1], base64: match[2] };
  return { mimeType: "audio/m4a", base64: raw };
}

function extensionForMime(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("wav")) return ".wav";
  if (lower.includes("mpeg") || lower.includes("mp3")) return ".mp3";
  if (lower.includes("mp4") || lower.includes("m4a") || lower.includes("aac")) return ".m4a";
  if (lower.includes("webm")) return ".webm";
  if (lower.includes("ogg")) return ".ogg";
  if (lower.includes("aiff") || lower.includes("aif")) return ".aiff";
  if (lower.includes("caf")) return ".caf";
  return `-${randomUUID()}.audio`;
}
