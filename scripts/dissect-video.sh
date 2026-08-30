#!/bin/sh
# Dissect a screen recording into what a session can actually read: contact sheets for the
# sweep, full-res frames for the moments worth reading, and the narration as text.
#
#   scripts/dissect-video.sh <video> <outdir>              # probe + frames + sheets + transcript
#   scripts/dissect-video.sh <video> <outdir> 1:23 2:41 …  # ALSO pull full-res frames at times
#
# The workflow this exists for: run it, Read the sheet-*.png files (6 ticks per sheet = 36s
# of video each), read transcript.txt for what the operator was saying, then re-run with the
# timestamps worth reading at full resolution. Transcription needs `whisper` on PATH
# (brew install openai-whisper); everything else is ffmpeg.
set -eu
VIDEO=$1; OUT=$2; shift 2 || true
mkdir -p "$OUT"

ffprobe -v error -show_entries format=duration:stream=codec_type,width,height -of json "$VIDEO" > "$OUT/probe.json"
printf 'probe    %s\n' "$(python3 -c "
import json;d=json.load(open('$OUT/probe.json'))
v=[s for s in d['streams'] if s['codec_type']=='video'][0]
a=any(s['codec_type']=='audio' for s in d['streams'])
print(f\"{float(d['format']['duration']):.0f}s {v['width']}x{v['height']} audio={'yes' if a else 'NO'}\")")"

# Full-res pulls first: when timestamps are given, that is usually the second pass and all
# the caller wants.
for t in "$@"; do
  ffmpeg -v error -ss "$t" -i "$VIDEO" -frames:v 1 "$OUT/full-$(echo "$t" | tr ':.' '--').png"
  printf 'full     %s\n' "$OUT/full-$(echo "$t" | tr ':.' '--').png"
done
[ $# -gt 0 ] && exit 0

# One frame every 6s, half-ish scale, tiled 2x3: each sheet is 36s of video in one Read.
ffmpeg -v error -i "$VIDEO" -vf "fps=1/6,scale=853:-1" "$OUT/tick-%03d.png"
ffmpeg -v error -pattern_type glob -i "$OUT/tick-*.png" -vf "scale=640:-1,tile=2x3" "$OUT/sheet-%02d.png"
printf 'sheets   %s\n' "$(ls "$OUT"/sheet-*.png | wc -l | tr -d ' ')"

# Narration, when there is an audio stream and whisper exists. small.en: accurate enough for
# design narration, minutes not tens of minutes.
if python3 -c "
import json,sys;d=json.load(open('$OUT/probe.json'))
sys.exit(0 if any(s['codec_type']=='audio' for s in d['streams']) else 1)" && command -v whisper >/dev/null; then
  ffmpeg -v error -i "$VIDEO" -vn -ac 1 -ar 16000 "$OUT/narration.wav"
  whisper "$OUT/narration.wav" --model small.en --language en --output_dir "$OUT" \
    --output_format txt --fp16 False >/dev/null 2>&1
  mv "$OUT/narration.txt" "$OUT/transcript.txt" 2>/dev/null || true
  printf 'words    %s\n' "$(wc -w < "$OUT/transcript.txt" | tr -d ' ')"
else
  printf 'words    (no audio stream or no whisper on PATH)\n'
fi
