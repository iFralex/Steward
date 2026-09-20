/**
 * Host-side voice copy. It deliberately has no React dependency: Ringback,
 * background watches, and quick-call all run when the PWA may be disconnected.
 * Keep every spoken/control phrase here so recognition and TTS use one locale.
 */
import type { NotificationLang } from "./notification-lang.ts";

export type VoiceLang = NotificationLang;
export type VoiceApprovalCommand = "allow" | "deny" | "repeat";

interface VoiceMessages {
  defaultOpeningLine: string;
  chatTitle: string;
  undefinedValue: string;
  status: {
    noTransport: string;
    streamcoreUnavailable: string;
    launcherMissing: string;
    unavailable: string;
    duplicate: string;
    busy: string;
    checking: string;
    preflightPassed: string;
    preflightRetrying: (attempt: number) => string;
    preparing: string;
    ringing: string;
    speaking: string;
    listening: string;
    ending: string;
    processing: string;
    replyReceived: string;
    callEnded: string;
    lastCompleted: string;
    lastFailed: string;
    agentFailed: string;
    noDial: string;
    approvalNoSession: string;
  };
  audit: {
    callRequested: string;
    watchCallRequested: string;
    callCompleted: string;
    approvalRequested: (tool: string) => string;
    approvalRepeated: (tool: string) => string;
    approvalDecision: (decision: VoiceApprovalCommand, tool: string) => string;
  };
  approval: {
    title: string;
    tool: (tool: string) => string;
    arguments: (value: string) => string;
    preview: (value: string) => string;
    instruction: string;
    notUnderstood: string;
    readingStatus: (tool: string) => string;
    waitingStatus: string;
    deniedNote: (reason: string) => string;
    recordedStatus: (decision: VoiceApprovalCommand) => string;
    alreadyResolvedStatus: string;
    keywords: Record<VoiceApprovalCommand, readonly string[]>;
  };
  callPrompt: (openingLine: string) => string;
}

