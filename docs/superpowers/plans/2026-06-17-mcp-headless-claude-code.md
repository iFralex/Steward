# MCP Headless + Claude Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Far girare LLM Wiki come server MCP in background (finestra nascosta) usando Claude Code come LLM, con un tool MCP per alimentare documenti, tool MCP per mostrare/nascondere la finestra, e un backup periodico versionato del vault su GitHub privato.

**Architecture:** Quattro gruppi di task indipendenti e spedibili separatamente. Parte C e E aggiungono rotte all'API Rust (`api_server.rs`) e tool al server MCP Node (`mcp-server/`). Parte B legge un flag da `app-state.json` all'avvio Rust e nasconde la finestra impostando `ActivationPolicy::Accessory` su macOS. Parte D aggiunge un modulo Rust che fa backup git del vault su un timer. La Parte A (configurare il provider `claude-code` + embedding Ollama) è solo configurazione e non ha task qui: vedi la spec.

**Tech Stack:** Rust (Tauri 2, `tiny_http`, `serde_json`, `std::process::Command`), TypeScript (MCP SDK, `node:test`), React/Zustand per le impostazioni.

## Global Constraints

- API base path: tutte le rotte HTTP sono sotto `/api/v1` (costante `API_PREFIX` in `src-tauri/src/api_server.rs`).
- Solo metodi `GET` e `POST` sono accettati dal dispatcher (`handle_request`).
- Ogni rotta nuova passa già per: kill-switch `api_enabled`, auth `is_authorized`, rate-limit. Non reimplementarli.
- Le risposte usano i helper esistenti `ok(json!{...})` / `err(status, msg)` che ritornano `ApiResponse { status, body }`.
- La validazione path DEVE riusare `safe_join(project_path, rel)` (già testata) — mai costruire path a mano.
- I tool MCP testuali chiamano `await assertMcpEnabled()` prima di operare (eccetto `llm_wiki_status`).
- Test Rust: modulo `#[cfg(test)]` in fondo a `api_server.rs` (già esistente, vedi `safe_join_rejects_traversal`). Eseguiti con `cargo test` dentro `src-tauri`.
- Test MCP: `node:test` su file in `mcp-server/test/*.test.ts`, eseguiti con `npm test` in `mcp-server` (fa build + `node --test dist/test/*.test.js`).
- Commit frequenti, uno per task completato.

---

## PARTE C — Tool MCP `llm_wiki_add_source`

Scrive uno o più file in `raw/sources/` e (default) avvia il rescan, così un agente alimenta documenti con una sola chiamata.

### Task C1: Validazione del filename sorgente (Rust)

**Files:**
- Modify: `src-tauri/src/api_server.rs` (aggiungi `validate_source_filename` vicino a `safe_join`, ~riga 765; aggiungi i test nel modulo `#[cfg(test)]` in fondo)

**Interfaces:**
- Produces: `fn validate_source_filename(name: &str) -> Result<(), String>` — accetta un filename piatto valido per `raw/sources/`, rifiuta vuoto, separatori di path, `..`, prefisso `.`, e caratteri di controllo.

- [ ] **Step 1: Scrivi i test che falliscono**

Aggiungi nel modulo `#[cfg(test)] mod tests` in fondo a `src-tauri/src/api_server.rs`:

```rust
#[test]
fn validate_source_filename_accepts_plain_names() {
    assert!(validate_source_filename("note.md").is_ok());
    assert!(validate_source_filename("Report 2026.pdf").is_ok());
}

#[test]
fn validate_source_filename_rejects_separators_and_traversal() {
    assert!(validate_source_filename("").is_err());
    assert!(validate_source_filename("../escape.md").is_err());
    assert!(validate_source_filename("sub/dir.md").is_err());
    assert!(validate_source_filename("a\\b.md").is_err());
    assert!(validate_source_filename(".hidden").is_err());
    assert!(validate_source_filename("bad\u{0000}.md").is_err());
}
```

- [ ] **Step 2: Esegui i test per verificarne il fallimento**

Run: `cd src-tauri && cargo test validate_source_filename`
Expected: FAIL con "cannot find function `validate_source_filename`".

- [ ] **Step 3: Implementa la funzione**

Aggiungi vicino a `safe_join` in `src-tauri/src/api_server.rs`:

```rust
/// Validate a single source filename that will be written under
/// `raw/sources/`. Flat names only: no path separators, no `..`, no
/// leading dot, no control chars. Path safety is double-checked by
/// `safe_join` at write time; this gives a clear early error.
fn validate_source_filename(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("filename is required".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err(format!("filename must not contain path separators: {name}"));
    }
    if trimmed == ".." || trimmed.starts_with('.') {
        return Err(format!("invalid filename: {name}"));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(format!("filename contains control characters: {name}"));
    }
    Ok(())
}
```

- [ ] **Step 4: Esegui i test per verificarne il passaggio**

