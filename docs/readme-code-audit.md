# README / code audit

Reviewed on **2026-10-14**, against repository code at `b3b051c` and the checked-in
manifests/lockfiles. The root README was read in full. The first phase corrected
documentation only. The subsequent implementation phase fixes the residual issues
at the user's request; this working-tree revision now includes code, tests and
aligned guides. The table below preserves the original discrepancy/evidence;
the resolution matrix records the resulting implementation and its limits.

## Method and coverage

Descriptions were compared with runtime entrypoints, policy wrappers, tool
schemas/parsers, SQLite DDL/queries, worker CLIs, launcher Swift, packaging and
deployment scripts, and relevant fixture tests. Code behavior takes precedence
over comments or older documentation. Provider names/rates describe repository
configuration, not a fresh external pricing/availability verification.

The root README retains its product → workflow → internals → operations
structure. Existing dated benchmarks remain historical evidence; no personal
archive was rescanned or re-benchmarked. Component changes are targeted, except
for the web template and substantially outdated host/Calendar/Mail guides.
Vendored wiki documentation receives an integration note rather than a rewrite
of its upstream product description.

| Root area | Evidence inspected / disposition |
|---|---|
| Product/workflows, clients and architecture | Host configuration/server, protocol, web auth/socket, launcher lifecycle; qualified interactive versus background authority and added document/EventKit paths. |
| Mail journeys, search, embedding, promotion | Mirror CLI/store/embedding, MCP search/read paging, promoter CLI/runner/filesystem writer; corrected fallback, fields, concurrency and indexing boundaries. |
| Calendar/Contacts retrieval | Apple-store queries, search/args, sidecar identity, Contacts paths/resolution; corrected date/query degradation, permissions and index freshness. |
| Approval and write reliability | Gate, session, effective-input persistence, write journal and scheduler confirmation; separated attempted/returned/confirmed and domain-specific retry. |
| Action Center/background/watch | Settings/store, calendar producer, language prompts, scheduler jobs and watch schema/claims; documented controls, aggregation and failure limits. |
| Voice/trains/system diagnostics | Coordinator/voice guides, train service/adapter, system-status probes and launcher supervision; retained established flows and corrected stale lifecycle/fallback wording. |
| Ownership, security, recovery, performance | Audit redaction, gateway routing/metering, document limits, deployment snapshots and wiki backup; removed overly broad guarantees and preserved dated measurements. |
| Setup/components/development | npm manifests/lockfile requirements, Swift package, MCP entrypoints, Vite URL resolution and CI; corrected runnable commands and runtime boundaries. |

## Initial documentation review and supporting code

This is the historical documentation-phase record. Its third column describes
that phase's treatment, not the final software status. Behaviors subsequently
changed are explicitly resolved in the next section and the current guides.

