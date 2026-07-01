#!/usr/bin/env node
/**
 * Shell MCP — limited, safe shell access for the agent.
 *
 * Tools:
 *  - find_files       (read)  locate files on disk (Spotlight) to attach/inspect
 *  - run_command      (read)  run one allowlisted read-only binary (no shell)
 *  - run_write_command (write) run one allowlisted mutating binary — the HOST
 *                             gates this behind user approval (see tool-policy)
 *
 * No shell is ever spawned: args are an explicit array, so `|`, `>`, `;`, `$()`
 * are inert. See ./exec.ts for the binary allowlist + sensitive-path guard.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { READ_BINARIES, WRITE_BINARIES, runCommand, runPipeline, type Stage } from "./exec.ts";
import { findFiles, type FindArgs } from "./find.ts";

const server = new Server({ name: "shell", version: "0.0.0" }, { capabilities: { tools: {} } });

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
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
        `Run ONE read-only command with an explicit argument array. There is NO shell: pipes/redirects/globs (| > * ; $()) are NOT interpreted, so you canNOT do "ls | head". Output is TRUNCATED to ~120 lines — narrow it with the command's own flags instead of dumping everything: e.g. newest file → "ls -t <dir>" (newest first, read the first line); recent files → "find <dir> -type f -mtime -7"; limited matches → "grep -m 20 …". Allowed commands: ${[...READ_BINARIES].join(", ")}. Sensitive paths are blocked.`,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The binary to run (must be in the allowed list)" },
          args: { type: "array", items: { type: "string" }, description: "Arguments as an array (each a separate argv element)" },
          cwd: { type: "string", description: "Working directory (absolute path or ~/…)" },
          maxLines: { type: "number", description: "Max stdout lines to return (default 120). Only raise it when you truly need more; keep it small to save context." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    {
      name: "run_pipeline",
      description:
        `Run a read-only PIPELINE: each stage's stdout feeds the next stage's stdin, like a shell '|' — but there is NO shell, so it's safe and each stage must be an allowlisted read binary with explicit args. Use it to compose (filter/limit/count). Example — newest file in Downloads: {"stages":[{"command":"ls","args":["-t","~/Downloads"]},{"command":"head","args":["-1"]}]}. Newest PDF: add {"command":"grep","args":["-i","\\\\.pdf$"]} before head. Count: end with {"command":"wc","args":["-l"]}. Allowed commands: ${[...READ_BINARIES].join(", ")}. Max 6 stages; output truncated (~120 lines).`,
      inputSchema: {
        type: "object",
        properties: {
          stages: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                command: { type: "string", description: "Allowlisted read binary for this stage" },
                args: { type: "array", items: { type: "string" }, description: "Arguments as an array" },
              },
              required: ["command"],
              additionalProperties: false,
            },
            description: "Pipeline stages, left to right",
          },
          cwd: { type: "string", description: "Working directory (absolute path or ~/…)" },
          maxLines: { type: "number", description: "Max stdout lines to return (default 120)" },
        },
        required: ["stages"],
        additionalProperties: false,
      },
    },
    {
      name: "run_write_command",
      description:
        `Run ONE file-mutating command (create/copy/move/delete). Requires user approval. Explicit argument array, no shell. Allowed commands: ${[...WRITE_BINARIES].join(", ")}. Sensitive paths are blocked.`,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The mutating binary (must be in the allowed write list)" },
          args: { type: "array", items: { type: "string" }, description: "Arguments as an array" },
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
      return ok(await runCommand(command, strArr(raw.args), { mode: "read", cwd: str(raw.cwd), maxLines }));
    }
    case "run_pipeline": {
      const stages: Stage[] = Array.isArray(raw.stages)
        ? raw.stages.filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
            .map((s) => ({ command: String((s as Record<string, unknown>).command ?? ""), args: strArr((s as Record<string, unknown>).args) }))
        : [];
      const maxLines = typeof raw.maxLines === "number" ? raw.maxLines : undefined;
      return ok(await runPipeline(stages, { cwd: str(raw.cwd), maxLines }));
    }
    case "run_write_command": {
      const command = str(raw.command);
      if (!command) throw new Error("command is required");
      return ok(await runCommand(command, strArr(raw.args), { mode: "write", cwd: str(raw.cwd) }));
    }
    default:
      throw new Error(`unknown tool: ${req.params.name}`);
  }
});

await server.connect(new StdioServerTransport());
