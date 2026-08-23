# Alpha Podcast Studio — Product Requirements Document

**Status:** Implemented MVP  
**Owner:** Alpha Meeting Assistant  
**Platforms:** Alpha desktop for macOS and Windows  
**Primary audience:** People turning recorded meetings into useful, publishable audio/video recaps  
**Secondary audience:** Podcast creators recording or editing material they own

## 1. Problem and product promise

Meeting recordings contain useful decisions and explanations, but raw recordings are too long and meeting notes lose tone and context. Podcast creators also have to move between capture, transcription, cleanup, editing, rendering, and publishing tools.

Podcast Studio turns an Alpha meeting—or owned audio/video—into an editable production project. It can write a fact-grounded two-host script, synthesize it with distinct voices, clean spoken audio locally, combine audio and video on a non-destructive timeline, export delivery-quality files, and privately upload a finished video episode to YouTube for final review.

The feature is successful when a user can complete the meeting-to-private-YouTube flow without leaving Alpha except for final YouTube Studio review, while existing meeting payloads and stored data remain backward-compatible.

## 2. Goals and non-goals

### Goals

- Make **From meeting** the shortest and most prominent workflow.
- Support four project sources: completed Alpha meeting, local media, public RSS enclosure, and a new in-app recording.
- Import metadata and captions for videos owned by the connected YouTube account.
- Generate an editable, source-grounded, two-host script in the source language by default, with language and voice overrides.
- Provide a non-destructive multitrack editor with waveform preview, trim, split, reorder, gain, mute/solo, fades, transitions, captions, and undo/redo.
- Let users select and preview a microphone, camera, and screen/window before each recorded take.
- Clean speech locally and render high-quality audio and video without uploading source media.
- Export WAV, MP3, and YouTube-ready MP4, then upload privately to a podcast playlist and open YouTube Studio.
- Autosave projects atomically and recover the last valid state after a crash or restart.

### Non-goals

- Downloading or caching YouTube audiovisual streams.
- Importing YouTube content the connected account cannot manage.
- Music stem separation (vocals, drums, bass, instruments).
- Hosting an RSS feed, publishing to third-party podcast hosts, or replacing YouTube Studio.
- Cloud project sync, collaboration, mobile editing, or browser-based rendering.
- Switching mic, camera, or screen inside one active take; a new take is required.

## 3. User journeys

### Turn a meeting into a podcast

1. Open Podcast Studio and choose **From meeting**.
2. Select a completed meeting with a transcript.
3. Review detected language, choose two voices, and request a script.
4. Edit, add, remove, or reorder host turns. Every generated turn retains source turn/timestamp references.
5. Review the estimated audio duration and explicitly start voice generation. There is no product-level duration cap; the job is split into resumable sections.
6. Arrange generated speech, optional music, artwork, captions, and captured/imported video on the timeline.
7. Preview, clean speech if needed, render, and export or publish.

### Record an episode

1. Choose **Record**, then select and preview mic, camera, and screen/window.
2. Record a take. Camera/screen and microphone remain independently editable.
3. Stop the take, transcribe it, clean speech, and edit on the same timeline.

### Import an episode

- Local: choose supported audio/video and copy it into the project.
- RSS: enter an HTTPS feed, choose an episode, and download its declared enclosure after validation.
- YouTube: connect with OAuth, choose an owned video, import its metadata and available caption track, then attach the original local media if editing is required.

### Publish

1. Render a 1080p MP4. Audio-only projects receive a branded audiogram video.
2. Choose or create a YouTube playlist marked as a podcast and provide square artwork when required.
3. Upload as **private**, set synthetic-media disclosure for AI voices, and add the episode to the playlist.
4. Open the uploaded video in YouTube Studio for final edits and visibility changes.

## 4. Functional requirements

### Projects and assets

- Projects use a versioned manifest and project-relative asset paths under Electron `userData/podcast-projects/<id>`.
- Saves use write-to-temporary-file plus atomic rename. Unknown future manifest fields are preserved.
- Deleting a project requires confirmation and removes only its validated project directory.
- Imported assets are copied, never edited in place. Generated proxies and renders are reproducible and may be discarded.
- Existing meetings are linked by ID; the meeting storage schema is not changed.

### AI generation

