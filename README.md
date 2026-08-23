# Alpha Commercial Meeting Assistant

A standalone, privacy-first, bot-free meeting assistant for **macOS** and **Windows**.

## Architecture Overview

This project is decoupled into two clean, independent applications:

```
packages/meeting-app/
├── apps/
│   ├── ui/             # React 19 + Tailwind CSS + Shadcn UI Desktop Client
│   └── core-backend/   # Rust performance core + Node.js compatibility implementation
└── package.json        # Workspace orchestrator
```

### 1. Frontend Client (`apps/ui`)

- **Live Meeting HUD**: Floating/dockable recording controls, audio level visualizers, duration timer, and mute toggles.
- **Transcript Stream**: Real-time speaker badges (`"You"` vs `"Speaker 1, 2..."`) with search filtering.
- **AI Summary Editor**: Executive summary, key decisions list, interactive action items table, and copy-ready follow-up email drafts.
- **History Explorer**: Searchable local meeting database with instant full-text search.
- **Podcast Studio**: Meeting-first, source-grounded two-host scripting, multitrack capture/editing, local speech cleanup, WAV/MP3/MP4 rendering, RSS and owned-YouTube caption import, and private YouTube podcast publishing.
- **Settings & Licensing**: Audio device selectors, AI model preferences (Claude / OpenAI / Local), and Pro license key activation.

### 2. Core Backend Engine (`apps/core-backend`)

The production entrypoint is now Rust (`core-backend/src/main.rs`). It keeps the
existing HTTP and WebSocket contract on `127.0.0.1:48900`, uses Tokio for
concurrent connections, and moves the binary audio packet parser and integer RMS
calculation out of the JavaScript event loop. The original Node.js engine remains
available as `npm run test:legacy` while the remaining native STT and licensing
providers are migrated behind the same API.

