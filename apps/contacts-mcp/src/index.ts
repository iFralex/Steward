#!/usr/bin/env node
import { existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AddressBookStore } from "./addressbook-store.ts";
import { IndexDb } from "./index-db.ts";
import { hybridSearch } from "./search.ts";
import { resolveRecipient } from "./resolve.ts";
import { loadEmbedConfig } from "./embed-config.ts";
import { embedText } from "@llm-wiki/search";
import { createContact, updateContact } from "./applescript.ts";
import { parseSearchArgs, parseResolveArgs, parseCreateArgs, parseUpdateArgs, requireString } from "./args.ts";
import { sourceDbPaths, indexDbPath } from "./paths.ts";

const paths = sourceDbPaths();
const store = paths.length ? AddressBookStore.load(paths) : null;
const index = existsSync(indexDbPath()) ? IndexDb.open(indexDbPath()) : null;
if (index) index.vectors.enable();
const embedCfg = loadEmbedConfig();
const embedQuery = embedCfg ? (t: string) => embedText(t, embedCfg) : undefined;
const search = (q: string, limit: number) => index ? hybridSearch({ index, embedQuery }, q, limit) : Promise.resolve([]);

const server = new Server({ name: "contacts", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "search_contacts", description: "Search contacts (hybrid keyword+semantic).", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false } },
    { name: "read_contact", description: "Read one contact by uid.", inputSchema: { type: "object", properties: { uid: { type: "string" } }, required: ["uid"], additionalProperties: false } },
    { name: "resolve_recipient", description: "Resolve a free-text description (e.g. 'the accountant') to ranked email-bearing candidates. Returns candidates for confirmation; does not auto-pick.", inputSchema: { type: "object", properties: { description: { type: "string" }, limit: { type: "number" } }, required: ["description"], additionalProperties: false } },
    { name: "create_contact", description: "Create a contact. Needs at least a name or organization.", inputSchema: { type: "object", properties: {
      firstName: { type: "string" }, lastName: { type: "string" }, organization: { type: "string" }, nickname: { type: "string" }, note: { type: "string" },
      emails: { type: "array", items: { type: "object", properties: { address: { type: "string" }, label: { type: "string" } }, required: ["address"] } },
      phones: { type: "array", items: { type: "object", properties: { number: { type: "string" }, label: { type: "string" } }, required: ["number"] } } }, additionalProperties: false } },
    { name: "update_contact", description: "Update a contact by its Contacts app id (personId).", inputSchema: { type: "object", properties: {
      personId: { type: "string" }, firstName: { type: "string" }, lastName: { type: "string" }, organization: { type: "string" }, nickname: { type: "string" }, note: { type: "string" },
      emails: { type: "array", items: { type: "object", properties: { address: { type: "string" }, label: { type: "string" } }, required: ["address"] } },
      phones: { type: "array", items: { type: "object", properties: { number: { type: "string" }, label: { type: "string" } }, required: ["number"] } } }, required: ["personId"], additionalProperties: false } },
  ],
}));

function ok(data: unknown) { return { content: [{ type: "text", text: JSON.stringify(data) }] }; }

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const raw = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (req.params.name) {
      case "search_contacts": {
        if (!store) throw new Error("No AddressBook stores found. Grant Full Disk Access.");
        const a = parseSearchArgs(raw);
        const uids = index ? await search(a.query, a.limit) : [];
        return ok(uids.map((u) => store.getContact(u)).filter(Boolean).slice(0, a.limit));
      }
      case "read_contact": {
        if (!store) throw new Error("No AddressBook stores found. Grant Full Disk Access.");
        return ok(store.getContact(requireString(raw, "uid")) ?? null);
      }
      case "resolve_recipient": {
        if (!store) throw new Error("No AddressBook stores found. Grant Full Disk Access.");
        const a = parseResolveArgs(raw);
        return ok(await resolveRecipient({ search, getContact: (u) => store.getContact(u) }, a.description, a.limit));
      }
      case "create_contact": return ok({ id: await createContact(parseCreateArgs(raw)) });
      case "update_contact": { await updateContact(parseUpdateArgs(raw)); return ok({ ok: true }); }
      default: throw new McpError(ErrorCode.MethodNotFound, `unknown tool ${req.params.name}`);
    }
  } catch (e) {
    if (e instanceof McpError) throw e;
    throw new McpError(ErrorCode.InternalError, e instanceof Error ? e.message : String(e));
  }
});

await server.connect(new StdioServerTransport());