| Discrepancy or omission | Code evidence | Documentation treatment |
|---|---|---|
| Calendar writes described as AppleScript-only. | [Connector dispatch](../apps/calendar-mcp/src/index.ts), [EventKit client](../apps/calendar-mcp/src/eventkit-client.ts), [native bridge](../apps/mac-launcher/Sources/StewardLauncher/CalendarEventKitBridge.swift). | Added backend selection, private IPC lifecycle, Full Access permission and uncertain outcomes. |
| Stable calendar IDs treated as uniformly usable by AppleScript. | [Create dispatch](../apps/calendar-mcp/src/index.ts). | EventKit selects ID; compatibility creation requires a unique resolved title. |
| Recurrence support/scope unspecified. | [RRULE parser](../apps/calendar-mcp/src/rrule.ts), [AppleScript builders](../apps/calendar-mcp/src/applescript.ts). | Enumerated native subset; documented delete rejection and update scope limitation in compatibility mode. |
| Event identity churn and local aliases absent. | [Index identity](../apps/calendar-mcp/src/index-db.ts), [sync generations](../apps/calendar-mcp/src/sync.ts). | Explained unique matching, generation protection and alias loss on index rebuild. |
| Calendar availability implied arbitrary overlap. | [Apple range query](../apps/calendar-mcp/src/apple-store.ts), [search filter](../apps/calendar-mcp/src/index-db.ts). | Described inclusive event-start filtering and lack of occurrence expansion. |
| Text-query fallback/default date behavior understated. | [Calendar search dispatch](../apps/calendar-mcp/src/index.ts), [args](../apps/calendar-mcp/src/args.ts). | Distinguished indexed text search from date-only fallback and explicit date windows. |
| Calendar confirmation/retry shown like Mail. | [Reconciliation](../apps/scheduler/src/write-ops-cli.ts). | Described field/all-day/alarm/presence checks, bounded exhaustion and no automatic Calendar replay. |
| Effective approved input not explained. | [Permission gate](../apps/host/src/core/permission-gate.ts), [runner](../apps/host/src/core/agent-runner.ts), [web input editor](../apps/web/src/lib/approval-input.ts). | Explained optional preflight, edited-input validation and effective/original transcript inputs. |
| Negative outcomes all presented as user rejection. | [Gate outcomes](../apps/host/src/core/permission-gate.ts), [Session timeout](../apps/host/src/core/session.ts). | Distinguished explicit denial, timeout, unrecognized input and channel failure. |
| Journal claimed sanitized input. | [Journal serialization](../packages/write-ops/src/index.ts). | Corrected to executable sensitive input; separated Audit copies. |
| Scheduled sends described as claimed before execution. | [Due-row selection](../packages/write-ops/src/index.ts), [send loop](../apps/scheduler/src/write-ops-cli.ts). | Removed exactly-once implication and documented process-local overlap protection. |
| Mail retry evidence and interrupted writes missing. | [Confirmation/retry](../apps/scheduler/src/write-ops-cli.ts), [stale started rows](../packages/write-ops/src/index.ts). | Added matching windows, retry preparation, attempt caps and stale-operation recovery. |
| Watch schema described two tables and per-rule event key. | [Watch store](../packages/watch-engine/src/store.ts). | Corrected four tables, event aggregation, rule participation and separate action claim key. |
| Train example used an unfiltered stop rule rejected by the adapter. | [Stop validation](../apps/host/src/core/train-watch-adapter.ts), [tool parsing](../apps/host/src/core/watch-tools.ts). | Replaced the example with a valid departure rule and documented explicit stop selectors; voice grants use the minimal tool-only form. |
| Train watch completion described segment arrival. | [Adapter terminal check/expiry](../apps/host/src/core/train-watch-adapter.ts). | Corrected completion at final route-stop actual arrival/cancellation; expiry remains original-segment based. |
| Calendar reminder producer/settings absent. | [Calendar scan](../apps/action-center/src/calendar.ts), [CLI switches](../apps/action-center/src/cli.ts), [settings](../apps/action-center/src/store.ts). | Added deterministic reminder horizon/priority, master/Calendar switches and cutoff differences. |
| Action display-language controls absent. | [Language guidance](../apps/action-center/src/action-language.ts), [HTTP settings](../apps/host/src/server.ts). | Documented default/en/it, partial updates, persistence, future generation and executable-input exclusions. |
| Document tools only briefly described. | [Tools](../apps/documents-mcp/src/index.ts), [read budget](../apps/documents-mcp/src/output-budget.ts), [search](../apps/documents-mcp/src/search.ts). | Added full workflow, cursor/paging fields, lexical versus sampled semantics and output caps. |
| Extraction timeout/cache presented as hard resource isolation. | [Extraction](../apps/documents-mcp/src/extraction.ts), [cache](../apps/documents-mcp/src/cache.ts), [Office readers](../apps/documents-mcp/src/readers/office.ts). | Qualified asynchronous wait timeout, full-file extraction, no decompressed/aggregate byte cap and failed-vector caching. |
| Partial mail implied automatic live fallback/persistent enrichment. | [Mail read](../apps/mail-mcp/src/db-read.ts). | Corrected non-full + fewer-than-20-character condition and response-only replacement. |
| Search summaries implied body state/full details. | [Search page](../apps/mail-mcp/src/search-page.ts), [database search](../apps/mail-mcp/src/db-search.ts). | Listed compact fields and public eight/default, twelve/max versus internal limits. |
| Promotion depended on wiki API and concurrency eight universally. | [Promoter CLI](../apps/mail-promoter/src/cli.ts), [runner](../apps/mail-promoter/src/run.ts), [filesystem writer](../apps/mail-promoter/src/wiki.ts). | Separated atomic source writes from best-effort final rescan; CLI default ten versus direct runner eight. |
| All model traffic/egress claimed centralized. | [Gateway](../apps/llm-gateway/src/gateway.ts), [wiki settings](../apps/llm-wiki/src/components/settings/settings-view.tsx), [research](../apps/llm-wiki/src/lib/web-search.ts), [MinerU](../apps/llm-wiki/src/lib/mineru.ts), [backup](../apps/llm-wiki/src-tauri/src/backup.rs). | Distinguished service defaults, wiki providers and optional network features; no enforced egress allow-list. |
| Unknown tools described as always denied. | [Policy precedence/default](../apps/host/src/core/tool-policy.ts). | Default-gated interactive tools; hard-deny and watch grant policy remain distinct. |
| Audit claimed universal secret removal/completeness. | [Redaction/insertion](../packages/audit-log/src/index.ts). | Documented key/string heuristics, bounds, separate summary/source-ref storage and best-effort writes. |
| Gateway client credential implied server access control. | [Gateway handler/bind](../apps/llm-gateway/src/gateway.ts), [host config](../apps/host/src/config.ts). | Explicitly documented no incoming bearer validation and independent host token. |
| Rates implied live upstream prices, attempts implied complete billing. | [Rates/recordCall](../apps/llm-gateway/src/gateway.ts). | Described code-configured rates, one terminal row per request and estimated/incomplete attempt accounting. |
| Gateway guide contradicted streaming fallback and referenced obsolete `api_base`. | [Streaming implementation/model mapping](../apps/llm-gateway/src/gateway.ts), [retired adapter](../apps/llm-gateway/src/adapter.ts). | Corrected pre-output fallback and explicit code wiring for retired optional adapter; noted its different bind behavior. |
| Launcher supervision/onboarding absent in root. | [Service supervisor/onboarding](../apps/mac-launcher/Sources/StewardLauncher/main.swift). | Added owned-process boundary, 15-second checks, backoff/grace and distinct permissions. |
| wiki-add omitted destination panels/manifest precedence. | [Import UI](../apps/wiki-add/src/index.ts), [applyPlans](../apps/wiki-add/src/core.ts), [collision helper](../packages/source-collision/src/node.ts). | Documented Save As/shared folder, cancellation, tracked destinations, hashes/suffixes and concurrency limits. |
| Node 20 and incorrect wiki workspace advertised. | [Locked Pi engine](../package-lock.json), [Swift target](../apps/mac-launcher/Package.swift), [wiki manifest](../apps/llm-wiki/package.json). | Corrected Node 22.19+, launcher macOS 14+, workspace `llm-wiki`; managed deploy ARM target distinguished. |
| Vite setup omitted host URL and token pairing. | [URL resolution](../apps/web/src/lib/host-url.ts), [token resolution](../apps/web/src/lib/auth.ts), [Vite config](../apps/web/vite.config.ts). | Added explicit WS override and separate Vite pairing versus host auto-pairing. |
| Wiki MCP bootstrap/auth absent. | [Host MCP entry](../apps/host/src/config.ts), [wiki API auth](../apps/llm-wiki/src-tauri/src/api_server.rs), [MCP client](../apps/llm-wiki/mcp-server/src/api-client.ts). | Added MCP build, Settings gates and independent token/provider configuration. |
| Calendar/Contacts guides used legacy index paths and obsolete hook language. | [Calendar paths](../apps/calendar-mcp/src/paths.ts), [Contacts paths](../apps/contacts-mcp/src/paths.ts), [scheduler jobs](../apps/scheduler/src/jobs.ts). | Corrected `steward/` defaults, legacy migration, host wrapper and manual Contacts refresh. |
| Frontend README was the Vite template; generic test advice was inaccurate. | [Web scripts](../apps/web/package.json), [bridge scripts](../packages/mcp-bridge/package.json). | Replaced template with runtime/client/PWA guide and actual verification commands. |
| Mobile allow-origin and token rotation instructions overstated behavior. | [Origin rules/host auth](../apps/host/src/server.ts), [token loader](../apps/host/src/config.ts). | Extra origins are additive; restart/re-pair required for token rotation; env override wins. |
| Notification links implied reliable cold-open routing. | [Notification click handler](../apps/web/src/sw.ts). | Qualified existing-window forwarding versus cold `openWindow('/')` without payload. |
| Voice guide implied unconditional fallback and future coordinator integration. | [Watch delivery](../apps/host/src/core/watch-notification-service.ts), [voice coordinator](../apps/host/src/core/voice-channel.ts). | Corrected all-matched-rules push opt-in, busy deferral, pre-dial claim and implemented approval flow. |
| Deploy snapshots implied complete recovery; rehearsal implied live startup. | [Snapshot list/smoke](../tools/steward-deploy.mjs), [workflow](../.github/workflows/deploy-rehearsal.yml). | Listed five DBs/config and omissions; distinguished no-launch CI rehearsal, code rollback and vault backup. |
| Offline replay tool undocumented. | [Replay tool](../tools/steward-local-model-eval.mjs), [ignore rules](../.gitignore). | Added opt-in workflow, sensitive artifacts, current-schema/historical-context limits and direct endpoint boundary. |

