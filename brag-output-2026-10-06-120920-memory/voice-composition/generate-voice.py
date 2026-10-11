import json, os, subprocess
from pathlib import Path
root=Path(__file__).resolve().parent
os.chdir(root)
env=os.environ.copy()
env['HYPERFRAMES_PYTHON']=str(root/'.voice-venv/bin/python')
env['PHONEMIZER_ESPEAK_LIBRARY']='/opt/homebrew/lib/libespeak-ng.dylib'
lines=json.loads((root/'voice-lines.json').read_text())
for line in lines:
    path=root/'assets/voice'/f"{line['id']}.wav"
    if not path.exists():
        result=subprocess.run(['npx','--yes','hyperframes@0.8.137','tts',line['text'],'--voice','am_fenrir','--speed','0.95','--output',str(path),'--json'],env=env,capture_output=True,text=True,check=True)
        print(result.stdout,flush=True)
    line['duration']=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',str(path)],text=True))
    print(line['id'],line['duration'],flush=True)
(root/'voice-timings.json').write_text(json.dumps(lines,indent=2))
