#!/bin/bash
# Ringback TTS adapter: select the macOS voice from Steward's persisted locale.
set -euo pipefail

OUT_WAV="${1:?output WAV path is required}"
TEXT="${2:?text is required}"
LANG_FILE="${STEWARD_USER_LANG_FILE:-$HOME/Library/Application Support/Steward/notification-lang.json}"
SAY_BIN="${STEWARD_SAY_BIN:-/usr/bin/say}"
LANG_CODE="en"

if [ -f "$LANG_FILE" ]; then
  SAVED_LANG="$(sed -nE 's/.*"lang"[[:space:]]*:[[:space:]]*"(en|it)".*/\1/p' "$LANG_FILE" | head -1)"
  [ -z "$SAVED_LANG" ] || LANG_CODE="$SAVED_LANG"
fi

case "$LANG_CODE" in
  it) VOICE_NAME="${STEWARD_SAY_VOICE_IT:-Alice}" ;;
  *) VOICE_NAME="${STEWARD_SAY_VOICE_EN:-Samantha}" ;;
esac

if ! "$SAY_BIN" -v "$VOICE_NAME" --file-format=WAVE --data-format=LEI16@16000 -o "$OUT_WAV" "$TEXT"; then
  "$SAY_BIN" --file-format=WAVE --data-format=LEI16@16000 -o "$OUT_WAV" "$TEXT"
fi