- Script generation uses the configured Gemini credential and returns structured dialogue, title, description, chapters, detected language, source references, and an estimated duration.
- The prompt forbids invented claims, fabricated quotes, and facts outside the source transcript.
- TTS uses Gemini multi-speaker speech. Each script section is generated separately, persisted immediately, and can be retried without regenerating successful sections.
- Cloud processing starts only after an explicit user action and disclosure that transcript/script text is sent to Gemini. Source media is not sent for script or TTS generation.
- Missing credentials, provider limits, safety blocks, and partial failures are recoverable and actionable.

### Editing and processing

- Timeline edits are declarative and non-destructive. Clips reference an asset plus source in/out, timeline start, gain, fades, and optional transition.
- Audio tracks support mute, solo, per-clip gain, fade-in/out, speech cleanup, and master loudness normalization.
- Video tracks support trim, ordering, fit/fill, opacity, and crossfade. Captions may be sidecar VTT/SRT or burned into video.
- DeepFilterNet provides local spoken-word enhancement. FFmpeg/ffprobe provide media inspection, proxies, waveform data, EQ, compression, mixing, captions, and rendering.
- Long operations report stage/progress, support cancellation, and never replace a previously valid output until completion.

### Capture

- Enumerate real device labels after permission is granted.
- Show mic level and camera preview before recording; screen/window uses the existing Alpha source picker.
- Capture at up to 1080p30 and retain microphone separately at 48 kHz. A source ending unexpectedly finalizes the recoverable take.

### Import and security

- Accept WAV, MP3, M4A, AAC, FLAC, OGG/Opus, MP4, MOV, MKV, and WebM when ffprobe confirms usable streams.
- RSS accepts HTTP(S) feed URLs, blocks loopback/private/link-local destinations and unsafe redirects, caps feed and enclosure sizes, and verifies the downloaded MIME/container.
- YouTube OAuth uses PKCE and state validation. Only videos manageable by the authenticated account are listed. Captions require edit permission.
- Renderer input never becomes a shell command or unrestricted filesystem path.

### Output quality

- WAV master: stereo PCM, 48 kHz, 24-bit.
- MP3: 320 kbps constant bitrate.
- Podcast loudness: −16 LUFS stereo or −19 LUFS mono, true peak no higher than −1 dBTP.
- MP4: 1920×1080, 30 fps H.264, 48 kHz AAC, with A/V drift below 100 ms over a 30-minute fixture.

## 5. Data contract

`PodcastProject` contains:

- `schemaVersion`, `id`, `title`, `description`, `createdAt`, `updatedAt`
- `source`: `meeting | recording | file | rss | youtube`, plus source identifiers and attribution
- `language`, `generationDisclosureAcceptedAt`
- `script`: hosts, voices, detected language, estimated duration, dialogue turns, source references, generation status
- `assets`: ID, kind, relative path, MIME type, duration, dimensions, sample rate, channels, provenance, and processing derivatives
- `timeline`: tracks, clips, captions, master settings, duration, and undoable edit revision
- `jobs`: generation/processing/render state without credentials or secret provider payloads
- `exports`: format, relative path, quality metadata, and creation time
- `publication`: connected channel, playlist, upload/video ID, privacy, status, and Studio URL

## 6. Acceptance criteria

- A completed meeting can become a playable two-host draft and a valid WAV/MP3/MP4 export.
- A recorded mic/camera/screen take survives restart and remains editable as separate tracks.
- Local and RSS media can be imported, inspected, transcribed, trimmed, cleaned, mixed, and exported.
- Owned YouTube metadata/captions import without downloading its audiovisual stream.
- A rendered episode uploads privately, is added to a podcast playlist, and opens in YouTube Studio.
- Invalid paths, malicious RSS URLs, interrupted jobs, missing models, missing credentials, and provider failures do not corrupt projects or expose secrets.
- Existing meeting recording, summarization, history, replay, and export tests remain green.

## 7. Privacy, compliance, and rollout

- Projects and source media stay local unless the user explicitly initiates Gemini generation or YouTube publication.
- No API key, OAuth token, transcript, or local path appears in logs or public status responses.
- YouTube uploads default to private; public release remains a user action in YouTube Studio and depends on Google audit/verification requirements.
- Alpha does not provide arbitrary YouTube downloading. Users must supply original media for editing.
- DeepFilterNet and the shipped media binaries must pass commercial-license review and ship with notices. FFmpeg must be an LGPL-compatible build using platform H.264 encoders.
- The browser UI explains that Podcast Studio requires the desktop app; no partial browser workflow pretends capture/render/publish is available.