## Implementation resolutions

The user selected three policies before implementation: avoid uncertain Mail
resends and require an explicit new send; make operational backups automatic
before cutover and full content backup separate; move a tracked wiki source when
an explicit new destination is selected. These choices supersede the initial
documentation-only scope.

| Original issue | Implemented correction and evidence | Validation / boundary |
|---|---|---|
| Scheduled send concurrency/crash | [Atomic claim](../packages/write-ops/src/index.ts) changes only a due scheduled row to started and records its actual attempt time before [external execution](../apps/scheduler/src/write-ops-cli.ts). Interrupted claims are reconciled, never automatically requeued. | Two database handles and restart tests prove one claim. Crash before send can leave an unsent operation requiring review; crash after send cannot trigger an automatic resend. |
| Weak Mail confirmation / unsafe retry | [Confirmation](../apps/scheduler/src/write-ops-cli.ts) requires Sent role, own sender, account when selected, exact normalized To/CC and full body, plus subject or reply linkage. Actual attempt time defines the window. Ambiguous or capped evidence fails closed. Automatic restart/resend is removed, including legacy prepared-retry states; the ceiling produces needs_review. [Review tools](../apps/mail-mcp/src/index.ts) expose journal evidence under host read policy. | Fixtures cover wrong recipients/account/folder/CC/body, stale time, duplicate matches, capped candidates and scheduled timing. BCC, incomplete reply-all evidence and Mail-modified bodies can remain unconfirmed. A new send needs a user request and approval. |
| Calendar stale deletion evidence | [Sync](../apps/calendar-mcp/src/sync.ts) publishes metadata/deletions/completed marker transactionally; confirmation requires a sync begun after backend completion or native read-back, and a recorded pre-delete target baseline. [Journal](../packages/write-ops/src/index.ts) retains millisecond completion. | Freshness, same-second race, missing baseline, failed source read and pre-embedding publication tests. Legacy timestamps use a conservative extra second. Slow optional embeddings cannot overwrite newer source content. |
| Calendar UID churn / recurrence proof | [Reconciliation](../apps/scheduler/src/write-ops-cli.ts) resolves aliases and compares canonical supported RRULEs; multiple/unrepresentable native rules cannot pass merely by presence. Delete retains scope and occurrence selector. Recurring/future-scope verification requires native evidence. | Historical UID, rule mismatch, civil-date/all-day and alarm tests. Read-back checks observable rule/occurrence state, not a proof over every future occurrence or provider-side effect. |
| Calendar compatibility scope / one-sided time edit | [Validation](../apps/calendar-mcp/src/write-validation.ts) checks the live unchanged time boundary and rejects unsupported recurring/future compatibility updates. [Bridge](../apps/mac-launcher/Sources/StewardLauncher/CalendarEventKitBridge.swift) checks effective times and requires occurrenceStart for recurring changes. | Deterministic boundary/scope fixtures and native Swift typecheck; no personal Calendar mutations. |
| Calendar range/query incompleteness | [Range queries](../apps/calendar-mcp/src/apple-store.ts) use half-open overlap; [dispatch](../apps/calendar-mcp/src/index.ts) uses native occurrence expansion for explicit ranges and applies text filters. Compatibility range reads reject relevant recurring masters rather than return misleading availability. | Overlap/query validation tests. Native search caps 366 days and 1,000 occurrences with explicit errors. Indexed query-only retrieval remains entity search; Action reminders still scan index rows. |
| Late EventKit requests | [Client](../apps/calendar-mcp/src/eventkit-client.ts) withdraws unclaimed requests on timeout; requests carry expiry checked before [native execution](../apps/mac-launcher/Sources/StewardLauncher/CalendarEventKitBridge.swift). Claimed/interrupted requests retain uncertain outcomes without replay. | Private-directory IPC fixtures confirm queue withdrawal. Running external effects cannot be cancelled or rolled back by this protocol. |
| Audit secret handling | [Redaction](../packages/audit-log/src/index.ts) also processes summaries/source references and masks URL credentials, sensitive query values, inline secret assignments and PEM keys before snippets. | Tests inspect stored columns for representative secrets. Heuristics and best-effort persistence remain; primary operational state is intentionally separate. |
| Document resource/version/retry bounds | [Worker extraction](../apps/documents-mcp/src/extraction.ts) terminates on deadline with a bounded V8 heap and extracted-character budget. [ZIP validation](../apps/documents-mcp/src/archive-budget.ts) checks declared expansion/entry count. [LRU](../apps/documents-mcp/src/cache.ts) has estimated aggregate bytes; [cursors](../apps/documents-mcp/src/output-budget.ts) bind path/size/mtime; missing vectors retry and partial coverage is explicit. Packaging includes a separate worker entry. | Fixture parsers, stale cursors, failed-vector recovery, ZIP/cache budgets and compiled-worker extraction. These are operational controls, not an OS sandbox or an exact total-process RSS bound. No automatic OCR. |
| Push cold navigation | [Service worker](../apps/web/src/sw.ts) encodes a validated Action/chat target in a cold-open URL; [client](../apps/web/src/App.tsx) consumes it once and waits for its host connection. | Pure target validation/encoding tests and web typecheck; real installed-PWA delivery remains device verification. |
| Action reminder identity / re-enable cutoff | [Producer](../apps/action-center/src/calendar.ts) keys reminders by stable sidecar ref ID with UID fallback and migrates uniquely identifiable legacy reminders through aliases, preserving status. [Settings](../apps/action-center/src/store.ts) records calendarEnabledAt; Calendar uses the later global/local cutoff. | Move/UID churn and persisted switch tests. Ambiguous existing duplicates are not arbitrarily merged; rebuilding the sidecar can lose historical identity. |
| Import relocation / collision race / path escapes | [CLI importer](../apps/wiki-add/src/core.ts) honors explicit relocation, serializes imports with a project lock, uses exclusive unrelated writes, atomic replacements/manifest and canonical ancestor checks. It publishes new reference before removing old copy. | Relocation/collision, preserved unrelated/shared tracked bytes, symlink/traversal tests. Stale locks require operator verification; interrupted cleanup can leave an orphan. Independent frontend writers do not share all CLI guarantees. |
| Gateway authentication / duplicate fallback / deadline | [Gateway](../apps/llm-gateway/src/gateway.ts) enforces configured bearer credentials on model POST routes, deduplicates provider/model aliases, shares one request/body deadline and terminates committed streams without synthetic resend. [Shared credential helper](../packages/protocol/src/index.ts) avoids sending the gateway key to remote overrides. Retired adapter binds loopback. | Authentication/helper/fallback tests and local fake-server stalled-body/interrupted-stream tests. Unset key deliberately retains unauthenticated loopback compatibility; diagnostic GETs remain public. |
| Gateway attempt visibility | [Ledger](../packages/usage-ledger/src/index.ts) records separate provider_attempts diagnostics with request ID, status, mode and time to headers; only terminal calls contribute tokens/cost. | Separate-attempt tests verify totals are not doubled. Failed upstream billing cannot be inferred; attempts are diagnostics, not complete invoices or body-duration measurements. |
| Deployment operational backup omissions | [Backup tool](../tools/steward-backup.mjs) snapshots all ten known Steward DBs and copies sessions/configuration/settings. [Deployer](../tools/steward-deploy.mjs) awaits backup inside the cutover lock. Separate backup:full adds wiki/sources/uploads/blobs. Manifest paths/checksums, restrictive permissions and staged publication make the snapshot inspectable. | Isolated backup/restore and deploy fixtures. Per-DB consistency is not a global snapshot; Keychain, Apple authoritative stores and external symlink targets remain external. Rollback never restores older data automatically. |
| Wiki remote privacy / replay artifacts | [Git backup](../apps/llm-wiki/src-tauri/src/backup.rs) requires an identifiable GitHub remote and gh API proof of private visibility before staging/push; push uses the verified URL explicitly. [Ignore rules](../.gitignore) exclude local replay/model directories. | Rust tests compile the real module in a small offline harness. No remote API or push was performed. Repository visibility can change after verification; Git configuration/credentials remain operator-controlled. |

