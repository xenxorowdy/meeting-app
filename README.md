# Kesami Commercial Meeting Assistant

A standalone, privacy-first, bot-free meeting assistant for **macOS** and **Windows**.

## Architecture Overview

This project is decoupled into two clean, independent applications:

```
packages/meeting-app/
├── apps/
│   ├── ui/             # React 19 + Tailwind CSS + Shadcn UI Desktop Client
│   ├── core-backend/   # Rust core engine + hosted cloud relay
│   └── extension/      # Chrome extension: participant names from Google Meet / Zoom
└── package.json        # Workspace orchestrator
```

### 1. Frontend Client (`apps/ui`)

- **Live Meeting HUD**: Floating/dockable recording controls, audio level visualizers, duration timer, and mute toggles.
- **Transcript Stream**: Real-time speaker badges (`"You"` vs `"Speaker 1, 2..."`) with search filtering.
- **AI Summary Editor**: Executive summary, key decisions list, interactive action items table, and copy-ready follow-up email drafts.
- **History Explorer**: Searchable local meeting database with instant full-text search.
- **Podcast Studio**: Meeting-first, source-grounded two-host scripting, multitrack capture/editing, local speech cleanup, WAV/MP3/MP4 rendering, RSS and owned-YouTube caption import, and private YouTube podcast publishing.
- **Settings & Accounts**: Audio and AI provider preferences, optional database-backed password or desktop Google sign-in, password changes, and a Free/Pro plan catalog. Local use requires no account; paid checkout is not enabled. See [account and pricing setup](docs/PRODUCT-SETUP.md).

### 2. Core Backend Engine (`apps/core-backend`)

The production entrypoint is now Rust (`core-backend/src/main.rs`). It keeps the
existing HTTP and WebSocket contract on `127.0.0.1:48900`, uses Tokio for
concurrent connections, and moves the binary audio packet parser and integer RMS
calculation out of the JavaScript event loop. The hosted cloud relay is a second,
much smaller Rust binary in the same crate (`src/bin/kesami-cloud-relay.rs`); see
[CLOUD_TRANSCRIPTION.md](CLOUD_TRANSCRIPTION.md).

