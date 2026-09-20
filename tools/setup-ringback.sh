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
WHISPER_MODEL_NAME="ggml-small.bin"

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
if ! grep -q 'def _refresh_audio' "$RINGBACK_DIR/voice_agent.py"; then
  git -C "$RINGBACK_DIR" apply --recount "$STEWARD_ROOT/tools/ringback-steward-media.patch"
fi
if ! grep -q 'VOICE_ANSWER_TIMEOUT' "$RINGBACK_DIR/voice_agent.py"; then
  git -C "$RINGBACK_DIR" apply --recount "$STEWARD_ROOT/tools/ringback-steward-timeout.patch"
fi
if ! grep -q 'remote_reachability' "$RINGBACK_DIR/voice_mcp.py"; then
  git -C "$RINGBACK_DIR" apply --recount "$STEWARD_ROOT/tools/ringback-steward-reliability.patch"
fi
if ! grep -q 'remote_reachability' "$RINGBACK_DIR/voice_mcp.py"; then
  git -C "$RINGBACK_DIR" apply --recount "$STEWARD_ROOT/tools/ringback-steward-reliability.patch"
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

  # The packaged Steward app already carries the multilingual base model. GGML
  # model data is architecture-independent, so the native ARM whisper tools can
  # reuse it even when an older packaged whisper-cli binary was Intel-only.
  if [ -f "$PACKAGED_WHISPER_MODEL" ]; then
    mkdir -p "$HOME/.whisper-models"
    ln -sfn "$PACKAGED_WHISPER_MODEL" "$HOME/.whisper-models/ggml-base.bin"
    WHISPER_MODEL_NAME="ggml-base.bin"
  fi

  # Ringback defaults to English-only Whisper models. Its engine supports the
  # multilingual model, which auto-detects Italian, so ask setup.sh for that one.
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
  if ! grep -q '^export WHISPER_MODEL=' "$VOICE_ENV"; then
    printf '\n# Steward: multilingual Italian speech recognition.\n' >> "$VOICE_ENV"
    printf 'export WHISPER_MODEL="$HOME/.whisper-models/%s"\n' "$WHISPER_MODEL_NAME" >> "$VOICE_ENV"
  fi
  if ! grep -q '^export WHISPER_SERVER_MODEL=' "$VOICE_ENV"; then
    printf 'export WHISPER_SERVER_MODEL="$HOME/.whisper-models/%s"\n' "$WHISPER_MODEL_NAME" >> "$VOICE_ENV"
  fi
  if ! grep -q '^export VOICE_TTS_CMD=' "$VOICE_ENV"; then
    # Ringback's bundled Piper voice is English. Alice is present on Italian
    # macOS installations and produces the temporary audio file Ringback needs.
    printf 'export VOICE_TTS_CMD="say -v Alice --file-format=WAVE --data-format=LEI16@16000 -o {out} {text}"\n' >> "$VOICE_ENV"
  fi
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
  if ! grep -q '^export WHISPER_LANGUAGE=' "$VOICE_ENV"; then
    printf 'export WHISPER_LANGUAGE="it"\n' >> "$VOICE_ENV"
  fi
  if ! grep -q '^export VOICE_ANSWER_TIMEOUT=' "$VOICE_ENV"; then
    printf 'export VOICE_ANSWER_TIMEOUT="60"\n' >> "$VOICE_ENV"
  fi
  LAUNCHER="$RINGBACK_DIR/run_voice_mcp.sh"
fi

echo
echo "Ringback installed at: $RINGBACK_DIR"
echo "Next: edit $RINGBACK_DIR/voice.env with the Linphone SIP credentials."
echo "Also add these lines to Steward's config.env:"
echo "STEWARD_VOICE_TRANSPORT=ringback"
echo "STEWARD_RINGBACK_LAUNCHER=$LAUNCHER"