## Persistence and compatibility

The write journal adds nullable attempted_at and script_finished_at_ms columns
idempotently; old rows retain conservative fallback handling. needs_review is a
terminal review state, not a retry instruction. Existing prepared retry rows are
only reconciled. Action settings add optional calendarEnabledAt without rewriting
existing proposals. Calendar sync metadata uses its existing state table. Usage
adds provider_attempts independently of terminal request totals. Existing document
cursors are intentionally rejected and must be regenerated. No personal store was
migrated during verification; fixture stores exercise the new contracts.

## Remaining inherent boundaries and release checks

- SQLite and Apple side effects cannot commit atomically. The selected Mail policy
  trades automatic recovery of a possibly unsent message for avoiding duplicate
  delivery. Conservative evidence can leave successful sends in review.
- EventKit occurrence behavior, real privacy prompts and native Calendar identifier
  changes need device-level verification. The bridge was typechecked, not exercised
  against personal events. Unsupported compatibility semantics fail explicitly.
- Audit cannot discover every secret or sensitive fact in arbitrary prose. Journal,
  transcripts and backups contain operational data and must be protected separately.
- Document worker heap/declared archive/cache budgets are not kernel isolation or
  an exact native-memory bound. Stat fingerprints detect ordinary edits, not a
  malicious same-size/same-mtime replacement. Image-only PDFs still require an
  explicit separate OCR workflow.
