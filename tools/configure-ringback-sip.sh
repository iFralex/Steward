#!/bin/bash
# Configure Ringback SIP credentials without putting the password in argv.
set -euo pipefail

USERNAME="${1:-}"
VOICE_ENV="$HOME/Library/Application Support/Steward/ringback/voice.env"

case "$USERNAME" in
  ""|*[!A-Za-z0-9._-]*)
    echo "Usage: $0 <linphone-username>" >&2
    exit 1
    ;;
esac

[ -f "$VOICE_ENV" ] || {
  echo "Missing Ringback configuration: $VOICE_ENV" >&2
  exit 1
}

printf 'Linphone SIP password (input hidden): ' >&2
IFS= read -r -s PASSWORD
printf '\n' >&2
[ -n "$PASSWORD" ] || { echo "Password cannot be empty." >&2; exit 1; }

TMP_FILE="$(mktemp "${VOICE_ENV}.XXXXXX")"
trap 'rm -f "$TMP_FILE"' EXIT

awk '
  !/^export VOICE_SIP_ID=/ &&
  !/^export VOICE_SIP_USER=/ &&
  !/^export VOICE_SIP_PASS=/ { print }
' "$VOICE_ENV" > "$TMP_FILE"

printf '\n# Linphone SIP account.\n' >> "$TMP_FILE"
printf 'export VOICE_SIP_ID=%q\n' "sip:$USERNAME@sip.linphone.org" >> "$TMP_FILE"
printf 'export VOICE_SIP_USER=%q\n' "$USERNAME" >> "$TMP_FILE"
printf 'export VOICE_SIP_PASS=%q\n' "$PASSWORD" >> "$TMP_FILE"
chmod 600 "$TMP_FILE"
mv "$TMP_FILE" "$VOICE_ENV"
trap - EXIT
unset PASSWORD

echo "Ringback SIP account configured for: $USERNAME"
