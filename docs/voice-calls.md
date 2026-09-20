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
   avoids requiring Docker Desktop at runtime. When the packaged Steward app
   already contains its multilingual Whisper model, Ringback reuses it instead
   of downloading a duplicate; macOS `say` provides Italian speech output.

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
   STEWARD_VOICE_OPENING_LINE=Ciao, sono Steward. Come posso aiutarti?
   ```

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
Every unrelated write remains denied in a headless call: spoken confirmation
cannot send mail, edit a calendar, or mutate files. Steward tells the user to
approve those operations in the app.

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
