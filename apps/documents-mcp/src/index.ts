#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { extractDocument } from "./extraction.ts";
import { loadDocumentEmbedConfig } from "./embed-config.ts";
import { documentCursor, readDocumentPage } from "./output-budget.ts";
import { searchDocument } from "./search.ts";

const server = new Server({ name: "documents", version: "0.0.0" }, { capabilities: { tools: {} } });
const embedConfig = loadDocumentEmbedConfig();

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "document_info",
      description: "Inspect a local document without returning its full contents. Supports PDF, Markdown/text/data files, HTML, RTF, DOCX, PPTX and ODT. Returns page/character counts, warnings and a bounded heading outline. Use this before broad reading of an unfamiliar document.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path from an attachment or find_files result." } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "document_read",
      description: "Read one bounded segment of a local document. Defaults to 6000 characters and one page; hard limits are 12000 characters and three pages. Continue only with navigation.nextCursor when more text is materially needed. Prefer document_search for a targeted question instead of reading the document sequentially.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path from an attachment or find_files result." },
          page: { type: "number", description: "1-based page/slide number. Omit to start at page 1." },
          cursor: { type: "string", description: "Opaque cursor returned as navigation.nextCursor by a previous call." },
          max_chars: { type: "number", description: "Characters to return. Default 6000, hard maximum 12000." },
          max_pages: { type: "number", description: "Pages/slides to cross in this call. Default 1, hard maximum 3." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "document_search",
      description: "Search inside one local document using full-document lexical ranking plus semantic embeddings when the Steward embedding gateway is available. Returns compact excerpts and cursors, never the complete document. Pass a result cursor to document_read for surrounding text.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path from an attachment or find_files result." },
          query: { type: "string", description: "Natural-language question, phrase or keywords." },
          max_results: { type: "number", description: "Result excerpts. Default 5, hard maximum 10." },
          context_chars: { type: "number", description: "Characters per excerpt. Default 300, hard maximum 800." },
        },
        required: ["path", "query"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  try {
    const path = stringArg(args.path, "path");
    const document = await extractDocument(path);
    if (request.params.name === "document_info") return text(documentInfo(document));
    if (request.params.name === "document_read") return text(readDocumentPage(document, args));
    if (request.params.name === "document_search") {
      return text(await searchDocument(document, stringArg(args.query, "query"), args, embedConfig));
    }
    throw new Error(`unknown tool: ${request.params.name}`);
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
    };
  }
});

function documentInfo(document: Awaited<ReturnType<typeof extractDocument>>) {
  const totalChars = document.pages.reduce((sum, page) => sum + page.text.length, 0);
  const outline = document.headings.slice(0, 50).map(({ level, text, page, offset }) => ({
    level,
    text: text.slice(0, 200),
    page,
    cursor: documentCursor(document, page, offset),
  }));
  return {
    path: document.path,
    name: document.name,
    format: document.format,
    size: document.size,
    modifiedAt: document.modifiedAt,
    stats: { totalPages: document.pages.length, totalChars },
    outline,
    outlineTruncated: document.headings.length > outline.length,
    ...(document.warnings.length ? { warnings: document.warnings } : {}),
  };
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

await server.connect(new StdioServerTransport());