Run: `cd src-tauri && cargo test validate_source_filename`
Expected: PASS (2 test).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/api_server.rs
git commit -m "feat(api): add source filename validation"
```

### Task C2: Endpoint Rust `POST /projects/{id}/sources`

**Files:**
- Modify: `src-tauri/src/api_server.rs` (nuovo `handle_add_source`, nuove struct request, nuova riga nel `match`)

**Interfaces:**
- Consumes: `validate_source_filename` (Task C1), `resolve_project`, `safe_join`, `ok`/`err`, `commands::file_sync::rescan_project_files`, `load_source_watch_config` (già usati in `handle_rescan`).
- Produces: rotta `(&Method::Post, ["projects", project_id, "sources"]) => handle_add_source(app, project_id, body)`. Risposta JSON: `{ ok, projectId, written: [{filename, path, status}], rescan: <result|null> }` con `status` ∈ `"written" | "error"`.

- [ ] **Step 1: Scrivi il test che fallisce (parsing + normalizzazione single-file)**

Aggiungi al modulo test in `api_server.rs`:

```rust
#[test]
fn add_source_request_normalizes_single_file() {
    let single = r#"{ "filename": "a.md", "content": "hello" }"#;
    let req: AddSourceRequest = serde_json::from_str(single).unwrap();
    let items = req.normalized();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].filename, "a.md");
    assert_eq!(items[0].content, "hello");

    let batch = r#"{ "sources": [ {"filename":"a.md","content":"x"}, {"filename":"b.md","content":"y"} ], "rescan": false }"#;
    let req2: AddSourceRequest = serde_json::from_str(batch).unwrap();
    assert_eq!(req2.normalized().len(), 2);
    assert_eq!(req2.rescan, Some(false));
}
```

- [ ] **Step 2: Esegui per verificare il fallimento**

Run: `cd src-tauri && cargo test add_source_request_normalizes_single_file`
Expected: FAIL con "cannot find type `AddSourceRequest`".

- [ ] **Step 3: Implementa struct + handler + rotta**

Aggiungi le struct vicino a `SearchRequest` (cerca `struct SearchRequest`):

```rust
#[derive(Deserialize)]
struct SourceFileInput {
    filename: String,
    #[serde(default)]
    content: String,
}

#[derive(Deserialize)]
struct AddSourceRequest {
    // Batch form.
    #[serde(default)]
    sources: Vec<SourceFileInput>,
    // Single-file convenience form (top-level filename/content).
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    content: Option<String>,
    // Defaults to true at the handler.
    #[serde(default)]
    rescan: Option<bool>,
}

impl AddSourceRequest {
    fn normalized(&self) -> Vec<SourceFileInput> {
        let mut out: Vec<SourceFileInput> = self
            .sources
            .iter()
            .map(|s| SourceFileInput { filename: s.filename.clone(), content: s.content.clone() })
            .collect();
        if let Some(name) = &self.filename {
            out.push(SourceFileInput {
                filename: name.clone(),
                content: self.content.clone().unwrap_or_default(),
            });
        }
        out
    }
}
```

Aggiungi l'handler (vicino a `handle_rescan`):

```rust
fn handle_add_source(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let req: AddSourceRequest = match serde_json::from_str(body) {
        Ok(req) => req,
        Err(e) => return err(400, format!("Invalid JSON: {e}")),
    };
    let items = req.normalized();
    if items.is_empty() {
        return err(400, "Provide `sources` (array) or top-level `filename`/`content`");
    }

    let mut written = Vec::new();
    let mut any_ok = false;
    for item in &items {
        let entry = match validate_source_filename(&item.filename) {
            Ok(()) => {
                let rel = format!("raw/sources/{}", item.filename.trim());
                match safe_join(&project.path, &rel) {
                    Ok(abs) => {
                        let parent_ok = abs
                            .parent()
                            .map(|p| fs::create_dir_all(p).is_ok())
                            .unwrap_or(false);
                        if !parent_ok {
                            json!({ "filename": item.filename, "status": "error", "error": "could not create raw/sources" })
                        } else if let Err(e) = fs::write(&abs, item.content.as_bytes()) {
                            json!({ "filename": item.filename, "status": "error", "error": format!("write failed: {e}") })
                        } else {
                            any_ok = true;
                            json!({ "filename": item.filename, "status": "written", "path": rel })
                        }
                    }
                    Err(e) => json!({ "filename": item.filename, "status": "error", "error": e }),
                }
            }
            Err(e) => json!({ "filename": item.filename, "status": "error", "error": e }),
        };
        written.push(entry);
    }

    let mut rescan_result = Value::Null;
    if req.rescan.unwrap_or(true) && any_ok {
        let cfg = load_source_watch_config(app, &project.id);
        rescan_result = match commands::file_sync::rescan_project_files(
            app.clone(),
            project.id.clone(),
            project.path.clone(),
            cfg,
        ) {
            Ok(result) => json!({ "ok": true, "result": result }),
            Err(e) => json!({ "ok": false, "error": e }),
        };
    }

    ok(json!({
        "ok": true,
        "projectId": project.id,
        "written": written,
        "rescan": rescan_result,
    }))
}
```

Aggiungi la rotta nel `match (method, parts.as_slice())` subito sopra la rotta `sources/rescan`:

```rust
        (&Method::Post, ["projects", project_id, "sources"]) => {
            handle_add_source(app, project_id, body)
        }
```

- [ ] **Step 4: Esegui i test**

Run: `cd src-tauri && cargo test add_source && cargo build`
Expected: PASS sul test e build OK.

- [ ] **Step 5: Verifica manuale (app in esecuzione)**

Run:
```bash
curl -s -X POST http://127.0.0.1:19828/api/v1/projects/current/sources \
  -H 'Content-Type: application/json' \
  -d '{"sources":[{"filename":"mcp-test.md","content":"# Hello from MCP"}],"rescan":false}'
```
Expected: JSON con `"status":"written"` e il file presente in `raw/sources/mcp-test.md`. (Se l'API richiede token, aggiungi `-H "Authorization: Bearer <token>"`.)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/api_server.rs
git commit -m "feat(api): add POST /projects/:id/sources to write source files"
```

### Task C3: Metodo client MCP `addSources`

**Files:**
- Modify: `mcp-server/src/api-client.ts` (nuovo metodo + tipo)
- Test: `mcp-server/test/api-client.test.ts`

