# LLM Wiki come server MCP headless con Claude Code — Design

Data: 2026-06-17

## Obiettivo

Usare LLM Wiki in due modi:

1. **Principalmente come server MCP per altri agenti**, senza mostrare
   l'interfaccia e con consumo RAM contenuto (idealmente < 250 MB,
   senza inseguirlo a tutti i costi).
2. **Usare Claude Code dell'abbonamento** (CLI `claude`) come LLM al
   posto delle API esterne a pagamento — per ingest, query e **caption
   immagini (vision)**.

Gli agenti esterni devono poter sia **interrogare** la wiki sia
**alimentarla** (aggiungere documenti e farli ingerire) via MCP.

## Contesto architetturale (stato attuale)

- App **Tauri** (Rust + webview React), non Electron. Su macOS la
  webview è WebKit.
- **API HTTP locale** su `127.0.0.1:19828` scritta in **Rust**
  (`src-tauri/src/api_server.rs`). Legge tutto da disco via
  `load_app_state` (progetto corrente, file, search, graph, review):
  **non dipende dalla webview viva**.
- **Server MCP** (`mcp-server/`, Node) parla solo a quell'API HTTP.
  Tool attuali: `status`, `projects`, `files`, lettura contenuto,
  `search`, `graph`, `reviews`, `rescan` — tutti in **lettura**.
- Le **chiamate LLM** (ingest, query, deep research, vision) vivono nel
  **frontend/webview** (`src/lib/llm-client.ts`,
  `src/lib/llm-providers.ts`). Usano API Tauri (invoke, plugin-http,
  plugin-store, event): non sono portabili in un runtime Node headless
  senza riscrivere tutto.
- Esiste già un provider **`claude-code`** completo e nativo:
  - frontend `src/lib/claude-cli-transport.ts`
  - Rust `src-tauri/src/commands/claude_cli.rs` che lancia
    `claude -p --output-format stream-json --input-format stream-json
    --verbose --model <model>` e usa le credenziali OAuth
    dell'abbonamento.
  - preset "Claude Code CLI (local)" nelle Impostazioni con
    health-check.
  - **Gestisce già le immagini**: `claude_content_blocks` serializza i
    blocchi `image` nel formato nativo Anthropic
    (`source.type=base64, media_type, data`), che è ciò che `claude`
    CLI accetta in input stream-json.
- Esiste già l'**auto-ingest da cartella**: il frontend (quando vivo)
  ascolta gli eventi `file-sync://changed` emessi da Rust e accoda
  l'ingest dei file nuovi in `raw/sources/`
  (`src/lib/project-file-sync.ts`), processandoli con `llmConfig`.
- La `setup()` Rust (`src-tauri/src/lib.rs`) legge già `app-state.json`
  da disco all'avvio (per la config proxy): stesso pattern riusabile
  per un nuovo flag.

## Decisioni di design

### Parte A — Claude Code come LLM (solo configurazione, niente codice)

Il provider `claude-code` copre testo **e immagini** end-to-end. Quindi:

1. **Testo (ingest/query)**: provider LLM = preset "Claude Code CLI
   (local)" (`provider: "claude-code"`). Prerequisito:
   `npm i -g @anthropic-ai/claude-code` e login con l'abbonamento.
2. **Vision (caption immagini): ATTIVA**, `multimodalProvider`
   impostato su `claude-code` con un modello vision-capable (i default
   Claude lo sono).
3. **Embedding / ricerca vettoriale**: Claude non ha modelli di
   embedding → puntare la config embedding a **Ollama** locale (es.
   `nomic-embed-text`).

Nessuno sviluppo. Da validare end-to-end che funzioni anche con webview
nascosta (lo spawn del subprocess `claude` è lato Rust, quindi atteso
funzionante).

### Parte B — Modalità background headless (sviluppo piccolo, basso rischio)

L'ingest gira nella webview JS, quindi per ingerire senza UI la webview
deve restare **viva ma nascosta**. Si accetta la RAM ~150-300 MB (da
misurare), senza inseguire i 250 MB con la complessità di una webview
"lazy".