- Full recovery requires external credentials and authoritative Apple data. Stop
  writers for a common snapshot and stable file copies. Wiki remote privacy is
  checked at run time, not guaranteed forever.
- Optional gateway authentication must be configured on gateway and clients
  together, including the independent wiki provider. No global outbound-network
  policy is imposed; direct providers/research/MinerU/Git remain independent.

## Verification performed

All software checks used temporary fixture data or fake local servers. The host
live end-to-end test was explicitly excluded. No real model/train call, Mail or
Calendar mutation, phone call, repository push, installation or deployment was
performed. The earlier documentation phase passed 260 selected existing tests;
that count is historical and is not added to the software-phase total.

Software-phase suites and their latest outcomes are recorded below. The Mail
watcher initially hit the environment's EMFILE watcher limit; its isolated rerun
with CHOKIDAR_USEPOLLING=1 passed. The deploy socket case is explicitly skipped
where the sandbox forbids listening; gateway fake-server checks were run with
local socket permission.

| Suite | Latest outcome |
|---|---:|
| Write journal | 6 passed |
| Scheduler / confirmation | 24 passed |
| Calendar MCP | 62 passed |
| Documents MCP | 13 passed |
| wiki-add | 17 passed |
| Audit | 5 passed |
| Action Center | 64 passed |
| Protocol | 2 passed |
| Usage ledger | 5 passed |
| Mail MCP | 115 passed |
| Mail Mirror | 73 passed initially; watcher passed separately with polling (74 distinct tests) |
| Mail promoter | 57 passed |
| Contacts MCP | 27 passed |
| Gateway | 36 passed |
| Host + web helpers, excluding live E2E | 190 passed |
| Backup + deploy fixtures | 4 passed, 1 sandbox socket skip |
| Wiki backup Rust module (offline harness) | 2 passed |

The latest distinct software checks total **703 passed**, with one explicit sandbox
socket skip; reruns are not added again.

TypeScript checks passed for all twelve directly affected workspaces; the Swift
bridge passed swiftc typecheck with a temporary module cache. The separately
bundled document worker extracted a temporary fixture successfully. Full Tauri
Cargo compilation was stopped after dependency build exhausted available disk;
only newly generated debug artifacts were removed, and the actual changed backup
module was compiled/tested in a small offline Rust harness instead. A full native
release/package build and real-device PWA/EventKit smoke remain release checks.

Documentation verification includes whitespace, local links/anchors, fences,
workspace scripts and consistency scans. The original documentation phase also
parsed all 15 Mermaid diagrams; the software phase updates the journal diagram
without changing its grammar or historical benchmark results.
