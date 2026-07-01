#!/usr/bin/env node
/**
 * Shell MCP — limited, safe shell access for the agent.
 *
 * Tools:
 *  - find_files        (read)  locate files on disk (Spotlight) to attach/inspect
 *  - run_command       (read)  a read-only command line, pipes allowed
 *  - run_write_command (write) a file-mutating command line — the HOST gates it
 *                              behind user approval (see tool-policy)
 *
 * The command line uses normal shell syntax (words, quotes, `|` pipes), but NO
 * shell is ever spawned: we parse it ourselves and spawn each stage as an
 * allowlisted binary with explicit argv — so `;`, `>`, `$()`, backticks never
 * execute. See ./exec.ts for the parser, binary allowlist + sensitive-path guard.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { READ_BINARIES, WRITE_BINARIES, runCommandLine } from "./exec.ts";
import { findFiles, type FindArgs } from "./find.ts";

const server = new Server({ name: "shell", version: "0.0.0" }, { capabilities: { tools: {} } });

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "find_files",
      description:
        "Find files on disk by name or Spotlight query (searches everywhere you have access; sensitive paths like ~/.ssh are excluded). Returns absolute paths you can then attach to an email (send_email/reply `attachments`) or read. Provide `name` (filename substring) or `query` (free text).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Filename substring (Spotlight name match)" },
          query: { type: "string", description: "Free-text Spotlight query (name + content + metadata)" },
          root: { type: "string", description: "Restrict to this directory subtree (absolute path or ~/…)" },
          extension: { type: "string", description: "Keep only this file extension, e.g. 'pdf'" },
          modifiedAfter: { type: "string", description: "Keep only files modified at/after this ISO date" },
          limit: { type: "number", description: "Max results (default 50, max 500)" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "run_command",
      description:
        `Run a read-only command line, written in NORMAL shell syntax with pipes — e.g. "ls -t ~/Downloads | head -1" (newest file), "ls -1 ~/Downloads | grep -i '\\.pdf$' | head -1" (newest PDF), "find ~/Documents -name '*.log' | wc -l" (count). Only '|' is supported (no ; && > < redirects, no $()/backticks, no glob/$VAR expansion — quote patterns and let find/grep handle them). No shell is spawned; each stage must be an allowed command: ${[...READ_BINARIES].join(", ")}. Sensitive paths blocked; output truncated to ~120 lines (compose "| head -N" to get exactly what you need).`,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "A command line, e.g. \"ls -t ~/Downloads | head -1\"" },
          cwd: { type: "string", description: "Working directory (absolute path or ~/…)" },
          maxLines: { type: "number", description: "Max stdout lines to return (default 120)" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    {
      name: "run_write_command",
      description:
        `Run a file-mutating command line (create/copy/move/delete). Requires user approval. Normal shell syntax with '|' pipes, but no shell is spawned. Mutating commands allowed: ${[...WRITE_BINARIES].join(", ")} (read commands may also appear as earlier stages). Sensitive paths are blocked. E.g. "mkdir -p ~/Documents/archive", "mv ~/Downloads/report.pdf ~/Documents/".`,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "A command line, e.g. \"mv ~/Downloads/a.pdf ~/Documents/\"" },
          cwd: { type: "string", description: "Working directory (absolute path or ~/…)" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  ],
}));

function ok(data: unknown) { return { content: [{ type: "text", text: JSON.stringify(data) }] }; }

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const raw = (req.params.arguments ?? {}) as Record<string, unknown>;
  switch (req.params.name) {
    case "find_files":
      return ok(await findFiles(raw as FindArgs));
    case "run_command": {
      const command = str(raw.command);
      if (!command) throw new Error("command is required");
      const maxLines = typeof raw.maxLines === "number" ? raw.maxLines : undefined;
      return ok(await runCommandLine(command, "read", { cwd: str(raw.cwd), maxLines }));
    }
    case "run_write_command": {
      const command = str(raw.command);
      if (!command) throw new Error("command is required");
      return ok(await runCommandLine(command, "write", { cwd: str(raw.cwd) }));
    }
    default:
      throw new Error(`unknown tool: ${req.params.name}`);
  }
});

await server.connect(new StdioServerTransport());