**Interfaces:**
- Produces: `async addSources(projectId, sources: Array<{filename: string; content: string}>, rescan?: boolean): Promise<Record<string, unknown>>` — POST a `/projects/{id}/sources` con body `{ sources, rescan }`.

- [ ] **Step 1: Scrivi il test che fallisce**

Aggiungi in `mcp-server/test/api-client.test.ts`:

```ts
test("addSources posts sources array and rescan flag", async () => {
  let body = ""
  let url = ""
  const fetchImpl = async (u: string | URL | Request, init?: RequestInit): Promise<Response> => {
    url = String(u)
    body = String(init?.body ?? "")
    return new Response(JSON.stringify({ ok: true, projectId: "p1", written: [], rescan: null }), { status: 200 })
  }
  const client = new LlmWikiApiClient({ baseUrl: "http://localhost:19828", fetchImpl })
  await client.addSources("current", [{ filename: "a.md", content: "x" }], false)

  assert.equal(url, "http://localhost:19828/api/v1/projects/current/sources")
  const parsed = JSON.parse(body)
  assert.equal(parsed.sources[0].filename, "a.md")
  assert.equal(parsed.rescan, false)
})
```

- [ ] **Step 2: Esegui per verificare il fallimento**

Run: `cd mcp-server && npm test`
Expected: FAIL — `client.addSources is not a function`.

- [ ] **Step 3: Implementa il metodo**

Aggiungi in `mcp-server/src/api-client.ts` dopo `rescan(...)`:

```ts
  async addSources(
    projectId = "current",
    sources: Array<{ filename: string; content: string }>,
    rescan = true,
  ): Promise<Record<string, unknown>> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/sources`, {
      method: "POST",
      body: { sources, rescan },
    })
  }
```

- [ ] **Step 4: Esegui i test**

Run: `cd mcp-server && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/api-client.ts mcp-server/test/api-client.test.ts
git commit -m "feat(mcp): add addSources API client method"
```

### Task C4: Tool MCP `llm_wiki_add_source`

**Files:**
- Modify: `mcp-server/src/index.ts` (definizione tool + case nello switch)

**Interfaces:**
- Consumes: `client.addSources` (Task C3), helper esistenti `asObject`, `projectId`, `boolArg`, `stringArg`, `textResult`, `assertMcpEnabled`.

- [ ] **Step 1: Aggiungi la definizione del tool**

Nell'array `tools` di `ListToolsRequestSchema` (dopo `llm_wiki_rescan_sources`):

```ts
    {
      name: "llm_wiki_add_source",
      description: "Add one or more source documents to a project's raw/sources/ folder and (by default) trigger ingest via rescan. Accepts a single file or a batch.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
          sources: {
            type: "array",
            description: "Files to add. Each item is {filename, content}.",
            items: {
              type: "object",
              properties: {
                filename: { type: "string", description: "Flat filename (no path separators), e.g. notes.md" },
                content: { type: "string", description: "UTF-8 file content." },
              },
              required: ["filename", "content"],
              additionalProperties: false,
            },
          },
          filename: { type: "string", description: "Single-file convenience: filename (use with `content`)." },
          content: { type: "string", description: "Single-file convenience: content (use with `filename`)." },
          rescan: { type: "boolean", description: "Trigger ingest rescan after writing. Defaults to true." },
        },
        additionalProperties: false,
      },
    },
```

- [ ] **Step 2: Aggiungi il case nello switch**

In `CallToolRequestSchema`, prima del `default:`:

```ts
      case "llm_wiki_add_source": {
        await assertMcpEnabled()
        const rawSources = Array.isArray(args.sources) ? args.sources : []
        const sources = rawSources.map((s) => {
          const o = asObject(s)
          return { filename: stringArg(o.filename, "filename"), content: stringArg(o.content, "content") }
        })
        const single = typeof args.filename === "string"
        if (single) {
          sources.push({ filename: stringArg(args.filename, "filename"), content: stringArg(args.content, "content") })
        }
        if (sources.length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "Provide `sources` (array) or `filename`+`content`.")
        }
        const result = await client.addSources(projectId(args), sources, boolArg(args.rescan, true))
        return textResult(JSON.stringify(result, null, 2))
      }
```

- [ ] **Step 3: Build per verificare la compilazione**

Run: `cd mcp-server && npm run build`
Expected: nessun errore TypeScript.

- [ ] **Step 4: Verifica manuale**

Con l'app avviata e l'MCP configurato in un client (es. Claude Code), invocare `llm_wiki_add_source` con `{ "filename": "from-agent.md", "content": "# Test" }` e verificare che il file compaia in `raw/sources/` e parta l'ingest.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/index.ts
git commit -m "feat(mcp): add llm_wiki_add_source tool"
```

---

## PARTE E — Tool MCP `show_window` / `hide_window`

Permette a un agente di mostrare o ri-nascondere la finestra in modalità background.

### Task E1: Endpoint Rust `POST /window/show` e `/window/hide`

**Files:**
- Modify: `src-tauri/src/api_server.rs` (due handler + due rotte)
- Modify: `src-tauri/src/tray.rs` (rendi pubblica `show_main_window` per riuso)

**Interfaces:**
- Consumes: `tray::show_main_window` (reso `pub(crate)`), `tauri::Manager`, `tauri::ActivationPolicy`.
- Produces: rotte `(&Method::Post, ["window", "show"])` e `(&Method::Post, ["window", "hide"])`; risposte `{ ok: true, shown|hidden: true }`.

- [ ] **Step 1: Rendi riusabile `show_main_window`**

In `src-tauri/src/tray.rs`, cambia la firma da:

