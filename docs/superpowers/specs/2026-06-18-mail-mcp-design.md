# Mail MCP (Phase 2) — Design

Data: 2026-06-18

## Obiettivo

Un nuovo workspace `apps/mail-mcp`: un server **MCP (stdio)** che dà
all'agente personale (l'host su Claude Agent SDK) accesso a **Mac Mail**
— leggere posta/allegati da qualsiasi casella e **inviare** email/risposte
reali, con l'invio sempre dietro l'approvazione deterministica dell'host.
Sostituisce il tool demo `send_email` (stub) della Fase 1.

Vedi `2026-06-17-…` per l'architettura dell'host; `host-phase1` (memoria)
per i dettagli del gate.

## Decisioni (approvate)

- **Accesso = AppleScript su Mail.app** via `osascript` (`execFile`,
  nessuna dipendenza extra). Usa gli account già configurati in Mail.
  Prerequisiti runtime: Mail.app aperta + permesso macOS "Automazione"
  concesso una volta.
- **Invio reale**: alla conferma l'email viene **inviata** (non lasciata
  in bozza). La card di approvazione dell'host mostra il payload prima
  dell'invio; il gate garantisce che nulla parta senza OK.
- **Lettura = tutte le mailbox di tutti gli account** (Inbox, **Sent**,
  **Drafts**, Archivio, Indesiderata, Cestino, cartelle custom).
- **Policy**: i tool di lettura sono **auto-allow**; `send_email`/`reply`
  restano **gated** (default-deny dell'host).

## Architettura

- `apps/mail-mcp` (TS, ESM, npm workspace) riusa **`@modelcontextprotocol/sdk`**
  ricalcando la struttura di `apps/llm-wiki/mcp-server`.
- L'host (`apps/host/src/config.ts`) lo collega come server MCP stdio:
  `mail: { type: "stdio", command: <node/tsx>, args: [entry] }`. I tool
  appaiono come `mcp__mail__<tool>`.

### Unità (file, responsabilità singola)

- `src/osascript.ts` — `runOsa(script: string, { timeoutMs }): Promise<string>`:
  esegue AppleScript via `execFile("osascript", ["-e", script])`, gestisce
  errori (Mail non in esecuzione, permesso negato, timeout). Pura I/O di
  sistema.
- `src/applescript/` — builder degli script (funzioni pure `string`):
  uno per operazione (`searchScript`, `readScript`, `mailboxesScript`,
  `saveAttachmentScript`, `sendScript`, `replyScript`). Separati dai parser
  così sono testabili senza Mail.app.
- `src/parse.ts` — parser dell'output osascript → strutture tipizzate
  (puro, testabile con output campione).
- `src/mail.ts` — orchestrazione: per ogni tool, costruisce lo script,
  `runOsa`, `parse`, ritorna il risultato tipizzato. Validazione input
  (incl. path-safety di `save_attachment`).
- `src/index.ts` — server MCP: `ListTools` + `CallTool` che instradano ai
  metodi di `mail.ts` (pattern identico a llm-wiki `mcp-server/src/index.ts`).

## Tool & forme dati

Identità messaggio: **header RFC `Message-ID`** (`messageId`), più stabile
dell'id per-account; `search` lo restituisce, gli altri tool lo accettano.

**Lettura (auto-allow):**
- `list_mailboxes()` → `[{ account: string, name: string }]`.
- `search_messages({ query?, sender?, account?, mailbox?, limit })` →
  `[{ messageId, subject, from, date, mailbox, account, snippet }]`.
  `limit` default 20 (cap a 100). Senza `mailbox`/`account` cerca su tutte.
- `read_message({ messageId })` → `{ messageId, subject, from, to, cc, date,
  body, attachments: [{ name, index }] }` (body testo).
- `save_attachment({ messageId, attachment, destDir? })` → `{ path }`.
  `attachment` = nome o indice; `destDir` default a una dir temp dedicata;
  path validato (no traversal, dentro destDir).

**Invio (gated — esegue l'invio reale):**
- `send_email({ to: string[], cc?, bcc?, subject, body, attachments?: string[] })`
  → `{ sent: true }`. `attachments` = path di file su disco. Corpo testo.
- `reply({ messageId, body, attachments?, replyAll? })` → `{ sent: true }`:
  usa il comando `reply` di Mail (cita l'originale), popola e invia.

## AppleScript (note e rischi)

- Invio: `make new outgoing message with properties {subject, content,
  visible:false}` → `make new to recipient … {address}` (e cc/bcc) →
  per ogni allegato `make new attachment with properties {file name:
  POSIX file <path>}` → `send`.
- Reply: `set r to reply <msg> opening window false [reply to all true]`
  → set `content` (corpo + citazione) → allegati → `send`.
- Lettura: iterazione su `mailboxes of every account` per `list_mailboxes`;
  `search` filtra per `account`/`mailbox`/`whose` (sender/subject contains)
  con `limit`; localizzazione di un messaggio per `Message-ID`.
- `save_attachment`: `save (attachment i of <msg>) in POSIX file <dest>`.
- **Rischio noto:** la sintassi AppleScript di Mail è fragile (identità
  messaggi, performance su mailbox grandi, citazione nel reply). I builder
  verranno **rifiniti col test manuale** su Mail.app reale; la separazione
  builder/parser/orchestrazione limita il raggio di ogni aggiustamento.

## Integrazione host

- Rimuovere il tool demo `send_email` (e `apps/host/src/tools/demo.ts`) dal
  `config.ts`; aggiungere il server `mail`.
- In `apps/host/src/core/tool-policy.ts` aggiungere all'allow-list i 4 tool
  di lettura: `mcp__mail__list_mailboxes`, `mcp__mail__search_messages`,
  `mcp__mail__read_message`, `mcp__mail__save_attachment`. `send_email`/
  `reply` non sono allow-listati → restano gated → card di approvazione.

## Errori

- Mail.app non in esecuzione → errore chiaro ("Apri Mail.app").
- Permesso Automazione negato → errore (il primo uso fa comparire il prompt
  macOS); messaggio che spiega come concederlo.
- Timeout osascript (mailbox grandi) → `limit` + timeout per chiamata.
- `save_attachment`/allegati `send_email`: path validati.

## Testing

- **Unit (no Mail.app):** validazione input (destinatari, path-safety),
  costruzione degli script (args → frammenti attesi), parsing output
  (output osascript campione → strutture attese).
- **Integrazione manuale:** Mail.app reale — `list_mailboxes`,
  `search_messages` (incl. Sent/Drafts), `read_message`, `save_attachment`,
  `send_email` (a un indirizzo di prova), `reply`. Verifica che l'invio
  passi sempre dalla card di approvazione dell'host.

## Fuori scope (Fase 2)

Corpo HTML (solo testo), scheduling/follow-up, risoluzione Contatti
(Fase 3), trigger proattivi, selezione account avanzata oltre i filtri
`account`/`mailbox`.