- **Meeting Audio Capture**: ScreenCaptureKit through the `SystemAudioDump` helper on macOS, over 16-byte binary streaming IPC. Windows has no native helper: Screen + sound recordings use Electron's display-media loopback, and audio-only meetings need a loopback input device (Stereo Mix, VB-Audio Cable).
- **Audio DSP & VAD**: Zero-copy 16 kHz resampler, integer sum-of-squares RMS VAD, spectral noise cancellation on the microphone, and acoustic echo suppression against the meeting audio.
- **Speech-to-Text (STT)**: Sarvam Saaras — realtime streaming WebSocket transcription during the meeting, with optional post-meeting diarization over the completed recording.
- **Diarization Engine**: Guaranteed physical `"You"` attribution on mic + live voiceprint clustering on meeting audio + provider diarization and meeting-client names when available. See [Who said what](#who-said-what).
- **Storage Layer**: one visible folder per meeting on disk (see [The meeting library](#the-meeting-library)), written atomically, with multi-format export (Markdown, JSON).
- **AI Summarizer**: Structured meeting intelligence through the Claude Code CLI (no API key required), with a keyword heuristic as the offline fallback. See [Meeting summaries](#meeting-summaries).
- **Accounts & Pricing**: SQLite accounts and sessions with automatic legacy JSON migration. The local plan is free; Pro pricing is configurable for preview, with payment collection and subscription enforcement still pending.
- **API Server**: Standalone WebSocket and HTTP/IPC bridge for frontend communication.

---

## Meeting summaries

When a meeting stops, the backend hands the diarized transcript to the **Claude Code CLI**
(`claude --print`) and asks for a schema-validated summary. The CLI runs on the machine's existing
`claude login` session, so summarization needs no API key of its own and no transcript ever goes to a
key the user has to manage.

The call is deliberately narrow:

| Flag                               | Why                                                                                                                               |
| :--------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------- |
| `--print` + `--output-format json` | One non-interactive turn, one JSON envelope to parse.                                                                             |
| `--json-schema`                    | The executive summary, decisions, action items, topics and follow-up email come back as validated JSON instead of prose to regex. |
| `--system-prompt`                  | Replaces Claude Code's coding-agent prompt with the summarizer prompt.                                                            |
| `--disallowedTools`                | A summary must come from the transcript alone, not from the filesystem or the web.                                                |
| `--safe-mode`                      | Local hooks, settings and `CLAUDE.md` files must not change a summary.                                                            |
| `--no-session-persistence`         | Backend runs never show up in the user's `/resume` history.                                                                       |

The transcript is written to the CLI's **stdin**, not argv, so meeting length is bounded by the model
context rather than by the platform argument limit; transcripts past ~120k characters are trimmed in
the middle, where a summary can most afford the loss.

If the CLI is missing, not logged in, times out or errors, the backend falls back to the keyword
heuristic — which only ever repeats sentences that were actually spoken — and reports the reason as a
`warning` on the response and the `summary_generated` event. The meeting is never lost to a failed
summary.

### Configuration

| Variable                       | Default             | Purpose                                                                                         |
| :----------------------------- | :------------------ | :---------------------------------------------------------------------------------------------- |
| `KESAMI_SUMMARY_PROVIDER`       | `auto`              | `auto` uses the CLI when installed; `heuristic` forces the offline summarizer.                  |
| `KESAMI_CLAUDE_BIN`             | _(auto-discovered)_ | Explicit path to the `claude` binary. Checked before `PATH` and the per-user install locations. |
| `KESAMI_SUMMARY_MODEL`          | `sonnet`            | Model alias or full name passed to `--model`.                                                   |
| `KESAMI_SUMMARY_TIMEOUT_SECS`   | `180`               | Per-summary wall-clock budget.                                                                  |
| `KESAMI_SUMMARY_MAX_BUDGET_USD` | _(unset)_           | Optional `--max-budget-usd` cap per summary.                                                    |
| `KESAMI_OPENAI_API_KEY`         | _(unset)_           | Gemini backup: `gpt-5-nano` runs only after Gemini answers 429 (quota exhausted).               |
| `KESAMI_OPENAI_DAILY_BUDGET_USD` | `3`                | Estimated OpenAI spend allowed per UTC day; tallied in `.kesami/openai-usage.json`.            |
| `KESAMI_SUMMARY_SAFE_MODE`      | `1`                 | Set to `0` to let local Claude Code customizations apply.                                       |

`GET /health` and `GET /api/status` report the resolved engine under `summary`
(`{"provider":"claude-cli","binary":"…","model":"sonnet"}`), `POST /api/summary/config` switches the
model at runtime, and `POST /api/meetings/:id/summarize` returns the stored notes — or regenerates
them with `{"regenerate": true}`.

## Transcription providers

The Transcription settings offer two distinct flows:

- **Sarvam Saaras (batch)** waits until the meeting ends, uploads the completed mixed WebM recording as one batch, requests speaker diarization, replaces the transcript with timestamped speaker turns, and then runs the normal summary pipeline.
- **Sarvam Saaras (live streaming)** opens one realtime WebSocket per capture stream and sends 16 kHz PCM while the meeting runs. Turns arrive as they are spoken: `transcript.partial` is emitted to clients as a `transcript_interim` event and discarded, `transcript.final` is committed as a normal `transcript_turn`. A dropped socket reconnects with backoff; audio spoken while it is down is not transcribed.

The realtime socket returns no speakers of its own, so live turns are numbered from the local voiceprint pass described in [Who said what](#who-said-what), and the meeting is diarized again once it ends: unless `sarvamDiarizeAfterMeeting` is off, the finished recording goes through the same batch job as the batch provider and its speaker turns replace the live transcript before summarization. Clients hear about that as a `transcript_replaced` event carrying the whole transcript. If the batch pass fails, the live transcript is kept and the failure is reported as a transcription warning.

Both Sarvam flows name the diarized speaker whose turns line up with the microphone `You` rather than `Speaker N`. The microphone timeline comes from the local VAD, which runs for every provider; a speaker is only named when the microphone was open for at least 60% of what they said and no other speaker comes close, so speaker bleed into the microphone costs a rename rather than a wrong attribution.

Sarvam batch mode requires the Kesami desktop app because Electron owns the recording files. It also requires screen recording to remain enabled so the saved recording contains both microphone and meeting audio. Live streaming needs neither to transcribe, but its post-meeting diarization pass reads the same recording, so a realtime meeting recorded without one keeps the speaker numbers the live pass gave it. Both flows use a key held by the Rust backend, never returned to the UI. Set `KESAMI_SARVAM_API_KEY` in the backend environment or its `.env.local`, or save it in the backend's private `0600` credentials file. The desktop package runs a separate backend on each Mac under `~/Library/Application Support/Kesami`; keys in a source checkout do not follow the DMG. To share one provider key across installations, deploy a hosted backend and connect clients to its public HTTPS URL. Do not put the Sarvam key in the UI env or DMG. `sarvamLanguage` and `sarvamMode` apply to both flows, and the language value `unknown` is sent to the realtime endpoint as `auto`.

| Variable                      | Default                                          | Purpose                                             |
| :---------------------------- | :----------------------------------------------- | :-------------------------------------------------- |
| `KESAMI_SARVAM_API_KEY`        | _(stored key)_                                   | Overrides the saved Sarvam API key.                 |
| `KESAMI_SARVAM_TIMEOUT_SECS`   | `900`                                            | Maximum wait for a batch transcription job.         |
| `KESAMI_SARVAM_BASE_URL`       | `https://api.sarvam.ai`                          | Batch API base override, primarily for testing.     |
| `KESAMI_SARVAM_REALTIME_URL`   | `wss://api.sarvam.ai/speech-to-text-realtime/ws` | Realtime WebSocket override, primarily for testing. |
| `KESAMI_SARVAM_REALTIME_MODEL` | `saaras:v3-realtime`                             | Realtime model override.                            |
| `KESAMI_RECORDINGS_DIR`        | _(set by Electron)_                              | Trusted root used to resolve recording paths.       |

---

## The meeting library

Every meeting is a folder you can open, back up, or hand to somebody:

```
~/Documents/Kesami Meetings/
├── 2026-09-05 Design review/
│   ├── meeting.json      # the record: transcript, summary, action items, metadata
│   ├── transcript.md     # timestamped speaker turns
│   ├── summary.md        # summary, decisions, action items, follow-up email
│   └── recording.webm    # the screen recording, if one was made
└── .in-progress/         # the shell streams here while a meeting runs
```

The folder is named `YYYY-MM-DD Title` from the meeting's own date and title, sanitised for every
filesystem (path separators and `<>:"|?*` become `-`, 60 characters maximum, reserved Windows names
avoided). Two meetings that would collide get the first eight characters of the id appended, and
renaming a meeting renames its folder. `meeting.json` is rewritten on every change; `transcript.md`
and `summary.md` are rewritten when the meeting ends, when a summary is regenerated, and when
speakers are renamed. Deleting a meeting deletes its folder.

The shell records into `.in-progress/<meetingId>/screen.webm` — a uuid directory has no business
sitting in a folder you browse — and the backend moves the finished file in as `recording.webm` when
the meeting ends. That move only happens when `KESAMI_RECORDINGS_DIR` and `KESAMI_LIBRARY_DIR` are the
same directory, which is how the desktop shell launches the backend. Recordings made before the
library existed stay under `userData/recordings` and the media scheme still resolves them there.

| Variable            | Default                      | Purpose                                                        |
| :------------------ | :--------------------------- | :------------------------------------------------------------- |
| `KESAMI_LIBRARY_DIR` | `~/Documents/Kesami Meetings` | Where meeting folders live. The shell sets it for the backend. |
| `KESAMI_DATA_DIR`    | _(working directory)_        | Parent of `Kesami Meetings/` when no library dir is set.        |

The first run after an upgrade imports the old `.kesami/meetings.json` into folders.
That file is left untouched, and the ids it brought over are recorded in `.kesami-library.json` inside
the library, so a meeting deleted after the import is not resurrected on the next start.

---

## Who said what

Your microphone is `You`, always and by construction: it is a separate capture stream, so nothing has to
infer it. Everyone else arrives mixed together on the meeting-audio channel, and three passes number them,
each overruling the one below it.

**The meeting page**, when the extension in the next section is installed: turns take the identity the tab
reported as speaking, each identity keeps one number for the meeting, and the voiceprints step aside — a
page that is naming people is a better witness than the audio, and mixing the two would number one person
twice.

**The voice itself**, otherwise, and live. Every meeting-audio utterance the VAD closes is reduced to a
voiceprint — the mean of its mel-frequency cepstral coefficients over the loud frames, plus the median
fundamental frequency — and matched against the voices already heard (`src/voiceprint.rs`). A close enough
match keeps that speaker's number; anything further away opens `Speaker 2`, `Speaker 3`, and so on. It is a
classical voiceprint rather than a neural embedding, so it is deliberately reluctant to split: a voice needs
1.5 seconds of speech before it may claim a new number, at most eight speakers are separated live, and a
turn that follows within 1.5 seconds stays with the previous speaker unless it is clearly someone else.
Numbering one person twice reads far worse than leaving two people sharing a number.

**The finished recording**, last, for the Sarvam providers: real diarization over the whole meeting replaces
the live transcript, and the speaker whose turns line up with the microphone becomes `You` (see
[Transcription providers](#transcription-providers)).

Speaker numbers are ordinary text, so renaming a speaker in the transcript renames every turn they own.

| Variable                   | Default | Purpose                                                                                                        |
| :------------------------- | :------ | :------------------------------------------------------------------------------------------------------------- |
| `CORE_BACKEND_VOICE_SPLIT` | `1.15`  | Distance at which a meeting-audio voice becomes a new numbered speaker. Lower splits more eagerly, higher less. |

---

## Noise cancellation and echo suppression

Two switches in Audio settings, both applied by the core backend rather than only by the browser, so they
reach the recogniser and not just the microphone driver.

**Noise cancellation** filters the microphone before anything else looks at it — before the level meter,
before the VAD, before the recogniser (`src/denoise.rs`). It is a Wiener filter over 32 ms frames: the noise
floor per frequency band is tracked as a minimum over the last few seconds, the a priori signal-to-noise
ratio is smoothed the decision-directed way so the filter does not chatter, and each band is attenuated by
what is left. Steady room noise — a fan, an air conditioner, street hum — drops far enough to fall back under
the VAD's speech threshold, which matters more than the loudness itself: audio the VAD wrongly opens on is
handed to the transcriber, which answers noise with confident invented sentences. Meeting audio is not filtered.
It arrives as a digital loopback with no room in it, and filtering it would only cost quality.

**Echo suppression** drops microphone audio that is the meeting coming back through the speakers. Everything
the meeting plays is kept as a rolling 12-second energy envelope; when the microphone closes an utterance,
its envelope is correlated against that timeline across every acoustic delay up to 600 ms, and a strong match
that is not much louder than what was played is discarded rather than transcribed (`src/echo.rs`). The
comparison is against played audio rather than against finished meeting-audio turns because a microphone
utterance closes long before the turn it echoes has been recognised. A second, cheaper check runs on the
text: a microphone turn that repeats what the meeting said within the last ten seconds is dropped too.
Without either, one sentence lands twice — once as `Speaker 1` and once as `You`.

Both switches take effect immediately, including mid-meeting.

---

## Participant names from the meeting page

The audio pipeline separates voices; it cannot name them. `apps/extension` is an unpacked Chrome
extension that reads the participant list and the speaking indicator out of the Google Meet or Zoom
tab and posts them to the backend, so speaker numbers follow the people the page is naming rather than the
voiceprints.
See [its README](apps/extension/README.md) for installation and for repairing a selector after Meet
or Zoom changes its markup.

The contract is one endpoint. `POST /api/session/participants` takes a snapshot of the call:

```json
{ "source": "google-meet", "participants": ["Riyam Jain", "Aditi Sharma"], "speaking": ["Aditi Sharma"], "self": "Riyam Jain" }
```

Snapshots are stamped against the meeting clock and stitched into named speech intervals
(`src/speakers.rs`). A live turn from the meeting-audio channel is numbered by the identity that was
talking across it, so each person on the call holds one `Speaker N` for the whole meeting instead of
being re-clustered from their voice; a diarized speaker takes the name their turns overlap, decided
across all speakers at once so no two share a name; and the roster joins the calendar attendees the
summary is written against, on `metadata.participants`. An identity is only attached when it covers
at least half the turn and no other name is close, so cross-talk keeps one shared provisional number. The
microphone still wins for your own turns — you stay `You`. Posts made while nothing is recording are
answered with `{"accepted": false}` and change nothing.

---

## Calendar connections

Google Calendar and Microsoft Outlook connect over OAuth 2.0 authorization code + PKCE with a
loopback redirect. Desktop clients cannot keep a client secret confidential; Google can still
require its issued secret for token exchange and refresh. The consent page opens in the user's
real browser and comes back to a listener the backend opens on
loopback for exactly one request, on an ephemeral port chosen per attempt. Google requests event
read/write access (`calendar.events`); Microsoft requests read-only access (`Calendars.Read`).
The calendar API lists events and creates them. **New meeting** — in the menu bar or on the home screen —
schedules a Google Calendar event, optionally minting a Google Meet link, and invites the addresses you
supply. Creation is Google-only: the Microsoft token this app requests is `Calendars.Read`, so Outlook
calendars stay read-only and the backend refuses a create against them with an explanatory error rather
than failing silently. Editing and deletion are still not implemented.

Refresh tokens live in `credentials.json` alongside the API keys, written `0600`. Access tokens are
refreshed a minute before expiry; Microsoft's rotating refresh tokens are re-stored on each refresh.

### One-time setup

Both providers need an OAuth client id, which identifies the app rather than the user. Set it in
**Settings → Calendar**, or as an environment variable.

**Google** — Cloud Console → enable the _Google Calendar API_ → _OAuth consent screen_ (add the
`calendar.events` scope and yourself as a test user) → _Credentials_ → _Create OAuth client
ID_ → application type **Desktop app**. If Google reports `client_secret is missing`, open the same
OAuth client's details and copy its client secret (also available as `installed.client_secret` in
the downloaded OAuth client JSON). Paste it into **Settings → Calendar → Google client secret**,
save, then click **Connect** again. It is stored locally in the private credentials file and is
sent only to Google's token endpoint. An empty field preserves the saved secret.

If Google was already connected with read-only access, restart the updated backend, then disconnect
and reconnect Google in **Settings → Calendar** to approve event write access. The same client ID
can be used; existing tokens do not gain permissions automatically.

**Microsoft** — Entra admin center → _App registrations_ → _New registration_, account types
including personal Microsoft accounts → _Authentication_ → _Add a platform_ → **Mobile and desktop
applications** → redirect URI `http://localhost`. Registering the bare host is what allows the
dynamic port; do not pin one.

| Variable                              | Purpose                                                    |
| :------------------------------------ | :--------------------------------------------------------- |
| `KESAMI_GOOGLE_CALENDAR_CLIENT_ID`     | Google OAuth client id. Checked before the stored setting. |
| `KESAMI_GOOGLE_CALENDAR_CLIENT_SECRET` | Only if Google's token endpoint demands it.                |
| `KESAMI_MICROSOFT_CALENDAR_CLIENT_ID`  | Entra application (client) id.                             |

### API

| Route                           | Purpose                                                               |
| :------------------------------ | :-------------------------------------------------------------------- |
| `GET /api/calendar/status`      | Per provider: connected, configured, signed-in account.               |
| `POST /api/calendar/connect`    | `{"provider"}` → `{"authUrl"}`. Opening it is the caller's job.       |
| `POST /api/calendar/disconnect` | Forgets the stored tokens for one provider.                           |
| `GET /api/calendar/events`      | Merged, time-sorted events. `minutesBack` (15), `minutesAhead` (2880). |
| `POST /api/calendar/events`     | Creates one Google event. `{provider, title, start, end, attendees[], description, addConference}`. |

Completion arrives as a `calendar_connection` WebSocket event rather than a response to `connect`,
because the consent round trip runs through the browser.

---

## Podcast Studio

The desktop sidebar includes **Podcast Studio**. Projects and copied media are stored beneath Electron's private `userData/podcast-projects` directory with atomic, versioned manifests. Existing meeting records are linked by ID and are not rewritten.

Script and multi-speaker voice generation use the Gemini key configured in Kesami. The user must explicitly start each cloud operation; only transcript or script text is sent. Media cleanup and rendering remain local. YouTube uses OAuth PKCE, imports metadata/captions only for videos owned by the connected account, and uploads new episodes as private before opening YouTube Studio.

Local media operations require FFmpeg/ffprobe. Speech cleanup additionally requires the DeepFilterNet `deep-filter` executable. Development builds discover these on `PATH` or through the variables below; packaged builds should place reviewed binaries under `resources/media-tools/<platform>/<arch>/`. See `apps/desktop/media-tools/README.md` for the packaging contract and license checklist.

| Variable                       | Purpose                                                                            |
| :----------------------------- | :--------------------------------------------------------------------------------- |
| `KESAMI_FFMPEG_PATH`            | Explicit FFmpeg executable; Electron passes its resolved copy to the Rust backend. |
| `KESAMI_FFPROBE_PATH`           | Explicit ffprobe executable.                                                       |
| `KESAMI_DEEP_FILTER_PATH`       | Explicit DeepFilterNet CLI executable.                                             |
| `KESAMI_PODCAST_SCRIPT_MODEL`   | Gemini structured-script model override.                                           |
| `KESAMI_PODCAST_TTS_MODEL`      | Gemini multi-speaker TTS model override.                                           |
| `KESAMI_PODCAST_TIMEOUT_SECS`   | Gemini request timeout; defaults to 300 seconds.                                   |
| `KESAMI_GOOGLE_OAUTH_CLIENT_ID` | Packaged or developer Google desktop OAuth client ID for YouTube.                  |

The full product definition, security boundaries, data contract, and acceptance criteria are in [the Podcast Studio PRD](docs/PODCAST-STUDIO-PRD.md).

## Getting Started

### Development

```bash
# Run Rust backend engine
npm run start:backend

# Run frontend UI
npm run start:ui
```

### Testing

```bash
# Run Rust backend tests
npm run test:backend

# Run podcast project, render, and path-confinement tests
npm run test:podcast

# Run the hosted cloud relay tests
npm run test:cloud
```

## Releases

Kesami is distributed for free through
[xenxorowdy/kesami-releases](https://github.com/xenxorowdy/kesami-releases). That repo holds only
the downloads, the install instructions, and `install.sh`; the source stays here.

**Supported:**

- **macOS:** Apple Silicon Macs (arm64), macOS 13 or later. The bundled `SystemAudioDump` helper and
  the build target are arm64-only, so there is no Intel or universal build yet.
- **Windows:** 64-bit Windows 10 or 11 (x64). The installer is `Kesami-Setup-x64.exe`, with no version
  in its name so `releases/latest/download/Kesami-Setup-x64.exe` always fetches the newest one. It
  installs per user, with no administrator prompt. There is no system audio helper on Windows: an
  audio-only meeting hears the other participants only through a loopback input (Stereo Mix,
  VB-Audio Cable) picked under Settings › Audio › Meeting audio, while a **Screen + sound**
  recording gets them from Electron's display-media loopback.

### Build locally

```bash
npm ci
KESAMI_CLOUD_URL=https://<your-relay-host> npm run dist:mac    # on a Mac: UI + release backend + mic-watch, then electron-builder
KESAMI_CLOUD_URL=https://<your-relay-host> npm run dist:win    # on Windows: UI + release backend, then electron-builder
```

This needs `apps/ui/.env` with `KESAMI_AUTH_PROVIDER=supabase`, `KESAMI_SUPABASE_URL`, and
`KESAMI_SUPABASE_PUBLISHABLE_KEY`, plus a public HTTPS `KESAMI_CLOUD_URL` in the
packaging environment. Provider keys stay on the relay server. The `.dmg`, `.zip` and `.exe` land in
`apps/desktop/release/`. Each platform's build needs its own release backend
(`kesami-core-backend` or `kesami-core-backend.exe`), so build on the platform you are packaging for.

### Publish a release

After committing the release changes, pushing a `v*` tag runs `.github/workflows/release.yml`. It
sets the app version from the tag, builds the `.dmg` and `.zip` on a macOS runner and
`Kesami-Setup-x64.exe` on a Windows runner, then a final job attaches all three to a release with the
same tag in `kesami-releases`. If either platform fails, nothing is published.

```bash
git push origin HEAD
git tag v1.0.2
git push origin v1.0.2
```

You can also start it by hand from the Actions tab (**Release → Run workflow**) with a tag name.
Running it for a tag that already has a release replaces that release's files and notes.

One-time repo setup (Settings → Secrets and variables → Actions):

| Kind     | Name                              | Value                                                                          |
| -------- | --------------------------------- | ------------------------------------------------------------------------------ |
| Variable | `KESAMI_SUPABASE_URL`             | Supabase project URL                                                           |
| Variable | `KESAMI_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` key                                                         |
| Variable | `KESAMI_CLOUD_URL`     | Required HTTPS origin of the transcription and AI relay (see `CLOUD_TRANSCRIPTION.md`)         |
| Secret   | `RELEASES_TOKEN`                  | Fine-grained token with **Contents: read and write** on `kesami-releases` only |

The workflow's built-in `GITHUB_TOKEN` stays read-only. It can't write to another repository, which
is why publishing to `kesami-releases` needs `RELEASES_TOKEN`.

### Signing and notarization

Builds are unsigned and not notarized, because signing for distribution requires the paid Apple
Developer Program. As a result macOS may show "Apple could not verify
Kesami" on first launch, most reliably after a browser download. Users who trust the app click
**Open Anyway** in System Settings → Privacy & Security once. Download the DMG from the GitHub
release and drag Kesami into Applications. Auto-update is not available for unsigned builds.

The separate `kesami-releases/install.sh` currently requires a valid code signature and therefore
cannot install this unsigned build. Use the DMG until that installer supports unsigned releases.

The Windows installer is not Authenticode-signed either, so Microsoft Defender SmartScreen shows
"Windows protected your PC" until the download builds reputation. Users who trust the app click
**More info**, then **Run anyway**. Signing it needs a code-signing certificate, which
electron-builder picks up from `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` once one exists.

The release workflow does not need Apple or Windows signing credentials.