```rust
fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
```
a:
```rust
pub(crate) fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
```

- [ ] **Step 2: Implementa gli handler e le rotte**

Aggiungi in `src-tauri/src/api_server.rs` (vicino a `handle_rescan`):

```rust
fn handle_window_show(app: &AppHandle) -> ApiResponse {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    crate::tray::show_main_window(app);
    ok(json!({ "ok": true, "shown": true }))
}

fn handle_window_hide(app: &AppHandle) -> ApiResponse {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    ok(json!({ "ok": true, "hidden": true }))
}
```

Aggiungi le rotte nel `match`:

```rust
        (&Method::Post, ["window", "show"]) => handle_window_show(app),
        (&Method::Post, ["window", "hide"]) => handle_window_hide(app),
```

- [ ] **Step 3: Build**

Run: `cd src-tauri && cargo build`
Expected: build OK. (Se `set_activation_policy` non è in scope, è un metodo di `AppHandle` su macOS — `app` è `&AppHandle`, quindi `app.set_activation_policy(...)` è corretto.)

- [ ] **Step 4: Verifica manuale (macOS, app in background)**

Run:
```bash
curl -s -X POST http://127.0.0.1:19828/api/v1/window/show
# la finestra appare; poi:
curl -s -X POST http://127.0.0.1:19828/api/v1/window/hide
```
Expected: la finestra compare e poi si nasconde; l'icona nel Dock appare/sparisce.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/api_server.rs src-tauri/src/tray.rs
git commit -m "feat(api): add window show/hide endpoints"
```

### Task E2: Metodi client + tool MCP per la finestra

**Files:**
- Modify: `mcp-server/src/api-client.ts` (due metodi)
- Modify: `mcp-server/src/index.ts` (due tool + due case)
- Test: `mcp-server/test/api-client.test.ts`

**Interfaces:**
- Produces: `async showWindow(): Promise<Record<string, unknown>>` e `async hideWindow(): Promise<Record<string, unknown>>` — POST a `/window/show` e `/window/hide`.

- [ ] **Step 1: Scrivi il test che fallisce**

Aggiungi in `mcp-server/test/api-client.test.ts`:

```ts
test("showWindow posts to /window/show", async () => {
  let url = ""
  let method = ""
  const fetchImpl = async (u: string | URL | Request, init?: RequestInit): Promise<Response> => {
    url = String(u)
    method = String(init?.method ?? "")
    return new Response(JSON.stringify({ ok: true, shown: true }), { status: 200 })
  }
  const client = new LlmWikiApiClient({ baseUrl: "http://localhost:19828", fetchImpl })
  await client.showWindow()
  assert.equal(url, "http://localhost:19828/api/v1/window/show")
  assert.equal(method, "POST")
})
```

- [ ] **Step 2: Esegui per verificare il fallimento**

Run: `cd mcp-server && npm test`
Expected: FAIL — `client.showWindow is not a function`.

- [ ] **Step 3: Implementa i metodi**

Aggiungi in `mcp-server/src/api-client.ts` dopo `addSources`:

```ts
  async showWindow(): Promise<Record<string, unknown>> {
    return this.request(`/window/show`, { method: "POST" })
  }

  async hideWindow(): Promise<Record<string, unknown>> {
    return this.request(`/window/hide`, { method: "POST" })
  }
