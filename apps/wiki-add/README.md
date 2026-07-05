# wiki-add

Add files/folders on disk to the current **LLM Wiki** project — the backend for
the Finder "Aggiungi a LLM Wiki" Quick Actions.

## What it does

Copies the selection into the project's `raw/sources/` (a **snapshot**), then
asks the running app to rescan (the wiki extracts text from PDF/Office/… and
embeds it). If the app is closed, the files are ingested on its next open.

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
wiki-add <file|folder> ...        add (folders mirror; loose files go flat)
wiki-add --pick <folder> ...      native multi-select picker, then add chosen
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
