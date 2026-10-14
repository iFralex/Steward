# wiki-add

Add files/folders on disk to the current **LLM Wiki** project — the backend for
the Finder "Aggiungi a LLM Wiki" Quick Actions.

## What it does

Copies the selection into the project's `raw/sources/` (a **snapshot**), then
asks the running app to rescan. Successful copying is separate from wiki
extraction/ingest and optional embedding. If the app/API is unavailable, the
copies remain and `rescanned` is false; request a rescan later or let the wiki's
configured Source Watch discover them.

- **Folders mirror their structure** under `raw/sources/<folder>/…` (the wiki's
  rescan walks subdirectories), so nothing is flattened.
- Skips junk (`node_modules`, `.git`, build dirs, …), hidden files,
  non-ingestible types, and oversized files.
- **De-duplicates re-adds by origin path** via `.llmwiki-added.json` at the
  project root: re-adding an edited file overwrites its previous copy (update);
  same-name files from different folders get `" (2)"`.

The target project is the app's last-opened one (override: `WIKI_PROJECT_PATH`).

## CLI

```
wiki-add <file|folder> ...        add with native destination/name selection
wiki-add --pick <file|folder> ... select candidates, then choose destination
wiki-add --list <folder> ...      print ingestible candidates (one path per line)
wiki-add --root <dir> <file> ...  add files mirrored relative to <dir>
```

## Finder Quick Actions

```
npm run install-quick-actions -w @steward/wiki-add
```

Installs two macOS Services into `~/Library/Services`:

- **Aggiungi a LLM Wiki** — add the selection.
- **Aggiungi a LLM Wiki — Scegli…** — pick which files from a folder.

Right-click a file/folder in Finder → **Quick Actions**.

**Keyboard shortcut (one-time, manual):** System Settings → Keyboard → Keyboard
Shortcuts → **Services** → General → tick each item and set a shortcut (e.g.
⌃⌥⌘L). macOS stores Service shortcuts in a `pbs` preference whose key format
(`(null) - <name> - runWorkflowAsService`) both `defaults` and `PlistBuddy`
refuse to write, and it needs a re-login to take effect — so it can't be set
reliably from a script.

Override the invocation baked into the scripts with `WIKI_ADD_CMD` (e.g. the
bundled build's `node` + compiled entry).

## Destination and collision behavior

Single-item imports open a native Save As panel for name/location; multiple
items choose one shared destination folder. A picker can reduce folder contents
first. Destination ancestors are canonicalized and must remain inside `raw/sources/`;
symlink escapes and traversal are rejected, collection does not follow symlinks; cancelling or
choosing outside it returns without copying. `--root` is the explicit
noninteractive path that mirrors relative structure. Run the source CLI from
the repo root as `node --import tsx apps/wiki-add/src/index.ts ...`.

The `.llmwiki-added.json` manifest maps each origin path to its previous relative
destination. Ordinary re-add updates that path. Explicit selection in the panel
or `--root` relocates the tracked copy, publishes the new reference and then
removes the old snapshot when no other tracked origin references it. Shared
deduplicated snapshots are preserved; changing one shared origin forks its copy.
Unrelated collisions still receive a suffix.
The shared `@steward/source-collision` package compares SHA-256 content hashes:

| Destination | Decision |
|---|---|
| Absent | Copy as a new source. |
| Byte-identical | Skip the copy and retain/record origin tracking. |
| Different, tracked origin | Replace the tracked source as an update. |
| Different, unrelated origin | Choose `name (2).ext`, then the next available suffix. |

The shared pure logic works in Node and wiki frontend import paths. The CLI
holds `.llmwiki-added.lock` per project, uses exclusive creation for unrelated
copies, temporary-file rename for tracked replacements and atomic manifest
publication. Collision races retry without overwriting unrelated files. The new
copy and manifest publish before old-copy cleanup: a crash may leave an orphan,
but not a reference to an unpublished destination. A stale lock fails closed;
verify the previous writer has stopped before removing it. These guarantees apply
to this CLI, not every independent writer or frontend import transaction.

Collection skips hidden files, known junk directories, unsupported extensions
and files above the 100 MiB default input cap. This importer supports more source
types than the read-only Documents MCP; copying a supported source is not a
promise of successful parsing by every downstream parser.

The rescan client uses `LLM_WIKI_API_BASE_URL` and `LLM_WIKI_API_TOKEN`; those are
wiki settings, independent of host pairing. JSON output separates added,
updated, unchanged, skipped and rescan status. Source copying is explicit local
user work and does not pass through the chat tool approval UI.

```sh
npm test -w @steward/wiki-add
npm test -w @steward/source-collision
```
