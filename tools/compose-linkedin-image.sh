#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
images_dir="$repo_dir/docs/images"
output_path="${1:-$images_dir/steward-linkedin-square-scripted.png}"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/steward-social.XXXXXX")"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

if ! command -v magick >/dev/null 2>&1; then
  echo "ImageMagick is required (missing 'magick' command)." >&2
  exit 1
fi

desktop_main="$images_dir/chat-home.png"
desktop_back="$images_dir/action-center-open-in-chat.png"
mobile_front="$images_dir/mobile-actions.png"
steward_logo="$images_dir/logo.png"

for source_image in "$desktop_main" "$desktop_back" "$mobile_front" "$steward_logo"; do
  if [[ ! -f "$source_image" ]]; then
    echo "Missing source image: $source_image" >&2
    exit 1
  fi
done

make_rounded_card() {
  local source_image="$1"
  local target_image="$2"
  local width="$3"
  local height="$4"
  local radius="$5"
  local border_color="$6"
  local border_width="$7"

  # Desktop captures include a transparent safety margin around the window.
  # Trim it before scaling so it never becomes a visible matte in the collage.
  magick "$source_image" \
    -trim \
    +repage \
    -filter Lanczos \
    -resize "${width}x${height}!" \
    -alpha on \
    -stroke "$border_color" \
    -strokewidth "$border_width" \
    -fill none \
    -draw "roundrectangle $((border_width / 2)),$((border_width / 2)),$((width - 1 - border_width / 2)),$((height - 1 - border_width / 2)),$radius,$radius" \
    "$target_image"
}

add_shadow() {
  local source_image="$1"
  local target_image="$2"

  # Shadows are drawn directly on the final opaque canvas below. Keeping the
  # cards padding-free avoids alpha-fringe differences between ImageMagick builds.
  magick "$source_image" "$target_image"
}

# The source aspect ratio is preserved for both desktop windows. The phone is
# deliberately cropped to its most useful upper section so UI text stays large.
make_rounded_card "$desktop_back" "$work_dir/back-card.png" 1080 744 24 '#3b4149' 2
make_rounded_card "$desktop_main" "$work_dir/main-card.png" 1240 853 28 '#555c65' 3
make_rounded_card "$mobile_front" "$work_dir/mobile-card.png" 350 760 48 '#5a616b' 3
magick "$steward_logo" \
  -filter Lanczos \
  -resize 150x150 \
  \( -size 150x150 xc:black \
     -fill white \
     -draw 'roundrectangle 0,0 149,149 34,34' \) \
  -alpha off \
  -compose CopyOpacity \
  -composite \
  "$work_dir/logo-card.png"

add_shadow "$work_dir/back-card.png" "$work_dir/back-shadow.png" 58 32 0 24
add_shadow "$work_dir/main-card.png" "$work_dir/main-shadow.png" 72 38 0 28
add_shadow "$work_dir/mobile-card.png" "$work_dir/mobile-shadow.png" 82 34 0 24

# Base: charcoal gradient plus restrained violet and amber pools inspired by
# Steward's UI accents. They are intentionally blurred to avoid a neon look.
magick -size 1600x1600 gradient:'#16171b-#08090b' \
  -rotate 90 \
  "$work_dir/base.png"

magick -size 400x400 xc:none \
  -fill 'rgba(100,72,255,0.24)' \
  -draw 'circle 42,90 130,90' \
  -blur 0x38 \
  -resize 1600x1600 \
  "$work_dir/violet-glow.png"

magick -size 400x400 xc:none \
  -fill 'rgba(255,139,31,0.18)' \
  -draw 'circle 368,258 290,258' \
  -blur 0x43 \
  -resize 1600x1600 \
  "$work_dir/amber-glow.png"

magick "$work_dir/base.png" \
  "$work_dir/violet-glow.png" -compose over -composite \
  "$work_dir/amber-glow.png" -compose over -composite \
  -fill 'rgba(0,0,0,0.52)' -stroke none \
  -draw 'roundrectangle 520,185 1580,909 28,28' \
  -draw 'roundrectangle 150,445 1370,1278 32,32' \
  -draw 'roundrectangle 1260,815 1599,1555 52,52' \
  -fill 'rgba(0,0,0,0.38)' \
  -draw 'roundrectangle 104,104 274,274 44,44' \
  "$work_dir/logo-card.png" -geometry +112+112 -compose over -composite \
  "$work_dir/back-shadow.png" -geometry +500+155 -compose over -composite \
  "$work_dir/main-shadow.png" -geometry +130+415 -compose over -composite \
  "$work_dir/mobile-shadow.png" -geometry +1240+785 -compose over -composite \
  -colorspace sRGB \
  -strip \
  -quality 94 \
  "$output_path"

echo "Created $output_path"
