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
the approval conversation itself. `VoiceCallCoordinator` should intercept the
`approval_request`, use the active Ringback MCP connection directly for a
short speak/listen exchange, and then call `Session.resolveApproval`. This
keeps the model outside the authorization decision and preserves the existing
permission gate, Usage accounting and Audit trail.

Approvals are serialized because Ringback owns one active call. The normal
session timeout remains authoritative and each request is resolved at most once.
