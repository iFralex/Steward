export type VoiceFailureCode =
  | "no_answer"
  | "rejected"
  | "busy"
  | "unreachable"
  | "timeout"
  | "auth_failed"
  | "server_error"
  | "media_error"
  | "network_error"
  | "unknown";

export interface VoiceFailureDiagnostic {
  code: VoiceFailureCode;
  message: string;
  retryable: boolean;
  sipStatus?: number;
  sipReason?: string;
  sipState?: string;
  dialDurationMs?: number;
}

/** Parse Ringback's explicit, machine-readable terminal failure marker. */
export function parseRingbackFailure(output: unknown): VoiceFailureDiagnostic | null {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  const marker = "[CALL FAILED]";
  const start = text.indexOf(marker);
  if (start < 0) {
    if (text.includes("[NO ANSWER]")) {
      return { code: "no_answer", message: "The phone did not answer.", retryable: true };
    }
    if (text.includes("[NO ACTIVE CALL]")) {
      return { code: "unknown", message: "Ringback has no active phone call.", retryable: true };
    }
    return null;
  }
  const raw = text.slice(start + marker.length).trim();
  try {
    const value = JSON.parse(raw) as Partial<VoiceFailureDiagnostic>;
    let code = typeof value.code === "string" ? value.code as VoiceFailureCode : "unknown";
    const sipReason = typeof value.sipReason === "string" ? value.sipReason : undefined;
    // pjsua sometimes surfaces local transport failures as SIP 503. Preserve
    // the status, but classify an explicit socket/network reason correctly.
    if ((code === "server_error" || code === "unknown") && sipReason
      && /connection (?:reset|refused)|transport|network|socket|dns|host unreachable/i.test(sipReason)) {
      code = "network_error";
    }
    const suppliedMessage = typeof value.message === "string" && value.message ? value.message : undefined;
    return {
      code,
      message: code === "network_error" ? humanVoiceFailure(code) : (suppliedMessage ?? humanVoiceFailure(code)),
      retryable: typeof value.retryable === "boolean" ? value.retryable : retryableVoiceFailure(code),
      ...(typeof value.sipStatus === "number" ? { sipStatus: value.sipStatus } : {}),
      ...(sipReason ? { sipReason } : {}),
      ...(typeof value.sipState === "string" ? { sipState: value.sipState } : {}),
      ...(typeof value.dialDurationMs === "number" ? { dialDurationMs: value.dialDurationMs } : {}),
    };
  } catch {
    return { code: "unknown", message: raw || "Ringback call failed.", retryable: true };
  }
}

export function retryableVoiceFailure(code: VoiceFailureCode): boolean {
  return !["rejected", "auth_failed"].includes(code);
}

export function humanVoiceFailure(code: VoiceFailureCode): string {
  switch (code) {
    case "no_answer": return "The phone rang but was not answered.";
    case "rejected": return "The phone rejected the call.";
    case "busy": return "The phone is busy.";
    case "unreachable": return "The phone is not currently reachable through SIP.";
    case "timeout": return "The SIP call timed out.";
    case "auth_failed": return "The SIP provider rejected Ringback's credentials.";
    case "server_error": return "The SIP provider returned a server error.";
    case "media_error": return "The call connected but audio media could not be established.";
    case "network_error": return "The network prevented the SIP call from completing.";
    default: return "Ringback could not complete the call.";
  }
}
