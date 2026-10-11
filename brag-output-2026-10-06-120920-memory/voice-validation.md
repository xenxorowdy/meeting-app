# Narrated launch video verification

- Deliverable: brag-voice.mp4, 2,299,079 bytes; original brag.mp4 retained.
- Exact duration: 20.000 seconds; 1920×1080 landscape, 30 fps, 600 H.264 frames and stereo 48 kHz AAC. Full decode completed.
- Kokoro am_fenrir at 0.95 speed; 39 words across six measured phrases. Opening phrases have a pause. Last phrase finishes at 19.544 seconds.
- Music retains the original beat timing and sparse UI effects. Voice normalized; music carved at strength 0.35, with a speech-driven envelope and EQ.
- Exported speech verified against source for every phrase: waveform correlations 0.9675–0.9968. ASR recovered the intended wording, spelling Kesami as Kessami. ASR timings are approximate and are not used for composition timing.
- Exported stereo mix: -18.8 LUFS integrated, -4.6 dBTP; no clipping.
- Hyperframes project pins upgraded from 0.8.113 to 0.8.137 in the derivative only. Check passed with zero runtime, layout, motion or contrast failures; 126 contrast checks passed and 300 motion samples passed. Four pre-existing advisory composition-structure warnings remain.
- Visual markup and GSAP timing match the original after ignoring audio tags and whitespace. Settled final and hero exported frames inspected.
- Final poster baked into frame 0; encoded audio hash identical before/after.
- Studio preview returned HTTP 200: http://localhost:3028/#project/voice-composition.
- Fictional Acme demo content and source-derived UI; application source and original assets preserved. No claim of live production use.
- Local speech dependency workaround: use the Homebrew espeak-ng library because the bundled macOS library pointed to a missing build-machine data path. Project-local Python environment is reproducible through generate-voice.py.
