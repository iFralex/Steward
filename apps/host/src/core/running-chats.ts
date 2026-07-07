/**
 * Process-wide "is this chat currently generating" signal — deliberately
 * separate from any single ChatManager instance (each WebSocket connection,
 * plus /quick-send's headless runner, owns its own ChatManager and its own
 * `emit`). Any connection that selects a chat can check this to show a
 * "running" status even when the turn is being driven by a completely
 * different connection/mechanism. Purely in-memory and ephemeral — a host
 * restart means no turn is in flight anyway.
 */
const running = new Set<string>();

export function markRunning(chatId: string): void {
  running.add(chatId);
}

export function markIdle(chatId: string): void {
  running.delete(chatId);
}

export function isRunning(chatId: string): boolean {
  return running.has(chatId);
}