```

- [ ] **Step 4: Aggiungi i tool e i case in `index.ts`**

Definizioni (dopo `llm_wiki_add_source`):

```ts
    {
      name: "llm_wiki_show_window",
      description: "Bring the LLM Wiki desktop window to the foreground (useful when the app runs hidden in background mode).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "llm_wiki_hide_window",
      description: "Hide the LLM Wiki desktop window again, returning the app to background mode.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
```

Case (prima del `default:`):

```ts
      case "llm_wiki_show_window": {
        await assertMcpEnabled()
        return textResult(JSON.stringify(await client.showWindow(), null, 2))
      }
      case "llm_wiki_hide_window": {
        await assertMcpEnabled()
        return textResult(JSON.stringify(await client.hideWindow(), null, 2))
      }
```

- [ ] **Step 5: Test + build**

Run: `cd mcp-server && npm test`
Expected: PASS (incluso il nuovo test) e build OK.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/api-client.ts mcp-server/src/index.ts mcp-server/test/api-client.test.ts
git commit -m "feat(mcp): add show_window/hide_window tools"
```

---

## PARTE B — Modalità background headless

All'avvio, se `backgroundMode` è attivo, la finestra resta nascosta e su macOS l'app diventa `Accessory` (niente Dock/focus). Toggle in Impostazioni + autostart.

### Task B1: Leggere `backgroundMode` all'avvio e nascondere la finestra (Rust)

**Files:**
- Modify: `src-tauri/src/lib.rs` (dentro `.setup(|app| { ... })`, dopo la creazione del tray)

**Interfaces:**
- Consumes: `tauri::Manager`, `tauri::ActivationPolicy`, lettura di `app-state.json` (stesso percorso usato dal blocco proxy: `app.path().app_data_dir()? .join("app-state.json")`).
- Produces: comportamento — finestra nascosta + `ActivationPolicy::Accessory` quando `backgroundMode == true`.

- [ ] **Step 1: Aggiungi un helper per leggere il flag**

In `src-tauri/src/lib.rs`, aggiungi una funzione libera vicino agli altri helper (sopra `pub fn run()`):

```rust
/// Read the persisted `backgroundMode` flag straight off app-state.json,
/// the same file the frontend's tauri-plugin-store writes. Read on disk
/// (not via the plugin) so it works during setup before the webview
/// boots — mirrors how proxy::read_proxy_config_from_store works.
fn read_background_mode(store_path: &std::path::Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(store_path) else {
        return false;
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    parsed
        .get("backgroundMode")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}
```

- [ ] **Step 2: Applica il flag in setup**

In `src-tauri/src/lib.rs`, dentro `.setup(|app| { ... })`, subito dopo il blocco che crea il tray e aggiorna `TrayAvailabilityState` (cerca `// Start the API before optional desktop integrations`), aggiungi alla fine del setup (prima di `Ok(())`):

```rust
            // Headless background mode: if enabled in app-state.json, keep
            // the main window hidden and (on macOS) drop the Dock icon so
            // the app runs purely as an MCP/API backend.
            if let Ok(dir) = app.path().app_data_dir() {
                let store_path = dir.join("app-state.json");
                if read_background_mode(&store_path) {
                    eprintln!("[background] backgroundMode on: hiding window");
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                    #[cfg(target_os = "macos")]
                    let _ = app.handle().set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            }
```

Assicurati che `use tauri::Manager;` sia in scope nel file (lo è già — `get_webview_window` è usato altrove in `lib.rs`).

- [ ] **Step 3: Build**

Run: `cd src-tauri && cargo build`
Expected: build OK.

- [ ] **Step 4: Verifica manuale**

1. Avvia l'app, apri le DevTools/console o modifica `app-state.json` aggiungendo `"backgroundMode": true` a livello top, chiudi e riapri.
2. Expected: la finestra non appare; l'icona del Dock (macOS) non compare; l'API risponde su `:19828` e l'MCP `llm_wiki_show_window` la fa apparire.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(app): hidden background mode driven by backgroundMode flag"
```

### Task B2: Toggle "Avvia in background" nelle Impostazioni (frontend)

> **Pattern di persistenza (importante).** Lo store NON usa il middleware persist di zustand. I setter fanno solo `set(...)`. Il salvataggio è esplicito tramite `src/lib/project-store.ts` (`saveX`/`loadX` con chiavi top-level su `app-state.json` via `tauri-plugin-store`), chiamato da `src/components/settings/settings-view.tsx`. L'idratazione all'avvio è in `src/App.tsx`. Replica il percorso di `proxyConfig` (`saveProxyConfig`/`loadProxyConfig`, `PROXY_CONFIG_KEY = "proxyConfig"`, siti `settings-view.tsx:432` e `App.tsx:246`).

**Files:**
- Modify: `src/lib/project-store.ts` (nuova `saveBackgroundMode`/`loadBackgroundMode`, chiave `"backgroundMode"`)
- Modify: `src/stores/wiki-store.ts` (campo `backgroundMode` + setter solo-set)
- Modify: `src/components/settings/settings-view.tsx` (salva + toggle autostart + switch)
- Modify: `src/App.tsx` (idratazione all'avvio)
- Test: `src/stores/wiki-store.test.ts`

**Interfaces:**
- Consumes: `@tauri-apps/plugin-autostart` (`enable`, `disable`); pattern `saveProxyConfig`/`loadProxyConfig`.
- Produces: chiave top-level `"backgroundMode": boolean` in `app-state.json` (letta da Task B1); setter store `setBackgroundMode(value)` (solo `set`); `saveBackgroundMode(value)`/`loadBackgroundMode()` in `project-store.ts`.

- [ ] **Step 1: Scrivi il test che fallisce (setter store)**

In `src/stores/wiki-store.test.ts`:

```ts
it("setBackgroundMode updates the flag", () => {
  useWikiStore.getState().setBackgroundMode(true)
  expect(useWikiStore.getState().backgroundMode).toBe(true)
  useWikiStore.getState().setBackgroundMode(false)
  expect(useWikiStore.getState().backgroundMode).toBe(false)
})
```

- [ ] **Step 2: Esegui per verificare il fallimento**

Run: `npx vitest run src/stores/wiki-store.test.ts -t "setBackgroundMode"`
Expected: FAIL — `setBackgroundMode is not a function`.

- [ ] **Step 3: Aggiungi campo + setter allo store**

In `src/stores/wiki-store.ts`: aggiungi `backgroundMode: boolean` all'interfaccia `WikiState`, `setBackgroundMode: (value: boolean) => void` ai setter, default `backgroundMode: false` nello stato iniziale, e l'implementazione (solo set, come `setProxyConfig`):

```ts
  setBackgroundMode: (backgroundMode) => set({ backgroundMode }),
```

- [ ] **Step 4: Esegui il test**

Run: `npx vitest run src/stores/wiki-store.test.ts -t "setBackgroundMode"`
Expected: PASS.

- [ ] **Step 5: Aggiungi save/load in project-store.ts**

In `src/lib/project-store.ts`, vicino a `PROXY_CONFIG_KEY`:

```ts
const BACKGROUND_MODE_KEY = "backgroundMode"

export async function saveBackgroundMode(value: boolean): Promise<void> {
  const store = await getStore()
  await store.set(BACKGROUND_MODE_KEY, value)
  await store.save()
}

export async function loadBackgroundMode(): Promise<boolean> {
  const store = await getStore()
  return (await store.get<boolean>(BACKGROUND_MODE_KEY)) ?? false
}
```

- [ ] **Step 6: Idrata all'avvio (App.tsx)**

In `src/App.tsx`, accanto al blocco `loadProxyConfig` (~riga 246), aggiungi:

```ts
        const savedBackgroundMode = await loadBackgroundMode()
        useWikiStore.getState().setBackgroundMode(savedBackgroundMode)
```

e aggiungi `loadBackgroundMode` alla riga di import da `@/lib/project-store`.

- [ ] **Step 7: Salvataggio + autostart + switch UI (settings-view.tsx)**

In `src/components/settings/settings-view.tsx` aggiungi un handler (accanto alla gestione di `saveProxyConfig`):

```ts
  const onToggleBackgroundMode = async (value: boolean) => {
    setBackgroundMode(value)
    await saveBackgroundMode(value)
    try {
      const autostart = await import("@tauri-apps/plugin-autostart")
      if (value) await autostart.enable()
      else await autostart.disable()
    } catch (err) {
      console.error("Failed to toggle autostart:", err)
    }
  }
```

dove `setBackgroundMode = useWikiStore((s) => s.setBackgroundMode)` e `saveBackgroundMode` è importata da `@/lib/project-store`. Aggiungi lo switch in una sezione Impostazioni (es. API Server o Source Watch), legato a `useWikiStore((s) => s.backgroundMode)` e `onToggleBackgroundMode`, label "Avvia in background (headless)", descrizione "Tieni l'app nel tray senza mostrare la finestra; abilita l'avvio automatico al login.". Segui il markup degli switch esistenti.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 9: Commit**

```bash
git add src/lib/project-store.ts src/stores/wiki-store.ts src/stores/wiki-store.test.ts src/components/settings/ src/App.tsx
git commit -m "feat(settings): add background mode toggle with autostart"
```

---

## PARTE D — Backup periodico versionato del vault su GitHub privato

Backup git ogni 6 ore (commit solo se ci sono modifiche) verso un repo privato, con `.gitignore` che esclude cache rigenerabile/transitoria.

### Task D1: Modulo backup Rust — `.gitignore` e logica git

**Files:**
- Create: `src-tauri/src/backup.rs`
- Modify: `src-tauri/src/lib.rs` (aggiungi `mod backup;`)

**Interfaces:**
- Produces:
  - `pub fn backup_gitignore() -> &'static str` — contenuto del `.gitignore` di backup.
  - `pub struct BackupConfig { pub enabled: bool, pub remote_url: String }`
  - `pub fn run_backup(project_path: &str, cfg: &BackupConfig) -> Result<String, String>` — esegue init/gitignore/add/commit(solo se modifiche)/push; ritorna un messaggio di esito.

- [ ] **Step 1: Scrivi i test che falliscono**

Crea `src-tauri/src/backup.rs` con (solo) i test in testa, e dichiara il modulo. Test:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gitignore_excludes_regenerable_and_includes_value() {
        let gi = backup_gitignore();
        // Escluse: cache rigenerabile gratis / transitori / segreti.
        assert!(gi.contains(".llm-wiki/lancedb/"));
        assert!(gi.contains(".llm-wiki/file-snapshot.json"));
        assert!(gi.contains(".llm-wiki/ingest-queue.json"));
        assert!(gi.contains(".llm-wiki/lint.json"));
        assert!(gi.contains("app-state.json"));
        // NON escluse (di valore o costose in token): non devono comparire.
        assert!(!gi.contains(".llm-wiki/ingest-cache.json"));
        assert!(!gi.contains(".llm-wiki/image-caption-cache.json"));
        assert!(!gi.contains(".llm-wiki/page-history"));
        assert!(!gi.contains(".llm-wiki/review.json"));
    }
}
```

In `src-tauri/src/lib.rs` aggiungi vicino agli altri `mod` (es. dopo `mod proxy;`):

```rust
mod backup;
```

- [ ] **Step 2: Esegui per verificare il fallimento**

Run: `cd src-tauri && cargo test gitignore_excludes`
Expected: FAIL — `backup_gitignore` non esiste.

- [ ] **Step 3: Implementa `backup_gitignore` e le struct**

In testa a `src-tauri/src/backup.rs`:

```rust
//! Periodic, versioned git backup of the project vault to a private
//! GitHub repo. Runs from the always-on background process. Auth is the
//! machine's existing git credential helper (gh token over HTTPS).

