/** Static push-notification body copy, in the two languages the web UI supports. */
import type { NotificationLang } from "./notification-lang.ts";

const COPY = {
  en: {
    testPush: "Push test — notifications work ✅",
    newChatReady: "New chat ready — tap to write ✍️",
    replyReady: "Reply ready",
    newProposal: "New proposal to approve",
  },
  it: {
    testPush: "Notifica di test — le push funzionano ✅",
    newChatReady: "Nuova chat pronta — tocca per scrivere ✍️",
    replyReady: "Risposta pronta",
    newProposal: "Nuova proposta da approvare",
  },
} as const satisfies Record<NotificationLang, Record<string, string>>;

export function notificationCopy(lang: NotificationLang) {
  return COPY[lang];
}
