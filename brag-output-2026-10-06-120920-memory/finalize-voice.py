"""Render and verify the narrated derivative without changing original deliverables."""
import json,subprocess
from pathlib import Path
base=Path(__file__).resolve().parent
check=json.loads((base/'voice-check.json').read_text())
assert check['ok'] and not check['browserSkipped'], 'Hyperframes check must pass first'
def run(args, **kwargs):
 return subprocess.run(args,cwd=base,check=True,**kwargs)
with (base/'render-voice.log').open('w') as log:
 subprocess.run(['npx','--yes','hyperframes@0.8.137','render','--quality','delivery','--fps','30','--workers','4','--strict','--output','../brag-voice-master.mp4'],cwd=base/'voice-composition',check=True,stdout=log,stderr=subprocess.STDOUT)
run(['ffmpeg','-y','-loglevel','error','-ss','18.8','-i','brag-voice-master.mp4','-frames:v','1','-q:v','2','brag-voice.jpg'])
run(['ffmpeg','-y','-loglevel','error','-i','brag-voice-master.mp4','-i','brag-voice.jpg','-filter_complex',"[0:v][1:v]overlay=0:0:enable='eq(n,0)'[v]",'-map','[v]','-map','0:a:0','-c:v','libx264','-crf','18','-preset','slow','-pix_fmt','yuv420p','-c:a','copy','-movflags','+faststart','brag-voice.mp4'])
for src,out in [('brag-voice-master.mp4','voice-audio-before.sha256'),('brag-voice.mp4','voice-audio-after.sha256')]:
 run(['ffmpeg','-y','-v','error','-i',src,'-map','0:a:0','-c:a','copy','-f','hash','-hash','sha256',out])
assert (base/'voice-audio-before.sha256').read_text()==(base/'voice-audio-after.sha256').read_text()
probe=run(['ffprobe','-v','error','-count_frames','-show_entries','format=duration,size:stream=index,codec_name,codec_type,width,height,r_frame_rate,nb_read_frames,sample_rate,channels','-of','json','brag-voice.mp4'],capture_output=True,text=True)
media=json.loads(probe.stdout)
(base/'voice-media-verification.json').write_text(json.dumps(media,indent=2))
v=next(s for s in media['streams'] if s['codec_type']=='video')
a=next(s for s in media['streams'] if s['codec_type']=='audio')
assert float(media['format']['duration'])==20
assert (v['width'],v['height'],v['r_frame_rate'],v['nb_read_frames'])==(1920,1080,'30/1','600')
assert v['codec_name']=='h264' and a['codec_name']=='aac' and a['channels']==2
run(['ffmpeg','-v','error','-i','brag-voice.mp4','-f','null','-'])
for t,name in [(0,'voice-frame-zero.png'),(10.5,'voice-media-hero.png'),(19.966,'voice-media-final.png')]:
 run(['ffmpeg','-y','-loglevel','error','-ss',str(t),'-i','brag-voice.mp4','-frames:v','1',name])
levels=run(['ffmpeg','-hide_banner','-i','brag-voice.mp4','-af','ebur128=peak=true','-f','null','-'],capture_output=True,text=True)
(base/'voice-mix-levels.log').write_text(levels.stderr)
print(f"Finished: {base/'brag-voice.mp4'}; 20s, 600 frames, {media['format']['size']} bytes",flush=True)