use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone)]
pub struct BackupConfig {
    pub enabled: bool,
    pub remote_url: String,
}

/// `.gitignore` for the backup repo. Excludes regenerable caches that
/// cost no tokens to rebuild, transient work-in-progress state, the
/// large/noisy vector DB, and the app config (no secrets). Everything
/// else under the project — wiki, schema, raw/sources, valuable
/// .llm-wiki state, and the token-costly caches (ingest-cache,
/// image-caption-cache) — is committed.
pub fn backup_gitignore() -> &'static str {
    "# LLM Wiki vault backup — exclude regenerable / transient / secrets\n\
.llm-wiki/lancedb/\n\
.llm-wiki/file-snapshot.json\n\
.llm-wiki/file-change-queue.json\n\
.llm-wiki/ingest-queue.json\n\
.llm-wiki/ingest-progress/\n\
.llm-wiki/dedup-queue.json\n\
.llm-wiki/lint.json\n\
.llm-wiki/db.json\n\
app-state.json\n"
}
```

- [ ] **Step 4: Esegui i test**

Run: `cd src-tauri && cargo test gitignore_excludes`
Expected: PASS.

- [ ] **Step 5: Implementa `run_backup`**

Aggiungi in `src-tauri/src/backup.rs`:

```rust
fn git(cwd: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("git {args:?} failed to start: {e}"))
}

