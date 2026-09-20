#!/bin/bash
# Download and install the Ringback SIP/MCP transport outside the Steward bundle.
# It intentionally does not write SIP credentials or modify Steward's config.
set -euo pipefail

RINGBACK_REPO="https://github.com/mohitbadwal/ringback.git"
RINGBACK_COMMIT="dfadf47ef5f106079cb11d48daaa4da39825e140"
RINGBACK_DIR="${STEWARD_RINGBACK_DIR:-$HOME/Library/Application Support/Steward/ringback}"
STEWARD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-auto}"
ARM_BREW="/opt/homebrew/bin/brew"
PACKAGED_WHISPER_MODEL="/Applications/Steward.app/Contents/Resources/speech/models/ggml-base.bin"
WHISPER_MODEL_NAME="ggml-large-v3-turbo-q5_0.bin"

if [ -e "$RINGBACK_DIR" ] && [ ! -d "$RINGBACK_DIR/.git" ]; then
  echo "Refusing to overwrite existing non-git path: $RINGBACK_DIR" >&2
  exit 1
fi

if [ ! -d "$RINGBACK_DIR/.git" ]; then
  mkdir -p "$(dirname "$RINGBACK_DIR")"
  git clone "$RINGBACK_REPO" "$RINGBACK_DIR"
fi

git -C "$RINGBACK_DIR" fetch origin "$RINGBACK_COMMIT"
git -C "$RINGBACK_DIR" checkout --detach "$RINGBACK_COMMIT"

# Upstream creates UDP and TLS listeners but documents TCP as an accepted proxy
# value. Initialize TCP as well so Linphone's standard port 5060 can be used
# when TLS negotiation is unavailable on the local pjproject/OpenSSL build.
if ! grep -q 'PJSIP_TRANSPORT_TCP' "$RINGBACK_DIR/voice_agent.py"; then
  git -C "$RINGBACK_DIR" apply "$STEWARD_ROOT/tools/ringback-steward.patch"
fi
if ! grep -q '^WHISPER_LANGUAGE =' "$RINGBACK_DIR/voice_agent.py"; then
  git -C "$RINGBACK_DIR" apply --recount "$STEWARD_ROOT/tools/ringback-steward-runtime.patch"
fi
if ! grep -q '^STEWARD_LANGUAGE_FILE =' "$RINGBACK_DIR/voice_agent.py"; then
  git -C "$RINGBACK_DIR" apply --recount "$STEWARD_ROOT/tools/ringback-steward-language.patch"
fi
if ! grep -q '^WHISPER_NO_GPU =' "$RINGBACK_DIR/voice_agent.py"; then
  git -C "$RINGBACK_DIR" apply --recount "$STEWARD_ROOT/tools/ringback-steward-whisper-cpu.patch"
fi
if ! grep -q 'def _refresh_audio' "$RINGBACK_DIR/voice_agent.py"; then
  git -C "$RINGBACK_DIR" apply --recount "$STEWARD_ROOT/tools/ringback-steward-media.patch"
fi
if ! grep -q 'VOICE_ANSWER_TIMEOUT' "$RINGBACK_DIR/voice_agent.py"; then
  git -C "$RINGBACK_DIR" apply --recount "$STEWARD_ROOT/tools/ringback-steward-timeout.patch"
fi
if ! grep -q 'remote_reachability' "$RINGBACK_DIR/voice_mcp.py"; then
  git -C "$RINGBACK_DIR" apply --recount "$STEWARD_ROOT/tools/ringback-steward-reliability.patch"
fi
if ! grep -q 'dialDurationMs' "$RINGBACK_DIR/voice_mcp.py"; then
  git -C "$RINGBACK_DIR" apply --recount "$STEWARD_ROOT/tools/ringback-steward-diagnostics.patch"
fi

# Ringback compiles a Python extension against Homebrew libraries. Always use
# the native Apple Silicon toolchain when it is available; /usr/local may still
# contain a separate legacy Intel Homebrew used by older software.
if [ "$MODE" = "auto" ]; then
  MODE="native"
fi

if [ "$MODE" = "docker" ] || [ "$MODE" = "--docker" ]; then
  command -v docker >/dev/null || { echo "Docker is required for Ringback's container runtime." >&2; exit 1; }
  docker info >/dev/null 2>&1 || { echo "Start Docker Desktop, then run this helper again." >&2; exit 1; }
  docker build -t ringback:steward-base "$RINGBACK_DIR"
  docker build \
    --build-arg RINGBACK_BASE=ringback:steward-base \
    -t steward-ringback-it:latest \
    -f "$STEWARD_ROOT/tools/ringback-it.Dockerfile" \
    "$STEWARD_ROOT/tools"
  [ -f "$RINGBACK_DIR/voice.env" ] || cp "$RINGBACK_DIR/voice.env.example" "$RINGBACK_DIR/voice.env"
  LAUNCHER="$STEWARD_ROOT/tools/run-ringback-docker.sh"
