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
    watchSummary: (details: { instruction: string; when: string; actions: string; continuation?: string }) => string;
    watchAction: (tool: string) => string;
    watchContinuation: (details: { outcomes: string[]; afterMinutes: number; maxAttempts: number }) => string;
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
  resumePrompt: (openingLine: string) => string;
  resumeOpeningLine: string;
  reconnectScheduled: string;
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
      watchSummary: ({ instruction, when, actions, continuation }) =>
        `At ${when}, ${instruction}. Authorized action: ${actions}.${continuation ? ` ${continuation}.` : ""}`,
      watchAction: (tool) => tool === "mcp__voice__call_start" ? "one phone call"
        : tool === "mcp__mail__send_email" ? "one email"
          : tool === "mcp__mail__reply" ? "one email reply"
            : tool === "mcp__calendar__create_event" ? "one new calendar event"
              : tool.replace(/^mcp__[^_]+__/, "").replaceAll("_", " "),
      watchContinuation: ({ outcomes, afterMinutes, maxAttempts }) => {
        const labels = outcomes.map((outcome) => ({
          not_answered: "not answered", busy: "busy", failed: "failed",
        } as Record<string, string>)[outcome] ?? outcome.replaceAll("_", " "));
        const attempts = Math.max(1, maxAttempts - 1);
        return `If it is ${labels.join(", ")}, retry ${attempts === 1 ? "once" : `${attempts} times`} after ${afterMinutes === 1 ? "one minute" : `${afterMinutes} minutes`}`;
      },
      instruction: "Say approve to run it, reject to deny it, or repeat to hear this request again.",
      notUnderstood: "I did not understand. Say only approve, reject, or repeat.",
      readingStatus: (tool) => `Steward is reading the approval request for ${tool}.`,
      waitingStatus: "Steward is waiting for approve, reject, or repeat.",
      deniedNote: (reason) => reason === "spoken-command"
        ? "Explicitly rejected during the call."
        : reason === "unrecognized-or-too-many-attempts"
          ? "I could not recognize a valid approval command; nothing was executed."
          : "Voice approval could not be completed; nothing was executed.",
      recordedStatus: (decision) => decision === "allow" ? "Voice approval recorded." : "Voice rejection recorded.",
      alreadyResolvedStatus: "The approval was already resolved.",
      keywords: {
        allow: ["approve", "i approve", "yes approve", "confirm"],
        deny: ["reject"],
        repeat: ["repeat", "read it again", "read the request again"],
      },
    },
    callPrompt: (openingLine) => [
      "Start a voice call with the user now using mcp__voice__call_start.",
      "Do not write any assistant text before calling call_start.",
      `Say exactly this opening message: ${JSON.stringify(openingLine)}.`,
      "After each user reply, continue the same call with mcp__voice__converse.",
      "Speak English unless the user changes language; use one or two short sentences per turn.",
      "Do not use ask_user during the call: ask questions directly with converse.",
      "You may use Steward's read-only tools when needed.",
      "If transcription is unclear in a way that changes an action, recipient, destination, time, or delivery channel, ask one short confirmation before creating or executing it.",
      "Only during this call, set_voice_speech_rate can change speaking speed for this call or propose a persistent default.",
      "Sensitive operations activate the host-owned voice approval protocol: wait for its decision without asking for or interpreting approval yourself, and never claim a denied action was completed.",
      "Do not ask a redundant conversational confirmation immediately before that formal protocol unless a material detail is ambiguous.",
      "When the user says goodbye, hangs up, or the tool returns [CALL ENDED], finish with mcp__voice__call_end and end the turn.",
      "Treat thanks plus a closing phrase as goodbye. After one [SILENCE], make at most one short check-in; after a second [SILENCE], call call_end immediately.",
      "If call_start returns [NO ANSWER] or [CALL FAILED], do not retry; end the turn with a brief explanation.",
      "Do not answer only in chat: this turn must conduct the conversation by phone.",
    ].join(" "),
    resumeOpeningLine: "The call was interrupted. I'm calling back so we can continue. What was the last thing you heard?",
    reconnectScheduled: "The call was interrupted; Steward will call back once.",
    resumePrompt: (openingLine) => [
      `Call the user now with mcp__voice__call_start and say exactly ${JSON.stringify(openingLine)}.`,
      "This is one recovery attempt in the same chat, not a new request.",
      "Use the recorded conversation and tool results only as context. Do not assume the user heard the last spoken sentence.",
      "Ask what the user last heard and confirm where to continue. Do not repeat a side-effecting tool call merely because the conversation was interrupted.",
      "Any interrupted or uncertain approval must be requested again through the host-owned approval protocol; never infer consent.",
      "Continue naturally with mcp__voice__converse. If this call also fails, do not redial again.",
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
      watchSummary: ({ instruction, when, actions, continuation }) =>
        `Alle ${when}, ${instruction}. Azione autorizzata: ${actions}.${continuation ? ` ${continuation}.` : ""}`,
      watchAction: (tool) => tool === "mcp__voice__call_start" ? "una chiamata"
        : tool === "mcp__mail__send_email" ? "una email"
          : tool === "mcp__mail__reply" ? "una risposta email"
            : tool === "mcp__calendar__create_event" ? "un nuovo evento di calendario"
              : tool.replace(/^mcp__[^_]+__/, "").replaceAll("_", " "),
      watchContinuation: ({ outcomes, afterMinutes, maxAttempts }) => {
        const labels = outcomes.map((outcome) => ({
          not_answered: "senza risposta", busy: "occupata", failed: "non riuscita",
        } as Record<string, string>)[outcome] ?? outcome.replaceAll("_", " "));
        const attempts = Math.max(1, maxAttempts - 1);
        return `Se risulta ${labels.join(", ")}, riprova ${attempts === 1 ? "una volta" : `${attempts} volte`} dopo ${afterMinutes === 1 ? "un minuto" : `${afterMinutes} minuti`}`;
      },
      instruction: "Di approva per eseguirla, rifiuta per negarla, oppure ripeti per riascoltare questa richiesta.",
      notUnderstood: "Non ho capito. Di soltanto approva, rifiuta oppure ripeti.",
      readingStatus: (tool) => `Steward sta leggendo la richiesta di approvazione per ${tool}.`,
      waitingStatus: "Steward attende approva, rifiuta oppure ripeti.",
      deniedNote: (reason) => reason === "spoken-command"
        ? "Rifiutata esplicitamente durante la chiamata."
        : reason === "unrecognized-or-too-many-attempts"
          ? "Non sono riuscito a riconoscere un comando di approvazione valido; non è stato eseguito nulla."
          : "Non è stato possibile completare l'approvazione vocale; non è stato eseguito nulla.",
      recordedStatus: (decision) => decision === "allow" ? "Approvazione vocale registrata." : "Rifiuto vocale registrato.",
      alreadyResolvedStatus: "La richiesta di approvazione era già stata risolta.",
      keywords: {
        allow: ["approva", "io approvo", "si approva", "confermo", "conferma", "confirma"],
        deny: ["rifiuta"],
        repeat: ["ripeti", "ripetilo", "rileggi", "rileggi la richiesta"],
      },
    },
    callPrompt: (openingLine) => [
      "Avvia ora una chiamata vocale con l'utente usando mcp__voice__call_start.",
      "Non scrivere alcun testo dell'assistente prima di chiamare call_start.",
      `Pronuncia come apertura esattamente questo messaggio: ${JSON.stringify(openingLine)}.`,
      "Dopo ogni risposta dell'utente, continua la stessa chiamata con mcp__voice__converse.",
      "Parla in italiano salvo che l'utente cambi lingua; usa una o due frasi brevi per turno.",
      "Non usare ask_user durante la telefonata: fai le domande direttamente con converse.",
      "Puoi usare gli strumenti di sola lettura di Steward quando servono.",
      "Se la trascrizione è incerta e può cambiare un'azione, destinatario, destinazione, orario o canale di consegna, chiedi una breve conferma prima di crearla o eseguirla.",
      "Solo durante questa chiamata, set_voice_speech_rate può cambiare la velocità del parlato per la chiamata corrente o proporre un nuovo valore predefinito persistente.",
      "Le operazioni sensibili attivano il sottoprotocollo vocale dell'host: attendi la decisione senza chiederla o interpretarla tu e non dichiarare eseguita un'azione negata.",
      "Non chiedere una conferma conversazionale ridondante subito prima del protocollo formale, salvo che un dettaglio importante sia ambiguo.",
      "Quando l'utente saluta, riaggancia o il tool restituisce [CALL ENDED], termina con mcp__voice__call_end e concludi il turno.",
      "Considera i ringraziamenti accompagnati da una chiusura come un saluto. Dopo un primo [SILENCE] fai al massimo un breve controllo; dopo il secondo [SILENCE] usa subito call_end.",
      "Se call_start restituisce [NO ANSWER] o [CALL FAILED], non riprovare: concludi il turno spiegando brevemente il problema.",
      "Non rispondere soltanto in chat: lo scopo di questo turno è svolgere la conversazione al telefono.",
    ].join(" "),
    resumeOpeningLine: "La chiamata si è interrotta. Ti richiamo per continuare. Qual è l'ultima cosa che hai sentito?",
    reconnectScheduled: "La chiamata si è interrotta; Steward richiamerà una volta.",
    resumePrompt: (openingLine) => [
      `Chiama ora l'utente con mcp__voice__call_start e pronuncia esattamente ${JSON.stringify(openingLine)}.`,
      "Questo è un solo tentativo di recupero nella stessa chat, non una nuova richiesta.",
      "Usa la conversazione e i risultati dei tool registrati solo come contesto. Non presumere che l'utente abbia sentito l'ultima frase pronunciata.",
      "Chiedi qual è l'ultima cosa sentita e conferma da dove continuare. Non ripetere un tool con effetti esterni solo perché la chiamata si è interrotta.",
      "Ogni approvazione interrotta o incerta va richiesta nuovamente tramite il protocollo dell'host; non presumere il consenso.",
      "Continua naturalmente con mcp__voice__converse. Se anche questa chiamata fallisce, non richiamare ancora.",
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