Componente nuovo: **Background mode**.

- Nuovo flag `backgroundMode` in `app-state.json`, letto nella
  `setup()` Rust con lo stesso pattern della config proxy
  (`src-tauri/src/lib.rs` ~riga 165).
- Se attivo:
  - la finestra `main` viene creata con `visible: false`;
  - su macOS si imposta `ActivationPolicy::Accessory` (niente icona nel
    Dock, niente furto di focus);
  - la webview resta **viva** → API + auto-ingest funzionanti.
- **Autostart** abilitato (plugin `tauri-plugin-autostart` già presente)
  così l'app parte al login già in background.
- La finestra resta mostrabile/chiudibile solo dal **tray** (già
  esistente, `src-tauri/src/tray.rs`).
- Nuovo toggle in Impostazioni: "Avvia in background (headless)".

Prerequisito di configurazione per l'auto-ingest: source-watch con
`enabled: true` e `autoIngest: true`.

### Parte C — Tool MCP per alimentare i documenti (sviluppo)

Nuovo tool MCP **`llm_wiki_add_source`** che scrive uno o più file in
`raw/sources/` e (opzionalmente) avvia il rescan, così un agente può
alimentare documenti con una sola chiamata, senza accesso al filesystem
né conoscere il path del progetto.

Requisiti:

- Supporta sia **file singolo** sia **batch** (più file nella stessa
  chiamata). Forma input proposta:
  ```jsonc
  {
    "project_id": "current",         // opzionale, default current
    "sources": [
      { "filename": "nota.md", "content": "..." },
      { "filename": "doc.txt",  "content": "..." }
    ],
    "rescan": true                    // opzionale, default true
  }
  ```
  Per comodità si accetta anche la forma a file singolo
  (`filename` + `content` ai livelli alti), normalizzata internamente in
  un array di un elemento.
- Nuovo endpoint Rust **`POST /api/v1/projects/{project_id}/sources`**
  che:
  - valida ogni `filename` (no path traversal, no path assoluti, nessun
    componente `..` o nascosto; estensioni ammesse coerenti con
    source-watch);
  - scrive sotto `raw/sources/` del progetto risolto, usando lo stesso
    `safe_join` già in uso in `api_server.rs`;
  - gestisce le collisioni di nome in modo coerente con la logica di
    ingest esistente (riusare `ingest-source-path-collision`/sanitize
    se applicabile);
  - se `rescan` è true, invoca `handle_rescan` / `rescan_project_files`
    così l'auto-ingest parte;
  - risponde con l'elenco dei path scritti e dell'esito per file
    (scritto / saltato / errore), senza interrompere il batch al primo
    errore.
- Aggiornare il client MCP (`mcp-server/src/api-client.ts`) e
  l'`index.ts` con il nuovo tool e i relativi tipi.
- Test: validazione path (Rust), batch parziale con un file invalido,
  e test del tool lato `mcp-server/test`.

## Fuori scope

- Nessun proxy Anthropic→CLI (il provider nativo lo rende inutile).
- Nessuna webview "lazy" (si accetta la RAM ~250-300 MB).
- Nessuna riscrittura dell'ingest in Rust.
- Nessuna modifica alla pipeline LLM esistente oltre la configurazione.

## Flusso end-to-end risultante

```
agente → tool MCP llm_wiki_add_source(sources=[...])
   → Rust POST /sources scrive in raw/sources/ + rescan
   → Rust emette file-sync://changed
   → webview (viva, nascosta) auto-ingest via Claude Code (testo+vision)
   → agente interroga via tool MCP search / files / graph
```

## Punti da validare in implementazione

- Misurare la RAM reale a riposo in background mode su macOS (atteso
  ~150-300 MB).
- Verificare che `ActivationPolicy::Accessory` + `visible: false` non
  rompano tray né autostart, e che la finestra si possa comunque mostrare
  dal tray.
- Validare che `claude-code` (testo e vision) funzioni con webview
  nascosta.
- Definire le estensioni file ammesse per `add_source` allineandole alla
  config source-watch.
```