- **Native Audio Capture**: ScreenCaptureKit (macOS) & WASAPI Loopback (Windows) over 16-byte binary streaming IPC.
- **Audio DSP & VAD**: Zero-copy 16 kHz resampler, integer sum-of-squares RMS VAD, and acoustic echo suppression.
- **Speech-to-Text (STT)**: WhisperKit (Apple Neural Engine) and `whisper.cpp` / ONNX (Windows/Intel).
- **Diarization Engine**: Guaranteed physical `"You"` attribution on mic + acoustic clustering on system audio + LLM name resolution.
- **Storage Layer**: Rust atomic local persistence with multi-format export (Markdown, JSON); SQLite/FTS5 remains behind the compatibility implementation during migration.
- **AI Summarizer**: Structured meeting intelligence through the Claude Code CLI (no API key required), with a keyword heuristic as the offline fallback. See [Meeting summaries](#meeting-summaries).
- **Billing & Licensing**: License key verification and Free vs Pro tier quota enforcement.
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
| `ALPHA_SUMMARY_PROVIDER`       | `auto`              | `auto` uses the CLI when installed; `heuristic` forces the offline summarizer.                  |
| `ALPHA_CLAUDE_BIN`             | _(auto-discovered)_ | Explicit path to the `claude` binary. Checked before `PATH` and the per-user install locations. |
| `ALPHA_SUMMARY_MODEL`          | `sonnet`            | Model alias or full name passed to `--model`.                                                   |
| `ALPHA_SUMMARY_TIMEOUT_SECS`   | `180`               | Per-summary wall-clock budget.                                                                  |
| `ALPHA_SUMMARY_MAX_BUDGET_USD` | _(unset)_           | Optional `--max-budget-usd` cap per summary.                                                    |
| `ALPHA_SUMMARY_SAFE_MODE`      | `1`                 | Set to `0` to let local Claude Code customizations apply.                                       |

`GET /health` and `GET /api/status` report the resolved engine under `summary`
(`{"provider":"claude-cli","binary":"…","model":"sonnet"}`), `POST /api/summary/config` switches the
model at runtime, and `POST /api/meetings/:id/summarize` returns the stored notes — or regenerates
them with `{"regenerate": true}`.

## Transcription providers

The Transcription settings offer two distinct flows:

- **Whisper** transcribes microphone and meeting-audio segments live on the device.
- **Sarvam Saaras** waits until the meeting ends, uploads the completed mixed WebM recording as one batch, requests speaker diarization, replaces the transcript with timestamped speaker turns, and then runs the normal summary pipeline.

Sarvam batch mode requires the Alpha desktop app because Electron owns the recording files. It also requires screen recording to remain enabled so the saved recording contains both microphone and meeting audio. Configure the API key in Settings; it is stored in the private local credentials file and is never returned by the backend.

| Variable                    | Default                 | Purpose                                       |
| :-------------------------- | :---------------------- | :-------------------------------------------- |
| `ALPHA_SARVAM_API_KEY`      | _(stored key)_          | Overrides the saved Sarvam API key.           |
| `ALPHA_SARVAM_TIMEOUT_SECS` | `900`                   | Maximum wait for a batch transcription job.   |
| `ALPHA_SARVAM_BASE_URL`     | `https://api.sarvam.ai` | API base override, primarily for testing.     |
| `ALPHA_RECORDINGS_DIR`      | _(set by Electron)_     | Trusted root used to resolve recording paths. |

---

## Calendar connections

Google Calendar and Microsoft Outlook connect over OAuth 2.0 authorization code + PKCE with a
loopback redirect. A desktop app cannot keep a client secret, so there is none in the flow: the
consent page opens in the user's real browser and comes back to a listener the backend opens on
loopback for exactly one request, on an ephemeral port chosen per attempt. Scopes are read-only
(`calendar.events.readonly`, `Calendars.Read`) — Alpha never writes to a calendar.

Refresh tokens live in `credentials.json` alongside the API keys, written `0600`. Access tokens are
refreshed a minute before expiry; Microsoft's rotating refresh tokens are re-stored on each refresh.

### One-time setup

Both providers need an OAuth client id, which identifies the app rather than the user. Set it in
**Settings → Calendar**, or as an environment variable.

**Google** — Cloud Console → enable the _Google Calendar API_ → _OAuth consent screen_ (add the
`calendar.events.readonly` scope and yourself as a test user) → _Credentials_ → _Create OAuth client
ID_ → application type **Desktop app**. Google issues a client secret for desktop clients; paste it
too if the token exchange asks for one.

**Microsoft** — Entra admin center → _App registrations_ → _New registration_, account types
including personal Microsoft accounts → _Authentication_ → _Add a platform_ → **Mobile and desktop
applications** → redirect URI `http://localhost`. Registering the bare host is what allows the
dynamic port; do not pin one.

| Variable                              | Purpose                                                    |
| :------------------------------------ | :--------------------------------------------------------- |
| `ALPHA_GOOGLE_CALENDAR_CLIENT_ID`     | Google OAuth client id. Checked before the stored setting. |
| `ALPHA_GOOGLE_CALENDAR_CLIENT_SECRET` | Only if Google's token endpoint demands it.                |
| `ALPHA_MICROSOFT_CALENDAR_CLIENT_ID`  | Entra application (client) id.                             |

### API

| Route                           | Purpose                                                               |
| :------------------------------ | :-------------------------------------------------------------------- |
| `GET /api/calendar/status`      | Per provider: connected, configured, signed-in account.               |
| `POST /api/calendar/connect`    | `{"provider"}` → `{"authUrl"}`. Opening it is the caller's job.       |
| `POST /api/calendar/disconnect` | Forgets the stored tokens for one provider.                           |
| `GET /api/calendar/events`      | Merged, time-sorted events. `minutesBack` (15), `minutesAhead` (720). |

Completion arrives as a `calendar_connection` WebSocket event rather than a response to `connect`,
because the consent round trip runs through the browser.

---

## Podcast Studio

The desktop sidebar includes **Podcast Studio**. Projects and copied media are stored beneath Electron's private `userData/podcast-projects` directory with atomic, versioned manifests. Existing meeting records are linked by ID and are not rewritten.

Script and multi-speaker voice generation use the Gemini key configured in Alpha. The user must explicitly start each cloud operation; only transcript or script text is sent. Media cleanup and rendering remain local. YouTube uses OAuth PKCE, imports metadata/captions only for videos owned by the connected account, and uploads new episodes as private before opening YouTube Studio.

Local media operations require FFmpeg/ffprobe. Speech cleanup additionally requires the DeepFilterNet `deep-filter` executable. Development builds discover these on `PATH` or through the variables below; packaged builds should place reviewed binaries under `resources/media-tools/<platform>/<arch>/`. See `apps/desktop/media-tools/README.md` for the packaging contract and license checklist.

| Variable | Purpose |
| :-- | :-- |
| `ALPHA_FFMPEG_PATH` | Explicit FFmpeg executable; Electron passes its resolved copy to the Rust backend. |
| `ALPHA_FFPROBE_PATH` | Explicit ffprobe executable. |
| `ALPHA_DEEP_FILTER_PATH` | Explicit DeepFilterNet CLI executable. |
| `ALPHA_PODCAST_SCRIPT_MODEL` | Gemini structured-script model override. |
| `ALPHA_PODCAST_TTS_MODEL` | Gemini multi-speaker TTS model override. |
| `ALPHA_PODCAST_TIMEOUT_SECS` | Gemini request timeout; defaults to 300 seconds. |
| `ALPHA_GOOGLE_OAUTH_CLIENT_ID` | Packaged or developer Google desktop OAuth client ID for YouTube. |

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

# Run the legacy JavaScript compatibility suite during migration
npm run --prefix apps/core-backend test:legacy
```
