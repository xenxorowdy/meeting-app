# Podcast media tools packaging

Podcast Studio discovers each tool in this order:

1. `ALPHA_FFMPEG_PATH`, `ALPHA_FFPROBE_PATH`, or `ALPHA_DEEP_FILTER_PATH`.
2. A packaged executable at `resources/media-tools/<platform>/<arch>/<name>` (`.exe` on Windows).
3. The executable on `PATH`, for development.

Do not commit an arbitrary local binary here. Release packaging must supply pinned, checksum-verified macOS and Windows artifacts and copy them into the Electron resources layout above.

Before a release, legal and engineering must verify:

- FFmpeg and ffprobe are built with an LGPL-compatible configuration and use platform H.264 encoders where available.
- DeepFilterNet and its model/runtime redistribution terms are approved for commercial desktop distribution.
- Required copyright, source-offer, and third-party notices ship with the app.
- Every binary is code-signed/notarized as applicable, scanned, and exercised by WAV, MP3, MP4, waveform, and speech-cleanup smoke tests on each target architecture.

Development example:

```bash
ALPHA_FFMPEG_PATH=/absolute/path/to/ffmpeg \
ALPHA_FFPROBE_PATH=/absolute/path/to/ffprobe \
ALPHA_DEEP_FILTER_PATH=/absolute/path/to/deep-filter \
npm run dev
```
