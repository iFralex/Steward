import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Session } from "./session.ts";
import { getVoiceSettings, setCallSpeechRate, setVoiceSettings } from "./voice-settings.ts";
import type { VoiceLang } from "./voice-i18n.ts";

export function buildVoiceSettingsTool(session: Session, chatId: string, language: VoiceLang): ToolDefinition {
  const copy = TOOL_COPY[language];
  return {
    name: "set_voice_speech_rate",
    label: "set_voice_speech_rate",
    description: copy.description,
    parameters: {
      type: "object",
      properties: {
        rateWpm: { type: "integer", minimum: 100, maximum: 300, description: copy.rate },
        scope: { type: "string", enum: ["call", "default"], description: copy.scope },
      },
      required: ["rateWpm", "scope"],
      additionalProperties: false,
    } as unknown as ToolDefinition["parameters"],
    prepareArguments: (args: unknown) => args as never,
    execute: async (_id: string, params: { rateWpm?: unknown; scope?: unknown }) => {
      try {
        if (typeof params.rateWpm !== "number") throw new Error("rateWpm is required");
        if (params.scope !== "call" && params.scope !== "default") throw new Error("scope must be call or default");
        if (params.scope === "default") {
          const outcome = await session.requestApproval({
            tool: "set_default_voice_speech_rate", input: { rateWpm: params.rateWpm }, chatId,
          });
          if (outcome.decision !== "allow") return result({ changed: false, scope: "default", reason: "denied" });
          const settings = setVoiceSettings({ rateWpm: params.rateWpm }, "assistant");
          return result({ changed: true, scope: "default", ...settings });
        }
        const rateWpm = setCallSpeechRate(params.rateWpm);
        return result({ changed: true, scope: "call", rateWpm, defaultSettings: getVoiceSettings() });
      } catch (error) {
        return result({ changed: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  } as ToolDefinition;
}

const TOOL_COPY: Record<VoiceLang, { description: string; rate: string; scope: string }> = {
  en: {
    description: "Change Steward's speaking speed during this phone call. Use scope='call' for this call only, or scope='default' to persist it for future calls. A persistent change requires explicit user approval. Use an integer rateWpm from 100 (slow) to 300 (fast); 175 is normal.",
    rate: "Speech rate in words per minute.",
    scope: "Apply only to this call or persist as the default.",
  },
  it: {
    description: "Modifica la velocità con cui Steward parla durante questa telefonata. Usa scope='call' solo per la chiamata corrente oppure scope='default' per salvarla per le chiamate future. La modifica persistente richiede l'approvazione esplicita dell'utente. Usa un rateWpm intero da 100 (lento) a 300 (veloce); 175 è normale.",
    rate: "Velocità del parlato in parole al minuto.",
    scope: "Applica solo a questa chiamata oppure salva come impostazione predefinita.",
  },
};

function result(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: {} };
}
