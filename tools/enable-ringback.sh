#!/bin/bash
# Enable the already-installed Ringback transport in Steward's local config.
# SIP account metadata stays in voice.env; its password stays in macOS Keychain.
set -euo pipefail

CONFIG_DIR="$HOME/Library/Application Support/Steward"
CONFIG_FILE="$CONFIG_DIR/config.env"
LAUNCHER="$CONFIG_DIR/ringback/steward-run-voice-mcp.sh"

[ -x "$LAUNCHER" ] || {
  echo "Ringback launcher not found or not executable: $LAUNCHER" >&2
  echo "Run ./tools/setup-ringback.sh first." >&2
  exit 1
}

mkdir -p "$CONFIG_DIR"
touch "$CONFIG_FILE"
TMP_FILE="$(mktemp "$CONFIG_DIR/config.env.XXXXXX")"

awk '
  !/^STEWARD_VOICE_TRANSPORT=/ &&
  !/^STEWARD_RINGBACK_LAUNCHER=/ &&
  !/^STEWARD_VOICE_OPENING_LINE=/ { print }
' "$CONFIG_FILE" > "$TMP_FILE"

printf '\n# Native phone-call transport (Ringback / SIP).\n' >> "$TMP_FILE"
printf 'STEWARD_VOICE_TRANSPORT=ringback\n' >> "$TMP_FILE"
printf 'STEWARD_RINGBACK_LAUNCHER="%s"\n' "$LAUNCHER" >> "$TMP_FILE"
printf 'STEWARD_VOICE_OPENING_LINE="Ciao, sono Steward. Come posso aiutarti?"\n' >> "$TMP_FILE"

chmod 600 "$TMP_FILE"
mv "$TMP_FILE" "$CONFIG_FILE"
echo "Ringback enabled in: $CONFIG_FILE"
