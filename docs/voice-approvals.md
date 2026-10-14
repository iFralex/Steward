# Voice approvals

## Status

Spoken approval is enabled for every tool that the ordinary PWA policy marks
as `gate`. Read-only tools remain automatic, explicit policy denials remain
denied, and watcher-scoped grants remain pre-authorized.

## Security boundary

A bare “yes” is not sufficient. The model does not decide whether the user
approved its own action. The host owns a small deterministic sub-protocol:

1. The normal deterministic permission gate creates one pending request with
   the exact tool name, canonical arguments, approval preview and chat ID.
2. Ringback reads a deterministic rendering of the tool name, complete
   arguments, and approval preview without involving the main agent.
3. The host accepts localized explicit commands: `approva`, `rifiuta`, or
   `ripeti` in Italian; `approve`, `reject`, or `repeat` in English. The repeat
   command sends the exact same immutable rendering back to Ringback. Ambiguous
   speech is prompted again in the same language and eventually fails closed.
4. The existing `Session.resolveApproval` resolves the original request once.
   The permission gate then executes the unchanged arguments. Spoken approval
   never supports approve-with-edit; revisions move back to chat/PWA.
5. Audit stores prompt/repeat/decision events against the original request ID;
   Usage records the exchange as `voice.approval`. No recording is stored.

## Eligibility

Eligibility is deliberately identical to the PWA: `allow` runs, `gate` can be
approved or refused by voice, and `deny` cannot be overridden. Voice approval
does not create a second per-tool allowlist and does not support approve-with-edit.

## Ringback integration

The agent is paused while `requestApproval` awaits a decision, so it cannot run
the approval conversation itself. `VoiceCallCoordinator` intercepts the
`approval_request`, uses the active Ringback MCP connection directly for a
short speak/listen exchange, and then calls `Session.resolveApproval`. This
keeps the model outside the authorization decision and preserves the existing
permission gate, Usage accounting and Audit trail.

Approvals are serialized because Ringback owns one active call. The normal
session timeout remains authoritative and each request is resolved at most once.

## Persistence and failure interpretation

Voice approval resolves the same pending request as the desktop gate. It does
not edit arguments or bypass connector validation. Tools with host preflight
normalize before the immutable request is rendered. The executed input is
persisted in the tool transcript; Audit records a separately bounded/redacted
copy best-effort. No stored recording does not mean no speech-derived text is
retained in the chat or audit metadata.

Explicit rejection differs from timeout, unrecognized speech and channel/media
failure. Every negative outcome prevents execution; only explicit rejection is
reported as a user refusal. A media-recovery call must request an interrupted
approval again rather than assuming the previous speech granted authority.

Calendar changes during calls use the same EventKit/AppleScript backend
selection and later confirmation as PWA tools. Spoken approval does not grant
Calendar Full Access, Full Disk Access or Automation permission. Watch grants
can pre-authorize registered arguments, but do not make backend effects atomic
with their durable claims. See [write reliability](../README.md#approval-and-write-reliability).
