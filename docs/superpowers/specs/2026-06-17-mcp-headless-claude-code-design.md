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
3. **Backup periodico e versionato** del vault su un repo GitHub privato.
4. **Controllo della finestra via MCP**: un agente può mostrarla o
   nasconderla all'utente.

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

### Parte D — Backup periodico e versionato del vault su GitHub privato (sviluppo)

Backup automatico, periodico e **versionato** dell'intero vault (dati
inclusi) verso un repository GitHub **privato** dell'utente.

Approccio scelto: **git-based** (la versionatura è nativa: ogni backup è
un commit, lo storico è la cronologia git, il push va su GitHub privato).

- **Cosa si backuppa (deciso).** Tutto ciò che ha valore o costa token a
  rigenerare:
  - `wiki/`, file schema/purpose (`purpose.md`, `schema.md`, `index.md`,
    `log.md`, `overview.md`), `raw/sources/`;
  - sottoinsieme di valore di `.llm-wiki/`: `chat-history.json`,
    `conversations.json`, `chats/`, `page-history/`, `review.json`,
    `dedup-not-duplicates.json`, `project.json`,
    `scheduled-import-db.json`;
  - cache che a rigenerare **costano token**: `.llm-wiki/ingest-cache.json`,
    `.llm-wiki/image-caption-cache.json`.
- **Esclusi (deciso)** via `.gitignore` generato — rigenerabili gratis,
  transitori, grandi/rumorosi o segreti:
  - `.llm-wiki/lancedb/` (DB vettoriale; rigenerabile gratis con embedding
    Ollama locale, grande e churny);
  - `.llm-wiki/file-snapshot.json`, `.llm-wiki/file-change-queue.json`,
    `.llm-wiki/ingest-queue.json`, `.llm-wiki/ingest-progress/`,
    `.llm-wiki/dedup-queue.json` (stato transitorio/work-in-progress);
  - `.llm-wiki/lint.json`, `.llm-wiki/db.json` (derivati rigenerabili
    gratis dalla wiki);
  - `app-state.json` (config; con Claude Code niente API key, escluso per
    prudenza).
- **Repo git dedicato** inizializzato dentro la cartella del progetto
  (separato dal repo dell'app). Primo backup: `git init`, `.gitignore`,
  commit iniziale, push. Repo remoto privato di default:
  `iFralex/llm-wiki-vault-backup` (creato da gh come privato; nome
  modificabile in Impostazioni).
- **Schedulazione (deciso): ogni 6 ore**, task periodico **in-app lato
  Rust** (si integra con la modalità background già sempre attiva), commit
  **solo se ci sono modifiche**. Più backup manuale on-demand
  (comando/endpoint).
- **Binari grandi (deciso): git semplice.** I PDF/binari in `raw/sources/`
  vengono committati direttamente, niente git-lfs. Si accetta una crescita
  graduale dello storico (vault personale).
- **Autenticazione push (headless)**: repo privato sotto l'account
  `iFralex`. Push non interattivo via **credential helper del token gh**
  (HTTPS, già configurato con `gh auth setup-git`). Nota: la chiave SSH
  della macchina appartiene all'altro account (`Steantycip-anto`) e **non**
  ha accesso ai repo di `iFralex`, quindi per il backup si usa HTTPS+token,
  non SSH.
- **Sicurezza**: il repo è privato; comunque mai includere segreti
  (`.gitignore` come sopra).
- Toggle e parametri in Impostazioni: abilita backup, nome/URL repo,
  intervallo.

### Parte E — Comando MCP per mostrare la finestra all'utente

In modalità background la finestra è nascosta. Nuovo tool MCP
**`llm_wiki_show_window`** che la porta in primo piano, così un agente
può mostrare l'interfaccia all'utente quando serve.

- Nuovo endpoint Rust **`POST /api/v1/window/show`** (o un comando
  dedicato) che riusa `show_main_window` di `src-tauri/src/tray.rs`
  (`window.show()` + `unminimize()` + `set_focus()`) e, su macOS,
  reimposta `ActivationPolicy::Regular` così la finestra compare nel Dock
  e in foreground (in background mode è `Accessory`).
- **Incluso (deciso):** anche `llm_wiki_hide_window` (endpoint
  `POST /api/v1/window/hide`) che nasconde di nuovo la finestra e
  ripristina `Accessory` su macOS — simmetrico, costo minimo.
- Aggiornare `mcp-server` (`api-client.ts` + `index.ts`) coi nuovi tool.

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
- Backup: creare il repo privato `iFralex/llm-wiki-vault-backup` e
  verificare il push non interattivo via token gh in background mode.

Tutte le scelte di design sono chiuse; i punti qui sopra sono verifiche
di implementazione, non decisioni aperte.
```
