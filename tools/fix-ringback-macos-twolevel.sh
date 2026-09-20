#!/bin/bash
# Relink pjproject's OpenSSL-using dylibs with a two-level namespace on macOS.
#
# Ringback's upstream helper expands ** from a variable. Bash treats that as a
# normal pair of stars after parameter expansion, so nested libsrtp objects are
# omitted on pjproject 2.17. Force-loading the already-built static archives is
# both simpler and guarantees that every object belonging to each library is
# present in the replacement dylib.
set -euo pipefail

PJ="${PJPROJECT_DIR:-$HOME/build/pjproject-2.17}"
OPENSSL_PREFIX="${OPENSSL_PREFIX:-/opt/homebrew/opt/openssl@3}"
HOMEBREW_PREFIX="${HOMEBREW_PREFIX:-/opt/homebrew}"

detected="$(find "$PJ/pjlib/build/output" -maxdepth 1 -type d -name 'pjlib-*' ! -name 'pjlib-test-*' -print -quit)"
[ -n "$detected" ] || { echo "pjproject build target not found under $PJ" >&2; exit 1; }
TARGET="${TARGET:-${detected##*/pjlib-}}"
case "$TARGET" in
  aarch64-*|arm64-*) ARCH="${ARCH:-arm64}" ;;
  x86_64-*) ARCH="${ARCH:-x86_64}" ;;
  *) echo "Unsupported pjproject target: $TARGET" >&2; exit 1 ;;
esac

FRAMEWORKS=(
  -framework CoreAudio -framework CoreServices -framework AudioUnit
  -framework AudioToolbox -framework Foundation -framework AppKit
  -framework AVFoundation -framework CoreGraphics -framework QuartzCore
  -framework CoreVideo -framework CoreMedia -framework Metal
  -framework MetalKit -framework VideoToolbox
)
EXTLIBS=(
  -L"$OPENSSL_PREFIX/lib" -lssl -lcrypto
  -L"$HOMEBREW_PREFIX/lib" -lopus -lSDL2 -lavdevice -lavutil -lswscale
  -lm -lpthread -lc++
)

build_dylib() {
  local archive="$1" install_name="$2" output="$3"
  shift 3
  [ -f "$archive" ] || { echo "Static archive not found: $archive" >&2; exit 1; }
  clang -dynamiclib -twolevel_namespace -arch "$ARCH" \
    -install_name "$install_name" -compatibility_version 0 -current_version 0 \
    -Wl,-force_load,"$archive" "$@" "${EXTLIBS[@]}" "${FRAMEWORKS[@]}" \
    -o "$output"
  otool -hv "$output" | sed -n '4p' | grep -q TWOLEVEL
}

tmp="$(mktemp -d /tmp/steward-ringback-twolevel.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

echo "Relinking pjproject $TARGET ($ARCH) with $OPENSSL_PREFIX"
build_dylib \
  "$PJ/third_party/lib/libsrtp-$TARGET.a" \
  "../../lib/libsrtp.dylib.2" "$tmp/libsrtp.dylib.2" \
  "$PJ/pjlib/lib/libpj.dylib.2"
build_dylib \
  "$PJ/pjlib/lib/libpj-$TARGET.a" \
  "../lib/libpj.dylib.2" "$tmp/libpj.dylib.2"
build_dylib \
  "$PJ/pjsip/lib/libpjsip-$TARGET.a" \
  "../lib/libpjsip.dylib.2" "$tmp/libpjsip.dylib.2" \
  "$PJ/pjlib/lib/libpj.dylib.2" "$PJ/pjlib-util/lib/libpjlib-util.dylib.2"
build_dylib \
  "$PJ/pjmedia/lib/libpjmedia-$TARGET.a" \
  "../lib/libpjmedia.dylib.2" "$tmp/libpjmedia.dylib.2" \
  "$PJ/pjlib/lib/libpj.dylib.2" "$PJ/pjlib-util/lib/libpjlib-util.dylib.2" \
  "$PJ/pjnath/lib/libpjnath.dylib.2" "$PJ/third_party/lib/libsrtp.dylib.2" \
  "$PJ/third_party/lib/libresample.dylib.2" "$PJ/third_party/lib/libgsmcodec.dylib.2" \
  "$PJ/third_party/lib/libspeex.dylib.2" "$PJ/third_party/lib/libilbccodec.dylib.2" \
  "$PJ/third_party/lib/libg7221codec.dylib.2" "$PJ/third_party/lib/libwebrtc.dylib.2" \
  "$PJ/third_party/lib/libyuv.dylib.2"

swap() {
  local source="$1" destination="$2"
  [ -e "$destination.flatns-bkp" ] || cp -p "$destination" "$destination.flatns-bkp"
  cp -p "$source" "$destination"
  # Copying over an existing Mach-O can leave the kernel's cached ad-hoc
  # signature associated with the old vnode mtime. Re-sign the final path so
  # AMFI validates the replacement instead of killing Python during import.
  codesign --force --sign - "$destination"
  echo "  fixed $(basename "$destination")"
}

swap "$tmp/libsrtp.dylib.2" "$PJ/third_party/lib/libsrtp.dylib.2"
swap "$tmp/libpj.dylib.2" "$PJ/pjlib/lib/libpj.dylib.2"
swap "$tmp/libpjsip.dylib.2" "$PJ/pjsip/lib/libpjsip.dylib.2"
swap "$tmp/libpjmedia.dylib.2" "$PJ/pjmedia/lib/libpjmedia.dylib.2"

echo "Ringback pjproject dylibs now use the macOS two-level namespace."
