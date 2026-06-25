/**
 * Apple Mail deep link for a message. Clicking it opens the message in Mail.app.
 * Apple Mail registers the `message:` URL scheme and resolves the RFC Message-ID
 * (wrapped in angle brackets, URL-encoded as %3C…%3E) internally — so it works
 * regardless of which account/mailbox the message lives in (incl. Gmail All Mail).
 */
export function mailUrl(messageId: string): string {
  return `message://%3C${messageId}%3E`;
}