else
  if [ "$(uname -m)" = "arm64" ]; then
    if [ ! -x "$ARM_BREW" ]; then
      echo "Native ARM Homebrew is required at $ARM_BREW." >&2
      echo "Install it from https://brew.sh, then run this helper again." >&2
      exit 1
    fi

    export PATH="/opt/homebrew/opt/python@3.12/libexec/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
    [ "$(brew --prefix)" = "/opt/homebrew" ] || {
      echo "Refusing to build Ringback with a non-ARM Homebrew." >&2
      exit 1
    }

    # Do not let the old python.org x86_64 interpreter build pjsua2. Keeping a
    # dedicated Homebrew Python also avoids modifying macOS' Python packages.
    NONINTERACTIVE=1 HOMEBREW_NO_AUTO_UPDATE=1 brew install python@3.12 pkgconf
    BREW_PYTHON="/opt/homebrew/bin/python3.12"
    VENV_DIR="$RINGBACK_DIR/.venv"
    [ -x "$VENV_DIR/bin/python3" ] || "$BREW_PYTHON" -m venv "$VENV_DIR"
    PYTHON_BIN="$VENV_DIR/bin/python3"
    "$PYTHON_BIN" -m pip install --quiet --upgrade pip setuptools
    export PATH="$VENV_DIR/bin:$PATH"
    PYTHON_ARCH="$(file -L "$PYTHON_BIN")"
    case "$PYTHON_ARCH" in
      *arm64*) ;;
      *) echo "Expected an arm64 Python, got: $PYTHON_ARCH" >&2; exit 1 ;;
    esac
    export PYTHON_BIN
    export PKG_CONFIG_PATH="/opt/homebrew/lib/pkgconfig:/opt/homebrew/share/pkgconfig:/opt/homebrew/opt/ffmpeg/lib/pkgconfig"
    # Upstream extracts the archive with this fixed basename. The directory is
    # safe here because the earlier Intel attempt never reached pjproject.
    export PJPROJECT_DIR="${PJPROJECT_DIR:-$HOME/build/pjproject-2.17}"
  fi

  # Keep the packaged multilingual base model as an offline fallback, but use
  # large-v3-turbo q5 by default for much better phone transcription on M-series Macs.
  if [ -f "$PACKAGED_WHISPER_MODEL" ]; then
    mkdir -p "$HOME/.whisper-models"
    ln -sfn "$PACKAGED_WHISPER_MODEL" "$HOME/.whisper-models/ggml-base.bin"
  fi

  # Ringback defaults to English-only Whisper models. Use the multilingual
  # Turbo q5 model (~547 MiB), with language selected dynamically by Steward.
  NONINTERACTIVE=1 HOMEBREW_NO_AUTO_UPDATE=1 WHISPER_MODEL_NAME="$WHISPER_MODEL_NAME" "$RINGBACK_DIR/setup.sh"

  # pjproject's default flat namespace can bind Python to the wrong OpenSSL on
  # macOS and crash during SIP initialization. The upstream repair omits nested
  # libsrtp objects on pjproject 2.17; use Steward's archive-based variant.
  PJPROJECT_DIR="$PJPROJECT_DIR" \
    OPENSSL_PREFIX="/opt/homebrew/opt/openssl@3" \
    HOMEBREW_PREFIX="/opt/homebrew" \
    "$STEWARD_ROOT/tools/fix-ringback-macos-twolevel.sh"

  # Ringback currently imports FastMCP from the 1.x SDK. Its upstream
  # unconstrained requirement also accepts mcp 2.x, whose API is incompatible.
  "$PYTHON_BIN" -m pip install --quiet 'mcp>=1.2,<2'

  VOICE_ENV="$RINGBACK_DIR/voice.env"
  if ! grep -q '^export PYTHON_BIN=' "$VOICE_ENV"; then
    printf '\n# Steward: native Apple Silicon runtime.\n' >> "$VOICE_ENV"
    printf 'export PYTHON_BIN="%s"\n' "$PYTHON_BIN" >> "$VOICE_ENV"
  fi
  if ! grep -q '^export PJPROJECT_DIR=' "$VOICE_ENV"; then
    printf 'export PJPROJECT_DIR="%s"\n' "$PJPROJECT_DIR" >> "$VOICE_ENV"
  fi
  if ! grep -q '^export OPENSSL_PREFIX=' "$VOICE_ENV"; then
    printf 'export OPENSSL_PREFIX="/opt/homebrew/opt/openssl@3"\n' >> "$VOICE_ENV"
  fi
  MODEL_TMP="$(mktemp "$RINGBACK_DIR/voice.env.model.XXXXXX")"
  awk '!/^export WHISPER_MODEL=/ && !/^export WHISPER_SERVER_MODEL=/' "$VOICE_ENV" > "$MODEL_TMP"
  printf '\n# Steward: multilingual large-v3-turbo q5 speech recognition.\n' >> "$MODEL_TMP"
  printf 'export WHISPER_MODEL="$HOME/.whisper-models/%s"\n' "$WHISPER_MODEL_NAME" >> "$MODEL_TMP"
  printf 'export WHISPER_SERVER_MODEL="$HOME/.whisper-models/%s"\n' "$WHISPER_MODEL_NAME" >> "$MODEL_TMP"
  mv "$MODEL_TMP" "$VOICE_ENV"
  # Select Alice/Samantha at synthesis time from Steward's persisted user
  # language. Replacing the old fixed-Alice command migrates existing installs.
  install -m 755 "$STEWARD_ROOT/tools/ringback-say-localized.sh" "$RINGBACK_DIR/steward-say-localized.sh"
  TTS_TMP="$(mktemp "$RINGBACK_DIR/voice.env.tts.XXXXXX")"
  awk '!/^export VOICE_TTS_CMD=/' "$VOICE_ENV" > "$TTS_TMP"
  printf 'export VOICE_TTS_CMD="\\\"%s\\\" {out} {text}"\n' "$RINGBACK_DIR/steward-say-localized.sh" >> "$TTS_TMP"
  mv "$TTS_TMP" "$VOICE_ENV"
  if ! grep -q '^export VOICE_NULL_AUDIO=' "$VOICE_ENV"; then
    # pjproject's null device intermittently disconnects WAV players/recorders
    # from the conference bridge on macOS. CoreAudio is required for reliable
    # bidirectional media; Ringback still never routes the Mac mic into RTP.
    printf 'export VOICE_NULL_AUDIO="0"\n' >> "$VOICE_ENV"
  fi
  if ! grep -q '^export VOICE_HALF_DUPLEX=' "$VOICE_ENV"; then
    printf 'export VOICE_HALF_DUPLEX="1"\n' >> "$VOICE_ENV"
  fi
  if ! grep -q '^export VOICE_AUDIO_CODEC=' "$VOICE_ENV"; then
    printf 'export VOICE_AUDIO_CODEC="opus/48000/2"\n' >> "$VOICE_ENV"
  fi
  # voice_agent reads Steward's persisted language per inference. `auto` is the
  # safe fallback before Steward has written its user-language setting.
  LANG_TMP="$(mktemp "$RINGBACK_DIR/voice.env.lang.XXXXXX")"
  awk '!/^export WHISPER_LANGUAGE=/ && !/^export WHISPER_NO_GPU=/' "$VOICE_ENV" > "$LANG_TMP"
  printf 'export WHISPER_LANGUAGE="auto"\n' >> "$LANG_TMP"
  printf 'export WHISPER_NO_GPU="1"\n' >> "$LANG_TMP"
  mv "$LANG_TMP" "$VOICE_ENV"
  if ! grep -q '^export VOICE_ANSWER_TIMEOUT=' "$VOICE_ENV"; then
    printf 'export VOICE_ANSWER_TIMEOUT="60"\n' >> "$VOICE_ENV"
  fi
  install -m 755 "$STEWARD_ROOT/tools/run-ringback-managed.sh" "$RINGBACK_DIR/steward-run-voice-mcp.sh"
  install -m 644 "$STEWARD_ROOT/tools/ringback-runtime.json" "$RINGBACK_DIR/steward-runtime.json"
  LAUNCHER="$RINGBACK_DIR/steward-run-voice-mcp.sh"
fi

echo
echo "Ringback installed at: $RINGBACK_DIR"
echo "Next: run ./tools/configure-ringback-sip.sh <linphone-username>."
echo "Also add these lines to Steward's config.env:"
echo "STEWARD_VOICE_TRANSPORT=ringback"
echo "STEWARD_RINGBACK_LAUNCHER=$LAUNCHER"
