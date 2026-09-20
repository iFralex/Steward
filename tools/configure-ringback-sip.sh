#!/bin/bash
# Store the Ringback SIP password in macOS Keychain, never in argv or voice.env.
set -euo pipefail

MODE="configure"
if [ "${1:-}" = "--migrate-legacy" ]; then
  MODE="migrate"
  shift
fi
USERNAME="${1:-}"
VOICE_ENV="$HOME/Library/Application Support/Steward/ringback/voice.env"
KEYCHAIN_SERVICE="com.steward.ringback.sip"

case "$USERNAME" in
  ""|*[!A-Za-z0-9._-]*)
    echo "Usage: $0 [--migrate-legacy] <linphone-username>" >&2
    exit 1
    ;;
esac

[ -f "$VOICE_ENV" ] || {
  echo "Missing Ringback configuration: $VOICE_ENV" >&2
  exit 1
}

store_password() {
  local password="$1"
  # security(1) asks for the new value and its confirmation when -w is last.
  # Supply both over stdin so the secret never appears in the process argv.
  printf '%s\n%s\n' "$password" "$password" | /usr/bin/security add-generic-password \
    -a "$USERNAME" -s "$KEYCHAIN_SERVICE" -D "application password" \
    -l "Steward Ringback SIP ($USERNAME)" -U -w
}

if [ "$MODE" = "migrate" ]; then
  # The old value travels only through the pipe. It is never present in the
  # security process argv and is scrubbed from voice.env only after success.
  if ! grep -q '^export VOICE_SIP_PASS=.' "$VOICE_ENV"; then
    echo "No legacy VOICE_SIP_PASS value found in: $VOICE_ENV" >&2
    exit 1
  fi
  LEGACY_PASSWORD="$(
    unset VOICE_SIP_PASS
    # shellcheck disable=SC1090
    . "$VOICE_ENV"
    printf '%s\n' "$VOICE_SIP_PASS"
  )"
  store_password "$LEGACY_PASSWORD"
  unset LEGACY_PASSWORD
else
  if [ -t 0 ]; then
    printf 'Linphone SIP password (input hidden): ' >&2
    IFS= read -r -s PASSWORD
    printf '\n' >&2
  else
    PASSWORD="$(/usr/bin/osascript -e 'text returned of (display dialog "Password SIP Linphone" default answer "" with hidden answer buttons {"Annulla", "Salva"} default button "Salva" cancel button "Annulla" with title "Steward · Ringback")')"
  fi
  [ -n "$PASSWORD" ] || { echo "Password cannot be empty." >&2; exit 1; }
  store_password "$PASSWORD"
  unset PASSWORD
fi

TMP_FILE="$(mktemp "${VOICE_ENV}.XXXXXX")"
trap 'rm -f "$TMP_FILE"' EXIT

awk '
  !/^export VOICE_SIP_ID=/ &&
  !/^export VOICE_SIP_USER=/ &&
  !/^export VOICE_SIP_PASS=/ { print }
' "$VOICE_ENV" > "$TMP_FILE"

printf '\n# Linphone SIP account. Password: macOS Keychain service %s.\n' "$KEYCHAIN_SERVICE" >> "$TMP_FILE"
printf 'export VOICE_SIP_ID=%q\n' "sip:$USERNAME@sip.linphone.org" >> "$TMP_FILE"
printf 'export VOICE_SIP_USER=%q\n' "$USERNAME" >> "$TMP_FILE"
chmod 600 "$TMP_FILE"
mv "$TMP_FILE" "$VOICE_ENV"
trap - EXIT

echo "Ringback SIP account configured for $USERNAME; password stored in macOS Keychain."
