import json, subprocess
from pathlib import Path
root=Path(__file__).resolve().parent
lines=json.loads((root/'voice-timings.json').read_text())
args=['ffmpeg','-y','-hide_banner','-loglevel','error']
filters=[]
for i,line in enumerate(lines):
    assert line['start']+line['duration'] <= line['windowEnd'],line
    args+=['-i',str(root/'assets/voice'/f"{line['id']}.wav")]
    filters.append(f"[{i}:a]adelay={round(line['start']*1000)}:all=1[v{i}]")
filters.append(''.join(f'[v{i}]' for i in range(len(lines)))+f"amix=inputs={len(lines)}:normalize=0:duration=longest,apad,atrim=0:20,loudnorm=I=-18:TP=-2:LRA=7,aresample=48000[a]")
args+=['-filter_complex',';'.join(filters),'-map','[a]','-ac','2','-c:a','pcm_s24le',str(root/'assets/voice/narration.wav')]
subprocess.run(args,check=True)
p=root/'index.html';html=p.read_text()
assert 'id="narration"' not in html
html=html.replace('<audio data-hf-id="hf-awxy"', '<audio id="narration" data-hf-id="hf-narration" src="assets/voice/narration.wav" data-start="0" data-duration="20" data-track-index="18" data-volume="1"></audio>\n<audio data-hf-id="hf-awxy"',1)
p.write_text(html)
(root/'VOICEOVER.md').write_text('# Narrated launch cut\n\n20-second landscape derivative; original silent-narration cut preserved.\n\nKokoro am_fenrir, speed 0.95. Short connected phrases, measured scene timing and a pause in the opening. Voice normalized to -18 LUFS / -2 dBTP. Music retains its original beat pacing and is carved beneath speech.\n\n'+ '\n'.join(f"- {x['start']:.2f}–{x['start']+x['duration']:.2f}s: {x['text']}" for x in lines)+'\n\nDerivative project pins updated from Hyperframes 0.8.113 to 0.8.137. Source application and original composition preserved. All Acme content remains fictional demo data.\n')
print('Assembled:',lines)
