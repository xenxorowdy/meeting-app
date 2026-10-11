# Final video verification

Final file: brag.mp4. Scope: local launch-video artifacts; the app source was read for grounding.

- 29.000 seconds, 1920×1080, 30fps, 870 video frames, H.264 and AAC, BT.709. File size 4,761,977 bytes.
- Hyperframes 0.8.113 check passed with zero lint, runtime, layout, motion or contrast errors. All 102 sampled text contrast checks passed; runtime and motion had no warnings.
- Six nonfatal structure warnings were reviewed: each scene is one Studio row with nested content. They affect timeline editing granularity. The one layout information finding is a brief scene-transition overlap.
- Settled privacy, widget, multilingual-transcription, history-answer and final-brand snapshots were inspected. The unchanged folder layout was also inspected at its settled state.
- All six complete English narration clips fit their scene windows. Short silent source tails preserve the slow-playback endings. The music was carved against all six voices and ducked under speech.
- Render used hardware GPU screenshot capture and completed in 18.7 seconds. The renderer lowered audio by 1.6dB to meet its true-peak ceiling; final decoded peak is -1.8dB.
- Poster chosen at 12.0 seconds: the multilingual-transcription settings panel is fully settled, showing the language choices and transcript styles. The poster was baked into frame zero. Pixel comparison is 44.07dB PSNR; dimensions, timing and all 870 frames were retained. Decoded audio SHA-256 is identical before and after finishing.
- Local Studio preview returned HTTP 200 at http://127.0.0.1:3017/#project/composition.

The language scene is about app transcription. It shows the 11 explicit language options in SettingsModal.jsx plus automatic detection, native spoken-language transcription, code-mixed Hinglish and English translation. Film narration remains English. Widget questions use the current meeting; the desktop question demonstrates meeting history.

Meeting contents are fictional and product views are source-grounded editorial recreations. This verification covers the film and exported media; live recording, provider accuracy across languages, and production AI calls were not exercised. Privacy claims are limited to bot-free capture and local meeting-file storage.
