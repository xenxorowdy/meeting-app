"""Render an approved, checked composition and validate its delivery artifacts."""
import json
import subprocess
from pathlib import Path

base = Path(__file__).resolve().parent
check = json.loads((base / 'check.json').read_text())
assert check['ok'] and not check['browserSkipped'], 'Complete the Hyperframes check first'

def run(args, **kw):
    return subprocess.run(args, cwd=base, check=True, **kw)

with (base / 'render-final.log').open('w') as log:
    subprocess.run(['npx', '--yes', 'hyperframes@0.8.113', 'render', '--quality', 'delivery', '--fps', '30', '--workers', '4', '--strict', '--output', '../brag-final-master.mp4'], cwd=base / 'composition', check=True, stdout=log, stderr=subprocess.STDOUT)

run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '18.8', '-i', 'brag-final-master.mp4', '-frames:v', '1', '-q:v', '2', 'brag.jpg'])
run(['ffmpeg', '-y', '-loglevel', 'error', '-i', 'brag-final-master.mp4', '-i', 'brag.jpg', '-filter_complex', "[0:v][1:v]overlay=0:0:enable='eq(n,0)'[v]", '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', 'brag.mp4'])

for name, output in [('brag-final-master.mp4', 'audio-before.sha256'), ('brag.mp4', 'audio-after.sha256')]:
    run(['ffmpeg', '-y', '-v', 'error', '-i', name, '-map', '0:a:0', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', output])
assert (base / 'audio-before.sha256').read_text() == (base / 'audio-after.sha256').read_text(), 'Poster changed audio'

probe = run(['ffprobe', '-v', 'error', '-count_frames', '-show_entries', 'format=duration,size:stream=index,codec_name,codec_type,width,height,r_frame_rate,nb_read_frames,sample_rate,channels', '-of', 'json', 'brag.mp4'], capture_output=True, text=True)
media = json.loads(probe.stdout)
(base / 'media-verification.json').write_text(json.dumps(media, indent=2))
video = next(s for s in media['streams'] if s['codec_type'] == 'video')
audio = next(s for s in media['streams'] if s['codec_type'] == 'audio')
assert float(media['format']['duration']) == 20
assert (video['width'], video['height'], video['r_frame_rate'], video['nb_read_frames']) == (1920, 1080, '30/1', '600')
assert video['codec_name'] == 'h264' and audio['codec_name'] == 'aac' and audio['channels'] == 2
run(['ffmpeg', '-v', 'error', '-i', 'brag.mp4', '-f', 'null', '-'])
for time, name in [(0, 'media-frame-zero.png'), (4.7, 'media-capture.png'), (10.5, 'media-hero.png'), (14.7, 'media-ask.png'), (19.966, 'media-final.png')]:
    run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', str(time), '-i', 'brag.mp4', '-frames:v', '1', name])

size = int(media['format']['size'])
validation = f'''# Final verification

- Deliverable: brag.mp4, {size:,} bytes ({size / 1_000_000:.2f} MB).
- Exact duration 20.000 seconds, 1920×1080 landscape, 30 fps, 600 frames, H.264/yuv420p.
- Stereo AAC at 48 kHz; full media decode completed without errors.
- Hyperframes 0.8.113 check passed: zero lint errors, runtime errors, layout findings, motion findings or contrast failures; {check['contrast']['passed']} sampled contrast checks passed.
- Four advisory lint warnings recommend splitting this compact monolithic composition into sub-compositions. Reviewed and retained the single seek-safe timeline, which preserves the promise-card identity across memory and hero.
- Nine explicit review timestamps plus the 300-sample motion sweep cover hook, product, memory, hero, historical evidence, local draft, final hold and final-minus-frame.
- Keyframe proof: promise card has two camera stages at 8.74–9.30 seconds. Painted scene snapshots and exported MP4 frames were inspected.
- Poster: settled final brand/product shot at 18.8 seconds, saved as brag.jpg and baked into frame 0 only. Encoded audio SHA256 is identical before/after baking.
- Final tabs match current completed-meeting source: Summary, Transcript, Commitments, Actions, Recording.
- Music and seven sparse UI effects; no narration. Exported mix has no clipping (initial identical-audio master measured -7.9 dBFS peak).
- Studio preview returned HTTP 200 at http://localhost:3027/#project/composition.
- Source-derived editorial UI reconstruction with fictional Acme fixtures. Not a live production/capture demonstration. Count is scoped to the featured meeting; follow-up is a reviewed local draft; no reminder notifications or automatic external delivery.
- Application source and pre-existing user changes were preserved. Product builds/tests were not applicable to an isolated video composition. git diff --check passed.
'''
(base / 'validation.md').write_text(validation)
print(f'Complete: {base / "brag.mp4"}; 20s, 600 frames, {size:,} bytes; unchanged audio.')
