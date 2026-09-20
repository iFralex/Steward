#!/bin/bash
# stdio MCP launcher used by Steward when Ringback runs in Docker Desktop.
set -euo pipefail

RINGBACK_DIR="${STEWARD_RINGBACK_DIR:-$HOME/Library/Application Support/Steward/ringback}"
VOICE_ENV="$RINGBACK_DIR/voice.env"
[ -f "$VOICE_ENV" ] || { echo "Missing Ringback configuration: $VOICE_ENV" >&2; exit 1; }

set -a
# voice.env is created by Ringback and owned by the local user. It uses shell
# `export KEY=value` syntax, so sourcing it avoids copying secrets elsewhere.
. "$VOICE_ENV"
set +a

case "${VOICE_SIP_ID:-}" in
  ""|*YOURUSER*) echo "Set the Linphone SIP credentials in $VOICE_ENV" >&2; exit 1 ;;
esac

# Docker Desktop for macOS needs STUN for return RTP. `-e NAME` forwards only
# these explicit variables; the rest of the host environment stays private.
export VOICE_STUN="${VOICE_STUN:-stun.linphone.org:3478}"
exec docker run -i --rm \
  -e VOICE_SIP_ID -e VOICE_SIP_USER -e VOICE_SIP_PASS \
  -e VOICE_SIP_CALLEE -e VOICE_SIP_PROXY -e VOICE_DISPLAY_NAME -e VOICE_STUN \
  -e VOICE_HALF_DUPLEX -e VOICE_START_TIMEOUT -e VOICE_END_SILENCE \
  -e VOICE_DEBUG -e VOICE_DEBUG_KEEP_WAV \
  steward-ringback-it:latest
