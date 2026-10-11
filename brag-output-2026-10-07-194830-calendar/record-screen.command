#!/bin/bash
set -euo pipefail

if [[ "${1:-}" == "--help" ]]; then
  echo 'Record the actual full display silently for up to 120 seconds. Press q to finish early.'
  echo 'Output: calendar-oauth-raw.mp4 beside this script. Existing recordings are preserved.'
  echo 'Requires macOS, ffmpeg, ffprobe, python3 and Screen Recording access.'
  exit 0
fi

cd -- "$(dirname -- "$0")"
for recording_tool in ffmpeg ffprobe python3; do
  command -v "$recording_tool" >/dev/null || { echo "Missing tool: $recording_tool" >&2; exit 1; }
done
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'This capture helper uses macOS AVFoundation.' >&2
  exit 1
fi

recording_file='calendar-oauth-raw.mp4'
if [[ -e "$recording_file" ]]; then
  echo 'calendar-oauth-raw.mp4 already exists; move it before recording another take.' >&2
  exit 1
fi

recording_device="$(python3 - <<'PY'
import re, subprocess, sys
result = subprocess.run(
    ['ffmpeg', '-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
    capture_output=True, text=True, timeout=15,
)
video_devices = result.stderr.split('AVFoundation audio devices:')[0]
match = re.search(r'\[(\d+)\] Capture screen 0\b', video_devices)
if match is None:
    sys.exit('No AVFoundation Capture screen 0 device found.')
print(match.group(1))
PY
)"

echo 'Capturing the entire display silently. Press q here to stop, or wait up to 120 seconds.'
ffmpeg -hide_banner -n -f avfoundation -capture_cursor 1 -framerate 30 \
  -i "${recording_device}:none" -t 120 -an \
  -vf 'pad=ceil(iw/2)*2:ceil(ih/2)*2' \
  -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p \
  -movflags +faststart "$recording_file"

ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,width,height,r_frame_rate,nb_frames:format=duration,size \
  -of json "$recording_file" > capture-metadata.json
echo 'Saved calendar-oauth-raw.mp4 and capture-metadata.json. Review the full capture before delivery.'