/// Initialize the repo if needed, refresh .gitignore, stage, commit only
/// if there are changes, and push. Returns a human-readable status.
pub fn run_backup(project_path: &str, cfg: &BackupConfig) -> Result<String, String> {
    if !cfg.enabled {
        return Ok("backup disabled".to_string());
    }
    if cfg.remote_url.trim().is_empty() {
        return Err("backup remote_url is empty".to_string());
    }
    let root = Path::new(project_path);
    if !root.exists() {
        return Err(format!("project path does not exist: {project_path}"));
    }

    // 1. git init (idempotent).
    if !root.join(".git").exists() {
        git(root, &["init"])?;
        git(root, &["branch", "-M", "main"])?;
    }
    // 2. remote origin (set or update).
    let has_origin = git(root, &["remote", "get-url", "origin"])
        .map(|o| o.status.success())
        .unwrap_or(false);
    if has_origin {
        git(root, &["remote", "set-url", "origin", &cfg.remote_url])?;
    } else {
        git(root, &["remote", "add", "origin", &cfg.remote_url])?;
    }
    // 3. refresh .gitignore.
    std::fs::write(root.join(".gitignore"), backup_gitignore())
        .map_err(|e| format!("failed to write .gitignore: {e}"))?;
    // 4. stage everything.
    git(root, &["add", "-A"])?;
    // 5. commit only if there are staged changes.
    let dirty = !git(root, &["diff", "--cached", "--quiet"])?.status.success();
    if !dirty {
        return Ok("no changes to back up".to_string());
    }
    let stamp = git(root, &["commit", "-m", "backup: vault snapshot"])?;
    if !stamp.status.success() {
        return Err(format!(
            "git commit failed: {}",
            String::from_utf8_lossy(&stamp.stderr)
        ));
    }
    // 6. push.
    let push = git(root, &["push", "-u", "origin", "main"])?;
    if !push.status.success() {
        return Err(format!(
            "git push failed: {}",
            String::from_utf8_lossy(&push.stderr)
        ));
    }
    Ok("backup pushed".to_string())
}
```

- [ ] **Step 6: Build**

Run: `cd src-tauri && cargo build`
Expected: build OK.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/backup.rs src-tauri/src/lib.rs
git commit -m "feat(backup): vault git backup module with gitignore"
```

### Task D2: Scheduler 6h + endpoint manuale di backup

**Files:**
- Modify: `src-tauri/src/lib.rs` (avvia il thread scheduler in setup; helper per leggere `backupConfig` da `app-state.json`)
- Modify: `src-tauri/src/api_server.rs` (rotta `POST /backup/run` → `handle_backup_run`)

**Interfaces:**
- Consumes: `backup::{BackupConfig, run_backup}`, `clip_server::current_project_path()` (usato altrove in `api_server.rs` per il progetto corrente), lettura `app-state.json`.
- Produces: thread che ogni 6h chiama `run_backup` se abilitato; rotta `(&Method::Post, ["backup", "run"]) => handle_backup_run(app)` che esegue subito un backup e risponde `{ ok, status }`.

- [ ] **Step 1: Helper per leggere `backupConfig`**

In `src-tauri/src/backup.rs` aggiungi:

```rust
use serde_json::Value;

/// Read backup config from app-state.json. Shape (top-level):
/// `"backupConfig": { "enabled": bool, "remoteUrl": "https://github.com/.../x.git" }`.
pub fn read_backup_config(store_path: &Path) -> BackupConfig {
    let parsed = std::fs::read_to_string(store_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let cfg = parsed.as_ref().and_then(|p| p.get("backupConfig"));
    BackupConfig {
        enabled: cfg
            .and_then(|c| c.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        remote_url: cfg
            .and_then(|c| c.get("remoteUrl"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }
}
```

- [ ] **Step 2: Avvia lo scheduler in setup**

In `src-tauri/src/lib.rs`, dentro `.setup(...)`, dopo il blocco background-mode, aggiungi:

```rust
            // Periodic vault backup (every 6h) — runs in the always-on
            // background process. No-op unless enabled in settings.
            if let Ok(dir) = app.path().app_data_dir() {
                let store_path = dir.join("app-state.json");
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(6 * 60 * 60));
                    let cfg = backup::read_backup_config(&store_path);
                    if !cfg.enabled {
                        continue;
                    }
                    let project = clip_server::current_project_path();
                    if project.is_empty() {
                        continue;
                    }
                    match backup::run_backup(&project, &cfg) {
                        Ok(msg) => eprintln!("[backup] {msg}"),
                        Err(e) => eprintln!("[backup] error: {e}"),
                    }
                });
            }
```

> NOTA: verifica la firma di `clip_server::current_project_path()` (usata in `api_server.rs` ~riga 550: `clip_server::current_project_path()` ritorna `String`). Se è privata al crate, è già `pub(crate)` perché `api_server.rs` la usa.

- [ ] **Step 3: Endpoint manuale**

In `src-tauri/src/api_server.rs` aggiungi l'handler:

```rust
fn handle_backup_run(app: &AppHandle) -> ApiResponse {
    let Some(dir) = app.path().app_data_dir().ok() else {
        return err(500, "could not resolve app data dir");
    };
    let cfg = crate::backup::read_backup_config(&dir.join("app-state.json"));
    let project = clip_server::current_project_path();
    if project.is_empty() {
        return err(400, "no current project");
    }
    match crate::backup::run_backup(&project, &cfg) {
        Ok(status) => ok(json!({ "ok": true, "status": status })),
        Err(e) => err(500, e),
    }
}
```

Aggiungi la rotta nel `match`:

```rust
        (&Method::Post, ["backup", "run"]) => handle_backup_run(app),
```

Assicurati che `use tauri::Manager;` o `app.path()` sia disponibile in `api_server.rs` (lo è — `load_app_state` usa `app.path().app_data_dir()`).

- [ ] **Step 4: Build**

