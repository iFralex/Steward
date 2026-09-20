#!/bin/bash
# Steward-owned lifecycle wrapper for Ringback's stdio MCP server.
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VOICE_ENV="${STEWARD_RINGBACK_ENV:-$APP/voice.env}"
RUNTIME_DIR="${STEWARD_RINGBACK_RUNTIME_DIR:-$APP/.steward-runtime}"
LOCK_DIR="$RUNTIME_DIR/voice-mcp.lock"
PID_FILE="$LOCK_DIR/pid"
MANIFEST="$APP/steward-runtime.json"
KEYCHAIN_SERVICE="${STEWARD_RINGBACK_KEYCHAIN_SERVICE:-com.steward.ringback.sip}"
CREDENTIAL_STORE="missing"

load_environment() {
  if [ -f "$VOICE_ENV" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$VOICE_ENV"
    set +a
  fi

  if [ -n "${VOICE_SIP_USER:-}" ]; then
    keychain_password="$(/usr/bin/security find-generic-password -a "$VOICE_SIP_USER" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)"
    if [ -n "$keychain_password" ]; then
      VOICE_SIP_PASS="$keychain_password"
      export VOICE_SIP_PASS
      CREDENTIAL_STORE="keychain"
      unset keychain_password
    elif [ -n "${VOICE_SIP_PASS:-}" ]; then
      CREDENTIAL_STORE="legacy-env"
    fi
  fi

  PJPROJECT_DIR="${PJPROJECT_DIR:-$HOME/build/pjproject-2.17}"
  PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 || true)}"
  OPENSSL_PREFIX="${OPENSSL_PREFIX:-/opt/homebrew/opt/openssl@3}"
  SWIG_LIB="$(find "$PJPROJECT_DIR/pjsip-apps/src/swig/python/build" -maxdepth 1 -type d -name 'lib.*' -print -quit 2>/dev/null || true)"
  export PJPROJECT_DIR PYTHON_BIN OPENSSL_PREFIX
  export PYTHONPATH="$SWIG_LIB:$APP"
  export DYLD_LIBRARY_PATH="$PJPROJECT_DIR/pjlib/lib:$PJPROJECT_DIR/pjlib-util/lib:$PJPROJECT_DIR/pjnath/lib:$PJPROJECT_DIR/pjmedia/lib:$PJPROJECT_DIR/pjsip/lib:$PJPROJECT_DIR/third_party/lib:$OPENSSL_PREFIX/lib"
  export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"
}

check_runtime() {
  local failed=0
  [ "$(uname -m)" = "arm64" ] || { echo "ringback-voice: expected arm64 macOS" >&2; failed=1; }
  [ -x /opt/homebrew/bin/brew ] || { echo "ringback-voice: ARM Homebrew is missing" >&2; failed=1; }
  [ -x "$PYTHON_BIN" ] || { echo "ringback-voice: configured Python is missing" >&2; failed=1; }
  [ -n "$SWIG_LIB" ] || { echo "ringback-voice: pjsua2 build is missing under $PJPROJECT_DIR" >&2; failed=1; }
  [ -f "$APP/voice_mcp.py" ] || { echo "ringback-voice: voice_mcp.py is missing" >&2; failed=1; }
  [ -n "${WHISPER_MODEL:-}" ] && [ -f "${WHISPER_MODEL:-}" ] || { echo "ringback-voice: Whisper model is missing" >&2; failed=1; }
  [ -n "${VOICE_SIP_ID:-}" ] || { echo "ringback-voice: VOICE_SIP_ID is not configured" >&2; failed=1; }
  [ -n "${VOICE_SIP_USER:-}" ] || { echo "ringback-voice: VOICE_SIP_USER is not configured" >&2; failed=1; }
  [ -n "${VOICE_SIP_PASS:-}" ] || { echo "ringback-voice: VOICE_SIP_PASS is not configured" >&2; failed=1; }
  return "$failed"
}

doctor() {
  load_environment
  local ok=true python_arch="missing" pjsua2=false version="unknown"
  [ -f "$MANIFEST" ] && version="$(sed -nE 's/.*"runtimeVersion"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$MANIFEST" | head -1)"
  if [ -x "$PYTHON_BIN" ]; then
    python_arch="$(file -b -L "$PYTHON_BIN" 2>/dev/null || echo unknown)"
  fi
  if ! check_runtime >/dev/null 2>&1; then ok=false; fi
  if [ -x "$PYTHON_BIN" ] && [ -n "$SWIG_LIB" ] && "$PYTHON_BIN" -c 'import pjsua2' >/dev/null 2>&1; then
    pjsua2=true
  else
    ok=false
  fi
  printf '{"ok":%s,"runtimeVersion":"%s","architecture":"%s","pythonArchitecture":"%s","pjsua2":%s,"credentialStore":"%s","managed":true}\n' \
    "$ok" "$version" "$(uname -m)" "$(printf '%s' "$python_arch" | sed 's/["\\]/\\&/g')" "$pjsua2" "$CREDENTIAL_STORE"
  [ "$ok" = true ]
}

stop_runtime() {
  if [ ! -f "$PID_FILE" ]; then
    echo "Ringback is not running."
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  case "$pid" in
    ''|*[!0-9]*) echo "Removing stale Ringback runtime lock."; rm -rf "$LOCK_DIR"; return 0 ;;
  esac
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid"
    echo "Asked Ringback process $pid to stop. Restart Steward before the next call."
  else
    rm -rf "$LOCK_DIR"
    echo "Removed stale Ringback runtime lock."
  fi
}

case "${1:-}" in
  --doctor) doctor; exit $? ;;
  --version) [ -f "$MANIFEST" ] && cat "$MANIFEST" || { echo "Ringback runtime manifest is missing." >&2; exit 1; }; exit 0 ;;
  --stop) stop_runtime; exit $? ;;
  "") ;;
  *) echo "Usage: $0 [--doctor|--version|--stop]" >&2; exit 64 ;;
esac

load_environment
check_runtime
mkdir -p "$RUNTIME_DIR"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  running_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$running_pid" ] && kill -0 "$running_pid" 2>/dev/null; then
    echo "ringback-voice: another managed instance is already running (pid $running_pid)" >&2
    exit 75
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
fi
printf '%s\n' "$$" > "$PID_FILE"

child_pid=""
cleanup() {
  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  rm -rf "$LOCK_DIR"
}
trap cleanup EXIT INT TERM HUP

# Bash redirects stdin to /dev/null for asynchronous commands when job control
# is disabled unless an explicit stdin redirection is present. MCP is a stdio
# protocol, so preserve the parent pipe or the server sees EOF and exits before
# it can answer initialize/listTools.
"$PYTHON_BIN" "$APP/voice_mcp.py" <&0 &
child_pid=$!
wait "$child_pid"
exit_code=$?
child_pid=""
exit "$exit_code"
