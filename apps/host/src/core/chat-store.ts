/**
 * Persistent multi-chat store (SQLite). Holds chat metadata + the rendered UI
 * transcript so conversations survive reloads and host restarts. Each chat also
 * references a Pi session file (agent memory), persisted separately by Pi.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatSummary, PersistedMessage } from "@llm-wiki/protocol";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  session_file TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, seq);
`;

export const DEFAULT_CHAT_TITLE = "Nuova chat";

export class ChatStore {
  readonly raw: Database.Database;
  readonly sessionDir: string;

  constructor(db: Database.Database, sessionDir: string) {
    this.raw = db;
    this.sessionDir = sessionDir;
    this.raw.pragma("journal_mode = WAL");
    this.raw.exec(SCHEMA);
  }

  static open(): ChatStore {
    const dir = process.env.CHATS_DIR ?? join(homedir(), "Library", "Application Support", "llmwiki-chats");
    const sessionDir = join(dir, "sessions");
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    return new ChatStore(new Database(join(dir, "chats.db")), sessionDir);
  }

  listChats(): ChatSummary[] {
    return this.raw.prepare(
      `SELECT c.id, c.title, c.created_at createdAt, c.updated_at updatedAt,
              (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) messageCount
       FROM chats c ORDER BY c.updated_at DESC`,
    ).all() as ChatSummary[];
  }

  createChat(title?: string): ChatSummary {
    const now = Date.now();
    const id = randomUUID();
    this.raw.prepare(
      `INSERT INTO chats (id, title, session_file, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`,
    ).run(id, title?.trim() || DEFAULT_CHAT_TITLE, now, now);
    return { id, title: title?.trim() || DEFAULT_CHAT_TITLE, createdAt: now, updatedAt: now, messageCount: 0 };
  }

  exists(chatId: string): boolean {
    return !!this.raw.prepare(`SELECT 1 FROM chats WHERE id = ?`).get(chatId);
  }

  getTitle(chatId: string): string | null {
    const row = this.raw.prepare(`SELECT title FROM chats WHERE id = ?`).get(chatId) as { title: string } | undefined;
    return row?.title ?? null;
  }

  rename(chatId: string, title: string): void {
    this.raw.prepare(`UPDATE chats SET title = ?, updated_at = ? WHERE id = ?`).run(title.trim() || DEFAULT_CHAT_TITLE, Date.now(), chatId);
  }

  /** Auto-name an untitled chat from its first user message. */
  maybeAutoTitle(chatId: string, firstText: string): void {
    const cur = this.getTitle(chatId);
    if (cur && cur !== DEFAULT_CHAT_TITLE) return;
    const title = firstText.trim().replace(/\s+/g, " ").slice(0, 60);
    if (title) this.raw.prepare(`UPDATE chats SET title = ? WHERE id = ?`).run(title, chatId);
  }

  deleteChat(chatId: string): void {
    this.raw.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(chatId);
    this.raw.prepare(`DELETE FROM chats WHERE id = ?`).run(chatId);
  }

  getSessionFile(chatId: string): string | null {
    const row = this.raw.prepare(`SELECT session_file FROM chats WHERE id = ?`).get(chatId) as { session_file: string | null } | undefined;
    return row?.session_file ?? null;
  }

  setSessionFile(chatId: string, file: string): void {
    this.raw.prepare(`UPDATE chats SET session_file = ? WHERE id = ?`).run(file, chatId);
  }

  getMessages(chatId: string): PersistedMessage[] {
    const rows = this.raw.prepare(
      `SELECT id, role, text, payload FROM messages WHERE chat_id = ? ORDER BY seq ASC`,
    ).all(chatId) as { id: string; role: string; text: string; payload: string | null }[];
    return rows.map((r) => {
      const extra = r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : {};
      return { id: r.id, role: r.role as PersistedMessage["role"], text: r.text, ...extra } as PersistedMessage;
    });
  }

  /** Append a message to a chat's transcript; bumps the chat's updated_at. */
  addMessage(chatId: string, msg: PersistedMessage): void {
    const now = Date.now();
    const seq = (this.raw.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 n FROM messages WHERE chat_id = ?`).get(chatId) as { n: number }).n;
    const { id, role, text, ...rest } = msg;
    this.raw.prepare(
      `INSERT OR REPLACE INTO messages (id, chat_id, seq, role, text, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, chatId, seq, role, text, Object.keys(rest).length ? JSON.stringify(rest) : null, now);
    this.raw.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`).run(now, chatId);
  }
}

let singleton: ChatStore | undefined;
export function chatStore(): ChatStore {
  return (singleton ??= ChatStore.open());
}
