#!/bin/bash
# Ringback TTS adapter: select the macOS voice from Steward's persisted locale.
set -euo pipefail

OUT_WAV="${1:?output WAV path is required}"
TEXT="${2:?text is required}"
LANG_FILE="${STEWARD_USER_LANG_FILE:-$HOME/Library/Application Support/Steward/notification-lang.json}"
SETTINGS_FILE="${STEWARD_VOICE_SETTINGS_FILE:-$HOME/Library/Application Support/Steward/voice-settings.json}"
CALL_SETTINGS_FILE="${STEWARD_VOICE_CALL_SETTINGS_FILE:-$HOME/Library/Application Support/Steward/voice-call-settings.json}"
SAY_BIN="${STEWARD_SAY_BIN:-/usr/bin/say}"
LANG_CODE="en"
RATE_WPM="175"
VOICE_SETTING="auto"

if [ -f "$LANG_FILE" ]; then
  SAVED_LANG="$(sed -nE 's/.*"lang"[[:space:]]*:[[:space:]]*"(en|it)".*/\1/p' "$LANG_FILE" | head -1)"
  [ -z "$SAVED_LANG" ] || LANG_CODE="$SAVED_LANG"
fi

if [ -f "$SETTINGS_FILE" ]; then
  SAVED_RATE="$(sed -nE 's/.*"rateWpm"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' "$SETTINGS_FILE" | head -1)"
  SAVED_VOICE="$(sed -nE 's/.*"voice"[[:space:]]*:[[:space:]]*"(auto|Alice|Samantha)".*/\1/p' "$SETTINGS_FILE" | head -1)"
  [ -z "$SAVED_RATE" ] || RATE_WPM="$SAVED_RATE"
  [ -z "$SAVED_VOICE" ] || VOICE_SETTING="$SAVED_VOICE"
fi

if [ -f "$CALL_SETTINGS_FILE" ]; then
  CALL_RATE="$(sed -nE 's/.*"rateWpm"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' "$CALL_SETTINGS_FILE" | head -1)"
  [ -z "$CALL_RATE" ] || RATE_WPM="$CALL_RATE"
fi

if [ "$VOICE_SETTING" = "auto" ]; then
  case "$LANG_CODE" in
    it) VOICE_NAME="${STEWARD_SAY_VOICE_IT:-Alice}" ;;
    *) VOICE_NAME="${STEWARD_SAY_VOICE_EN:-Samantha}" ;;
  esac
else
  VOICE_NAME="$VOICE_SETTING"
fi

if ! "$SAY_BIN" -v "$VOICE_NAME" -r "$RATE_WPM" --file-format=WAVE --data-format=LEI16@16000 -o "$OUT_WAV" "$TEXT"; then
  "$SAY_BIN" -r "$RATE_WPM" --file-format=WAVE --data-format=LEI16@16000 -o "$OUT_WAV" "$TEXT"
fi
