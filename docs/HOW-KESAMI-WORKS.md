# How Kesami works

A one-page system map of the Kesami desktop app. It replaces the in-app
"Architecture" page, which was removed from the client on 2026-10-02 because it
was developer-facing. For the full reference, see [`ARCHITECTURE.md`](../ARCHITECTURE.md);
for the hosted relay, see [`CLOUD_TRANSCRIPTION.md`](../CLOUD_TRANSCRIPTION.md).

Kesami is a local-first desktop app with clear boundaries between the interface,
the operating system, and the services it talks to.

## Layers

```
┌──────────────────────────┐
│ Desktop shell            │  apps/desktop (Electron)
│ windows, tray, OS        │  owns permissions and recording files
│ permissions, recordings  │
└────────────┬─────────────┘
             │ preload bridge (named, argument-checked IPC)
┌────────────▼─────────────┐
│ React interface          │  apps/ui
│ views and feature hooks  │  meetings, library, Ask AI, settings
└────────────┬─────────────┘
             │ HTTP · WebSocket (127.0.0.1:48900)
┌────────────▼─────────────┐
│ Rust core backend        │  apps/core-backend
│ sessions, transcription, │  runs on the user's computer
│ summaries, persistence   │
└────────────┬─────────────┘
             │ HTTPS · WSS, authenticated with the user's Google session
┌────────────▼─────────────┐
│ Kesami cloud relay       │  apps/core-backend/src/bin/kesami-cloud-relay.rs
│ provider keys, limits    │  holds the Sarvam and Gemini keys
└──────────────────────────┘
```

| Layer | Responsibility | Lives in |
| --- | --- | --- |
| Desktop shell | Electron windows, tray, OS permissions and local recording files | `apps/desktop` |
| React interface | Views and feature hooks for meetings, the library, Ask AI and settings | `apps/ui` |
| Rust core backend | HTTP and WebSocket APIs for sessions, transcription, summaries and persistence | `apps/core-backend`, on `127.0.0.1:48900` |
| Cloud relay (release builds) | Verifies the user's Supabase Google session, then calls Sarvam and Gemini with keys only the relay holds | `apps/core-backend/src/bin/kesami-cloud-relay.rs` |

## Data boundary

- Recordings and the meeting library stay on the user's computer, in
  `~/Documents/Kesami Meetings`.
- While a meeting is being recorded, its audio is streamed for live
  transcription. In release builds that goes through the cloud relay; in
  development builds with a local key, it goes straight to Sarvam.
- Meeting text is sent to the AI service only when a summary is generated or a
  question is asked in Ask AI.
- Accounts do not create isolated meeting libraries: everyone using one backend
  shares its library.

## What connects to the core

| Capability | How it works |
| --- | --- |
| Meeting capture | Electron captures the microphone and system audio. The UI streams audio to the backend, which returns live transcript events. |
| Local library | Each meeting is a folder of JSON and Markdown. SQLite stores accounts, billing, chat and search. |
| AI providers | Sarvam handles speech recognition. Gemini (through the relay in release builds) writes summaries and grounded chat answers. |
| Sign-in | Release builds sign in with Google through Supabase. Development builds also offer email and password. |
| Connected services | Google and Microsoft calendars provide events when their OAuth clients are configured. Payments use Razorpay (INR) and Stripe (USD). |

The renderer talks to the backend only through the shared HTTP and WebSocket
client utilities in `apps/ui/src/lib`. OS access goes through the named Electron
preload APIs in `apps/desktop/preload.js`.
