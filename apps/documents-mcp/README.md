# Documents MCP

Read-only local document extraction and bounded hybrid search for Steward.

## Tools

- `document_info`: metadata, page/character counts, warnings, and up to 50 headings.
- `document_read`: cursor-based reading, 6,000 characters and one page by default; hard caps of 12,000 characters and three pages.
- `document_search`: full-document lexical search fused with semantic embeddings when the gateway is available. Results contain only bounded excerpts and cursors for `document_read`.

Supported formats are PDF, Markdown and other UTF-8 text/data formats, HTML, RTF, DOCX, PPTX, and ODT. Image-only PDFs report `no_extractable_text`; OCR is intentionally not automatic.

## Safety and limits

- absolute, canonical paths only;
- shared `@steward/sensitive-path` checks before and after symlink resolution;
- regular files and allow-listed extensions only;
- 25 MB default size limit (`DOCUMENT_MAX_BYTES`, capped at 100 MB);
- 15 second extraction timeout (`DOCUMENT_EXTRACT_TIMEOUT_MS`, capped at 60 seconds);
- extracted documents and vectors are cached only in the MCP process memory.

Embeddings default to Steward's gateway and are attributed as service `documents-mcp`, action `search-embed`. Override with `DOCUMENT_EMBED_ENDPOINT`, `DOCUMENT_EMBED_MODEL`, `DOCUMENT_EMBED_API_KEY`, and `DOCUMENT_EMBED_DIM`; set `DOCUMENT_EMBED_ENDPOINT=off` for lexical-only search.

The host's common MCP wrapper records every `document_info`, `document_read`, and `document_search` execution in both the Usage ledger and Audit log, including duration, outcome, inputs, bounded output, and file source references.
