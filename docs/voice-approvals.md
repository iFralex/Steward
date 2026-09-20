# Voice approvals

## Status

This document specifies the recommended design. Spoken approval is not enabled
yet: today a gated tool requested during a normal phone call still waits for
the existing app approval and eventually denies on timeout.

## Security boundary

A bare “yes” is not sufficient. Speech recognition can be wrong, audio can be
replayed, and untrusted content read by the agent must never become authority.
The model must also not decide whether the user approved its own action.

The host, not the model, should own a short approval sub-protocol:

1. The normal deterministic permission gate creates one pending request with
   the exact tool name, canonical arguments, approval preview and chat ID.
2. The host hashes that immutable request and generates a random spoken code,
   for example `4821`, valid only for that request and active call.
3. Ringback reads a tool-specific deterministic summary: recipient and subject
   for mail, calendar/title/time for events, or target/path for file actions.
   It then says: “Per approvare dì autorizzo 4821. Per rifiutare dì rifiuto.”
4. Ringback captures one response without involving the main agent. The host
   accepts only the normalized exact phrase containing the current code.
   `rifiuto`, ambiguity, silence, a mismatched code or timeout all deny.
5. The existing `Session.resolveApproval` resolves the original request once.
   The permission gate then executes the unchanged arguments. Spoken approval
   never supports approve-with-edit; revisions move back to chat/PWA.
6. Audit stores the request ID, tool, argument hash, challenge result and
   decision. It must not store secrets or the full spoken recording.

## Eligibility

Voice approval should be an explicit per-tool policy, separate from ordinary
`allow/gate/deny`:

- eligible: sending an already composed email, creating/updating a calendar
  event, changing an Action Center status;
- app-only initially: deleting files/events, shell writes, credentials,
  purchases, security settings and actions with attachments or many recipients;
- never implicit: a tool does not become voice-approvable merely because an MCP
  connector exposes it.

The deterministic summary renderer must refuse a request it cannot describe
fully. In that case Steward should say that approval is available in the app,
emit the normal approval card and keep the call usable for read-only questions.

## Ringback integration

The agent is paused while `requestApproval` awaits a decision, so it cannot run
the approval conversation itself. `VoiceCallCoordinator` should intercept the
`approval_request`, use the active Ringback MCP connection directly for a
short speak/listen exchange, and then call `Session.resolveApproval`. This
keeps the model outside the authorization decision and preserves the existing
permission gate, Usage accounting and Audit trail.

The first implementation should support one approval at a time, a 30-second
timeout, one recognition attempt and no retry after an ambiguous answer. The
PWA approval card remains active in parallel; whichever valid channel resolves
the request first wins, and the other receives an “already resolved” result.
