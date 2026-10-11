# Kesami launch video

- `brag.mp4`: 29-second, 1920×1080, 30fps narrated video.
- `brag.jpg`: selected product poster, also baked into the first video frame.
- `share-copy.txt`: ready-to-use caption.
- `brag-plan.md`: angle, source references, storyboard, and narration.
- `composition-brief.md`: creative and implementation brief.
- `composition/`: editable Hyperframes project with local assets.
- `check.json`: runtime, layout, motion, and contrast results.
- `validation.md`: final output verification.

The edit covers privacy, the floating widget, multilingual transcription, local meeting folders, and questions across past meetings. It uses #FF5E00 accents and rgba(255, 94, 0, 0.1) backgrounds with white app panels.

All meeting contents are fictional examples. The video compresses processing and response waits; it makes no timing or performance claim.

To edit or re-render, run from `composition/`:

```sh
npm run dev
npm run check
npm run render -- --quality delivery --fps 30 --output ../brag.mp4
```

The composition is pinned to Hyperframes 0.8.113. Rendering needs Node 22+ and FFmpeg. Voiceover is already generated and included, so rendering does not need a TTS model or account. The script is in `narration.txt`, with scene generation inputs alongside it; this run used local Kokoro `af_heart` at speed 0.92 for the five feature scenes and 0.85 for the outro. `voice-timings.json` records measured clip timing. Visual assets and runtime scripts are local.

The custom frame-zero poster is a separate FFmpeg finishing step. Re-extract a settled product frame after changing the edit, then replace only frame zero with the poster as described by the brag plugin's delivery workflow.
