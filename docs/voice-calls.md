# Voice calls (Ringback now, StreamCore later)

Steward treats voice as another authenticated channel into the existing agent.
The voice layer does not own prompts, memory, tools, or authorization.

```text
iPhone / Linphone
        | SIP audio
        v
Ringback MCP (today) ----\
                         > VoiceCallCoordinator -> ChatManager -> Steward tools/memory
StreamCore (future) -----/          |
                                    +-> existing approval policy and audit log
```

This boundary is intentional. Ringback validates the phone-call workflow now;
StreamCore can later replace the turn-based media path with streaming WebRTC
without changing `/voice/call`, `/voice/status`, chat persistence, or the
security model.

## Install Ringback

1. Install Linphone on the iPhone and create a free SIP account.
2. Run:

   ```bash
   ./tools/setup-ringback.sh
   ```

   On Apple Silicon, install native Homebrew in `/opt/homebrew` first. The
   helper deliberately uses its ARM Python and libraries, even if an older
   Intel Homebrew still exists in `/usr/local`. This keeps Ringback native and
   avoids requiring Docker Desktop at runtime. The installer keeps Steward's
   packaged `base` model as an offline fallback and downloads the multilingual
   `large-v3-turbo-q5_0` model (about 547 MiB) for Ringback. It is substantially
   more accurate than `base` while remaining practical for low-latency calls on
   Apple Silicon. It uses the M4 CPU/BLAS path by default because Metal can fail
   under high unified-memory pressure; the model server is stopped again after
   its idle timeout. macOS `say` provides speech output.

   Docker remains an explicit fallback via `./tools/setup-ringback.sh docker`,
   but it is never selected automatically.

3. Configure the Linphone account with `./tools/configure-ringback-sip.sh
   <username>`. macOS Keychain asks for and stores the password; `voice.env`
   contains only the non-secret SIP ID and username. Existing installations
   with a plaintext password can migrate once with
   `./tools/configure-ringback-sip.sh --migrate-legacy <username>`.
4. Enable Ringback in Steward:

   ```bash
   ./tools/enable-ringback.sh
   ```

   This adds the equivalent of:

   ```dotenv
   STEWARD_VOICE_TRANSPORT=ringback
   STEWARD_RINGBACK_LAUNCHER=/Users/YOU/Library/Application Support/Steward/ringback/steward-run-voice-mcp.sh
   ```

   The default opening, approval reading, recognition keywords, and recovery
   prompts follow the language selected in Steward (English or Italian).
   `STEWARD_VOICE_OPENING_LINE` remains available only as an explicit custom
   override; older built-in English/Italian defaults are migrated dynamically.
   Ringback reads Steward's selected language for every Whisper request, so a
   language change takes effect without reloading the model. Speech uses the
   matching macOS English/Italian voice when **Automatic** is selected.

5. Restart Steward. The System page shows the Ringback MCP health and a
   **Call this phone** button.

Ringback remains an external optional component rather than being copied into
the packaged app. This avoids silently combining its pjproject/pjsua2 GPL
runtime with Steward's distributable bundle.

The Steward launcher owns Ringback's lifecycle through a single-instance lock
and PID file. Ringback starts as an MCP child, receives termination when the
host exits, and removes stale locks on the next launch. Diagnose the native ARM
runtime without placing a call with:

```bash
"$HOME/Library/Application Support/Steward/ringback/steward-run-voice-mcp.sh" --doctor
```

`--version` prints the pinned runtime manifest. `--stop` is an emergency stop;
restart Steward before placing another call because it also closes the active
MCP connection.

After migrating an account that was used for testing, rotate its password on
the Linphone account service and run `configure-ringback-sip.sh` again. Updating
only the local Keychain item does not change the server-side SIP password.

## iPhone Shortcut

The existing paired token also authenticates voice calls. Send:

```http
POST https://MAC-TAILSCALE-NAME:4318/quick-call
Authorization: Bearer <paired token>
Content-Type: application/json

{"requestId":"shortcut-run-id"}
```

The body may also be empty. This route always creates a new chat and uses the
configured opening line. It deliberately rejects text, audio and arbitrary
extra fields. For a custom opening line, use the advanced endpoint:

