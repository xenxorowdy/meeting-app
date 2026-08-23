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

---

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

# Run the legacy JavaScript compatibility suite during migration
npm run --prefix apps/core-backend test:legacy
```