const MESSAGES = {
  en: {
    defaultOpeningLine: "Hi, this is Steward. How can I help?",
    chatTitle: "Voice call",
    undefinedValue: "none",
    status: {
      noTransport: "No voice transport configured.",
      streamcoreUnavailable: "StreamCore transport is reserved but not implemented yet.",
      launcherMissing: "STEWARD_RINGBACK_LAUNCHER is not configured.",
      unavailable: "Voice calls are unavailable.",
      duplicate: "This voice event was already started.",
      busy: "A voice call is already running.",
      checking: "Checking the Ringback engine before dialing.",
      preflightPassed: "Ringback preflight passed.",
      preflightRetrying: (attempt) => `Ringback preflight attempt ${attempt} failed; retrying safely.`,
      preparing: "Ringback is ready; Steward is preparing the call.",
      ringing: "Calling the phone; waiting for an answer.",
      speaking: "Steward is speaking and waiting for the next reply.",
      listening: "Steward is listening.",
      ending: "Steward is ending the call.",
      processing: "Steward is processing the request.",
      replyReceived: "Steward received the reply and is processing it.",
      callEnded: "The phone call has ended.",
      lastCompleted: "The last call completed.",
      lastFailed: "The last call failed.",
      agentFailed: "The voice agent turn failed.",
      noDial: "The automatic voice turn completed without starting a call.",
      approvalNoSession: "Voice approval has no active session.",
    },
    audit: {
      callRequested: "Voice call requested",
      watchCallRequested: "Pre-authorized watch event requested a voice call",
      callCompleted: "Voice call completed",
      approvalRequested: (tool) => `Voice approval requested for ${tool}`,
      approvalRepeated: (tool) => `Voice approval request repeated for ${tool}`,
      approvalDecision: (decision, tool) => `${decision === "allow" ? "Voice approval" : "Voice rejection"} for ${tool}`,
    },
    approval: {
      title: "Approval request.",
      tool: (tool) => `Tool: ${tool}.`,
      arguments: (value) => `Arguments: ${value}.`,
      preview: (value) => `Preview: ${value}.`,
      instruction: "Say approve to run it, reject to deny it, or repeat to hear this request again.",
      notUnderstood: "I did not understand. Say only approve, reject, or repeat.",
      readingStatus: (tool) => `Steward is reading the approval request for ${tool}.`,
      waitingStatus: "Steward is waiting for approve, reject, or repeat.",
      deniedNote: () => "Rejected during the call.",
      recordedStatus: (decision) => decision === "allow" ? "Voice approval recorded." : "Voice rejection recorded.",
      alreadyResolvedStatus: "The approval was already resolved.",
      keywords: {
        allow: ["approve"],
        deny: ["reject"],
        repeat: ["repeat", "read it again", "read the request again"],
      },
    },
    callPrompt: (openingLine) => [
      "Start a voice call with the user now using mcp__voice__call_start.",
      `Say exactly this opening message: ${JSON.stringify(openingLine)}.`,
      "After each user reply, continue the same call with mcp__voice__converse.",
      "Speak English unless the user changes language; use one or two short sentences per turn.",
      "Do not use ask_user during the call: ask questions directly with converse.",
      "You may use Steward's read-only tools when needed.",
      "Only during this call, set_voice_speech_rate can change speaking speed for this call or propose a persistent default.",
      "Sensitive operations activate the host-owned voice approval protocol: wait for its decision without asking for or interpreting approval yourself, and never claim a denied action was completed.",
      "When the user says goodbye, hangs up, or the tool returns [CALL ENDED], finish with mcp__voice__call_end and end the turn.",
      "If call_start returns [NO ANSWER] or [CALL FAILED], do not retry; end the turn with a brief explanation.",
      "Do not answer only in chat: this turn must conduct the conversation by phone.",
    ].join(" "),
  },
  it: {
    defaultOpeningLine: "Ciao, sono Steward. Come posso aiutarti?",
    chatTitle: "Chiamata vocale",
    undefinedValue: "nessuno",
    status: {
      noTransport: "Nessun trasporto vocale configurato.",
      streamcoreUnavailable: "Il trasporto StreamCore è riservato ma non ancora implementato.",
      launcherMissing: "STEWARD_RINGBACK_LAUNCHER non è configurato.",
      unavailable: "Le chiamate vocali non sono disponibili.",
      duplicate: "Questo evento vocale è già stato avviato.",
      busy: "È già in corso una chiamata vocale.",
      checking: "Controllo del motore Ringback prima della chiamata.",
      preflightPassed: "Controllo preliminare di Ringback superato.",
      preflightRetrying: (attempt) => `Il tentativo preliminare ${attempt} di Ringback non è riuscito; nuovo controllo sicuro.`,
      preparing: "Ringback è pronto; Steward sta preparando la chiamata.",
      ringing: "Chiamata al telefono in corso; attendo la risposta.",
      speaking: "Steward sta parlando e attende la prossima risposta.",
      listening: "Steward è in ascolto.",
      ending: "Steward sta terminando la chiamata.",
      processing: "Steward sta elaborando la richiesta.",
      replyReceived: "Steward ha ricevuto la risposta e la sta elaborando.",
      callEnded: "La chiamata telefonica è terminata.",
      lastCompleted: "L'ultima chiamata è terminata.",
      lastFailed: "L'ultima chiamata non è riuscita.",
      agentFailed: "Il turno dell'agente vocale non è riuscito.",
      noDial: "Il turno vocale automatico è terminato senza avviare una chiamata.",
      approvalNoSession: "L'approvazione vocale non ha una sessione attiva.",
    },
    audit: {
      callRequested: "Chiamata vocale richiesta",
      watchCallRequested: "Un evento preautorizzato del watcher ha richiesto una chiamata vocale",
      callCompleted: "Chiamata vocale completata",
      approvalRequested: (tool) => `Approvazione vocale richiesta per ${tool}`,
      approvalRepeated: (tool) => `Richiesta di approvazione vocale riletta per ${tool}`,
      approvalDecision: (decision, tool) => `${decision === "allow" ? "Approvazione vocale" : "Rifiuto vocale"} per ${tool}`,
    },
    approval: {
      title: "Richiesta di approvazione.",
      tool: (tool) => `Strumento: ${tool}.`,
      arguments: (value) => `Argomenti: ${value}.`,
      preview: (value) => `Anteprima: ${value}.`,
      instruction: "Di approva per eseguirla, rifiuta per negarla, oppure ripeti per riascoltare questa richiesta.",
      notUnderstood: "Non ho capito. Di soltanto approva, rifiuta oppure ripeti.",
      readingStatus: (tool) => `Steward sta leggendo la richiesta di approvazione per ${tool}.`,
      waitingStatus: "Steward attende approva, rifiuta oppure ripeti.",
      deniedNote: () => "Rifiutata durante la chiamata.",
      recordedStatus: (decision) => decision === "allow" ? "Approvazione vocale registrata." : "Rifiuto vocale registrato.",
      alreadyResolvedStatus: "La richiesta di approvazione era già stata risolta.",
      keywords: {
        allow: ["approva"],
        deny: ["rifiuta"],
        repeat: ["ripeti", "ripetilo", "rileggi", "rileggi la richiesta"],
      },
    },
    callPrompt: (openingLine) => [
      "Avvia ora una chiamata vocale con l'utente usando mcp__voice__call_start.",
      `Pronuncia come apertura esattamente questo messaggio: ${JSON.stringify(openingLine)}.`,
      "Dopo ogni risposta dell'utente, continua la stessa chiamata con mcp__voice__converse.",
      "Parla in italiano salvo che l'utente cambi lingua; usa una o due frasi brevi per turno.",
      "Non usare ask_user durante la telefonata: fai le domande direttamente con converse.",
      "Puoi usare gli strumenti di sola lettura di Steward quando servono.",
      "Solo durante questa chiamata, set_voice_speech_rate può cambiare la velocità del parlato per la chiamata corrente o proporre un nuovo valore predefinito persistente.",
      "Le operazioni sensibili attivano il sottoprotocollo vocale dell'host: attendi la decisione senza chiederla o interpretarla tu e non dichiarare eseguita un'azione negata.",
      "Quando l'utente saluta, riaggancia o il tool restituisce [CALL ENDED], termina con mcp__voice__call_end e concludi il turno.",
      "Se call_start restituisce [NO ANSWER] o [CALL FAILED], non riprovare: concludi il turno spiegando brevemente il problema.",
      "Non rispondere soltanto in chat: lo scopo di questo turno è svolgere la conversazione al telefono.",
    ].join(" "),
  },
} satisfies Record<VoiceLang, VoiceMessages>;

export function voiceMessages(lang: VoiceLang): VoiceMessages {
  return MESSAGES[lang] ?? MESSAGES.en;
}

const LEGACY_DEFAULT_OPENING_LINES = new Set([
  MESSAGES.en.defaultOpeningLine,
  MESSAGES.it.defaultOpeningLine,
]);

/** Empty and formerly hard-coded defaults follow the current user locale. */
export function localizedOpeningLine(configured: string | undefined, lang: VoiceLang): string {
  const value = configured?.trim();
  return !value || LEGACY_DEFAULT_OPENING_LINES.has(value) ? voiceMessages(lang).defaultOpeningLine : value;
}