Run: `cd src-tauri && cargo build`
Expected: build OK.

- [ ] **Step 5: Verifica manuale**

1. Crea il repo privato: `gh repo create iFralex/llm-wiki-vault-backup --private`.
2. In `app-state.json` aggiungi `"backupConfig": { "enabled": true, "remoteUrl": "https://github.com/iFralex/llm-wiki-vault-backup.git" }`.
3. Run: `curl -s -X POST http://127.0.0.1:19828/api/v1/backup/run`
   Expected: `{ "ok": true, "status": "backup pushed" }` e i file compaiono nel repo privato su GitHub; una seconda chiamata senza modifiche dà `"no changes to back up"`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/api_server.rs src-tauri/src/backup.rs
git commit -m "feat(backup): 6h scheduler and manual /backup/run endpoint"
```

### Task D3: Impostazioni backup (frontend)

> **Persistenza:** stesso pattern della Task B2 — setter solo-set nello store, `save`/`load` in `project-store.ts`, salvataggio in `settings-view.tsx`, idratazione in `App.tsx`.

**Files:**
- Modify: `src/lib/project-store.ts` (`saveBackupConfig`/`loadBackupConfig`, chiave `"backupConfig"`)
- Modify: `src/stores/wiki-store.ts` (campo `backupConfig` + setter solo-set)
- Modify: `src/components/settings/settings-view.tsx` (salva + UI)
- Modify: `src/App.tsx` (idratazione)
- Test: `src/stores/wiki-store.test.ts`

**Interfaces:**
- Produces: chiave top-level `"backupConfig": { enabled: boolean; remoteUrl: string }` in `app-state.json` (letta da Task D2); setter `setBackupConfig`; `saveBackupConfig`/`loadBackupConfig` in `project-store.ts`.

- [ ] **Step 1: Scrivi il test che fallisce**

In `src/stores/wiki-store.test.ts`:

```ts
it("setBackupConfig updates enabled and remoteUrl", () => {
  useWikiStore.getState().setBackupConfig({ enabled: true, remoteUrl: "https://github.com/iFralex/llm-wiki-vault-backup.git" })
  expect(useWikiStore.getState().backupConfig.enabled).toBe(true)
  expect(useWikiStore.getState().backupConfig.remoteUrl).toContain("vault-backup")
})
```

- [ ] **Step 2: Esegui per verificare il fallimento**

Run: `npx vitest run src/stores/wiki-store.test.ts -t "setBackupConfig"`
Expected: FAIL.

- [ ] **Step 3: Implementa stato + setter**

In `src/stores/wiki-store.ts`: interfaccia `BackupConfig { enabled: boolean; remoteUrl: string }`, campo `backupConfig: BackupConfig` con default `{ enabled: false, remoteUrl: "" }`, setter solo-set `setBackupConfig: (backupConfig: BackupConfig) => set({ backupConfig })`.

- [ ] **Step 4: Esegui il test**

Run: `npx vitest run src/stores/wiki-store.test.ts -t "setBackupConfig"`
Expected: PASS.

- [ ] **Step 5: save/load in project-store.ts**

In `src/lib/project-store.ts`, vicino a `PROXY_CONFIG_KEY`:

```ts
const BACKUP_CONFIG_KEY = "backupConfig"

export async function saveBackupConfig(config: { enabled: boolean; remoteUrl: string }): Promise<void> {
  const store = await getStore()
  await store.set(BACKUP_CONFIG_KEY, config)
  await store.save()
}

export async function loadBackupConfig(): Promise<{ enabled: boolean; remoteUrl: string } | null> {
  const store = await getStore()
  return (await store.get<{ enabled: boolean; remoteUrl: string }>(BACKUP_CONFIG_KEY)) ?? null
}
```

- [ ] **Step 6: Idrata all'avvio (App.tsx)**

In `src/App.tsx`, accanto a `loadProxyConfig`, aggiungi:

```ts
        const savedBackup = await loadBackupConfig()
        if (savedBackup) useWikiStore.getState().setBackupConfig(savedBackup)
```

e aggiungi `loadBackupConfig` all'import da `@/lib/project-store`.

- [ ] **Step 7: UI + salvataggio (settings-view.tsx)**

Aggiungi una sezione Impostazioni "Backup" con: switch "Abilita backup periodico (ogni 6h)" → `backupConfig.enabled`; campo testo "URL repo GitHub privato" → `backupConfig.remoteUrl`; bottone "Esegui backup ora". Al cambio di switch o testo, chiama `setBackupConfig(next)` poi `await saveBackupConfig(next)` (importata da `@/lib/project-store`). Il bottone fa `fetch('http://127.0.0.1:19828/api/v1/backup/run', { method: 'POST' })` (riusa il client/fetch dell'app per includere il token API se presente). Segui il markup delle sezioni esistenti.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 9: Commit**

```bash
git add src/lib/project-store.ts src/stores/wiki-store.ts src/stores/wiki-store.test.ts src/components/settings/ src/App.tsx
git commit -m "feat(settings): backup config UI and store"
```

---

## Note finali

- **Parte A (config, niente codice):** in Impostazioni selezionare il preset "Claude Code CLI (local)" come provider principale e come `multimodalProvider`; impostare l'embedding su Ollama. Prerequisito: `npm i -g @anthropic-ai/claude-code` e login.
- **Autostart + background:** dopo aver attivato il toggle (Task B2), riavviare l'app per verificare l'avvio nascosto.
- **Backup auth:** il push usa il credential helper del token `gh` già configurato (`gh auth setup-git`, account `iFralex`). La chiave SSH della macchina è di un altro account e non va usata per questo repo.