```http
POST https://MAC-TAILSCALE-NAME:4318/voice/call
Authorization: Bearer <paired token>
Content-Type: application/json

{"requestId":"shortcut-run-id","openingLine":"Ciao, sono Steward. Dimmi pure."}
```

The endpoint returns `202` with a `chatId` and the effective `requestId`, then
Ringback calls the configured Linphone account. Reusing the same `requestId`
for a network retry returns the original call instead of dialing twice. A new
request while another call is active returns `409` plus the current voice state.

Before creating the chat, Steward performs a safe MCP/pjsua health check. It is
retried once because it does not send a SIP INVITE; actual calls are never
automatically redialed after no answer. The outbound Ringback account is
deliberately not SIP-registered, so preflight can verify the local engine but
remote Linphone reachability remains unknown until dialing.

For the in-call confirmation protocol, see [Voice approvals](voice-approvals.md).
It is active in calls created by `/quick-call` and in watcher-started calls.

`GET /voice/status` reports detailed phases such as `preflighting`, `starting`,
`ringing`, `speaking`, `listening`, `processing`, `ending`, and `failed`, plus
timestamps and the last-call outcome. The PWA polls these phases once per second
only while a call is in progress.

Ringback preserves the final SIP status and maps failures to stable outcomes:
`no_answer`, `rejected`, `busy`, `unreachable`, `timeout`, `auth_failed`,
`server_error`, `media_error`, or `network_error`. The coordinator records the
outcome, SIP status, and duration in both the Audit event and the dedicated
Voice calls section of Usage. A protocol-level MCP success containing a terminal
`[CALL FAILED]` result is counted as an error rather than a successful tool call.

Only the authenticated `/voice/call` endpoint automatically authorizes dialing.
In ordinary chat, `call_start` still produces an approval card. Once connected,
the harmless voice lifecycle tools may continue without one approval per turn.
Every tool follows the same policy as the PWA. A gated action pauses the agent;
Ringback reads the complete request and accepts `approva`, `rifiuta`, or
`ripeti` in Italian, or `approve`, `reject`, and `repeat` in English. The
request reading and every fixed control phrase use the same language selected
in the PWA. Explicit policy denials remain non-overridable.

The System page also stores the default speech rate (100–300 words per minute,
175 by default) and a separate voice for each Steward language. The selector is
populated from the installed macOS `say` voices matching the current language;
`Automatic` remains available. During a call,
the agent alone receives `set_voice_speech_rate`: it can change the current
call immediately, or propose a persistent default. A persistent change uses
the same spoken approval protocol and is written to Audit. The per-call
override is deleted when the call ends and is never exposed to ordinary chat.

## Calls started by a watch

A watch event resumes the persisted agent session of its originating chat. A
normal `create_watch` remains read-only. When the user explicitly asks for a
future call, the agent uses gated `create_agent_watch` and places a
`mcp__voice__call_start` grant only on the relevant one-shot rule. Approving it
grants exactly that future dialing capability for that rule, not for the whole
watch. Multiple rules matching the same event are combined into one turn.

At the matching event the agent receives the structured event and resource
reference, can refresh live facts with read-only tools such as `train_status`,
then calls through the same `VoiceCallCoordinator`. The phone conversation,
tool calls and transcript remain in the original chat, so follow-up questions
such as the expected arrival time can be answered during the call. Unrelated
writes use the normal voice approval flow. If another rule matched the same
event and explicitly granted a registered constrained action, that action is
available inside the same scoped phone turn; its deterministic argument guard
is unchanged. A
failed or interrupted call falls back to Web Push, and
the fallback is persisted before dialing so a host restart never redials the
same event automatically.

## StreamCore seam

`STEWARD_VOICE_TRANSPORT=streamcore` and `STEWARD_STREAMCORE_URL` already have a
typed configuration shape, but StreamCore is intentionally reported as not yet
implemented. Its adapter should implement the same coordinator contract while:

- accepting WebRTC/WHIP sessions;
- sending finalized user turns to the existing `ChatManager`;
- streaming assistant text to TTS;
- mapping interruption/cancellation to the active turn;
- preserving `/voice/call`, `/voice/status`, audit events, and chat IDs.

Ringback and StreamCore can coexist later: Ringback/Linphone can remain the
ringing SIP endpoint while StreamCore owns the low-latency media session.
