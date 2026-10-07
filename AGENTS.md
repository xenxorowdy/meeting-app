# Kesami Agent Guide

Verified against the working tree on 2026-10-06. Recheck source before relying on details; older architecture documents contain historical plans and outdated runtime descriptions.

## Product and direction

Kesami is a macOS-first meeting assistant: microphone/system-audio capture, optional audio or screen recordings, Sarvam transcription, summaries, decisions, editable action items, local meeting folders, replay/export, and scoped Ask AI. Calendar, connector, account and billing integrations also exist. Windows packaging is configured; native system-audio capture uses the macOS helper, with loopback/display fallback elsewhere. Configured targets are not proof of packaged capture parity.

Product direction from the owner's brief: **Meeting Recorder → AI Meeting Notes → Meeting Intelligence → Personal Meeting Memory → AI Work Assistant**. Meeting Memory now associates typed people/company/topic references and source-linked decisions/commitments with meetings; this is a local knowledge index, not an autonomous agent system. Prioritize privacy, local storage, speed, factual answers, source references and minimal professional UX. Require human confirmation before external actions in new flows; existing connectors have opt-in automatic sending, so inspect that behavior explicitly.

## Architecture, directories and stack

The root is an npm workspace (`apps/*`), requiring Node >=22.12.0. The renderer uses HTTP/WebSocket to Rust and named preload APIs for OS operations. Default core address: `http://127.0.0.1:48900`, WebSocket `/ws`.

| Path | Responsibility / entry points |
| --- | --- |
| `apps/ui` | React 19, JavaScript/JSX, Vite 6, Tailwind 3, Radix/Shadcn controls, Lucide. `src/main.jsx` → `App.jsx` → `components/design/DesignWorkspace.jsx`; `src/widget.jsx` is separate. |
| `apps/ui/src/hooks`, `src/lib` | Feature state/capture orchestration and shared clients. `useMeetingSession`, `useMeetingHistory`, `useMeetingChat`; `lib/backend.js` and `lib/connection.js` centralize API/auth/transport. |
| `apps/desktop` | Electron 44; `main.js` starts/reuses/watches Rust, owns windows/tray/Dock/permissions. `preload.js`, `widgetPreload.js`, `rendererSecurity.js` define native boundaries. `recorder.js`, `systemAudio.js`, Swift `mic-watch/` handle media/native integration. |
| `apps/core-backend/src` | Rust 2021, Tokio, reqwest/rustls, serde, rusqlite and SQLx/Postgres. `main.rs` owns session state, HTTP/WS routing and composition; `lib.rs` exports audio/DSP/billing utilities. |
| `apps/core-backend/src/memory.rs` | Source-validated extracted facts, transcript fingerprints, entity references and task-state preservation. |
| `apps/core-backend/src/actions.rs`, `action_providers.rs` | Post-meeting suggestions, confirmation/attempt ledger, provider interface and adapters. |
| `apps/core-backend/src/commitments.rs` | Local English commitment detection, grounded candidates, classification and human review. |
| `apps/core-backend/src/chat` | SQLite FTS5 search, local fastembed/ONNX embeddings, evidence validation, persistent conversations. |
| `apps/core-backend/src/bin/kesami-cloud-relay.rs` | Separate hosted provider relay, using Hyper and authenticated HTTPS/WSS; built with `--no-default-features`. Holds provider keys, validates Supabase users, enforces limits and serves hosted billing routes. |
| `apps/core-backend/migrations` | Explicit Supabase users/billing SQL; Supabase is for identity/billing, not canonical meeting storage. |
| `apps/extension` | Manifest V3 browser extension observing Meet/Zoom names, speaking, mute and call-end state; not an audio recorder. |
| `test` | Node tests, real-Rust/mock-provider integration tests, isolated Electron render/interaction harnesses. |
| `docs`, `ARCHITECTURE.md` | Detailed references; start with `docs/HOW-KESAMI-WORKS.md`, `MEETING-CHAT.md`, `PAYMENT-PIPELINE.md`, and `CLOUD_TRANSCRIPTION.md`, then verify source. |
| `.github/workflows`, `deploy/oracle`, backend Dockerfiles | CI/release and deployment configuration; configuration is not evidence of live deployment. |
| `website` | Separate Next.js 16/React 19/TypeScript marketing site; outside root `apps/*` workspaces, with its own guide/package/lockfile. |
| `ultrademo-workspace`, `brag-output*` | Auxiliary demo/video tooling and artifacts, outside the desktop runtime. |

UI navigation is component state (`activeTab`), without a primary URL router. State uses React hooks, callbacks and refs; do not assume Zustand is installed. Preserve coral branding, shared design styles and light/dark themes. Follow active imports before changing older components.

## Recording → transcription → summary

1. `App`/`useMeetingSession` coordinate start, source selection and permissions. Capture helpers serialize device ownership and reject stale startup callbacks.
2. Microphone and native/loopback system audio become mono 16 kHz signed 16-bit PCM. Audio packets have a **16-byte little-endian header**: u32 stream ID, i64 timestamp, u32 payload length; stream 0 is microphone, 1 system.
3. Rust meters audio, applies configured denoise/echo/mute handling, and streams separate channels to Sarvam realtime. Release clients use the authenticated cloud relay; direct-key development can call Sarvam directly.
4. Final transcript turns are saved during recording and emitted over WS; partials remain interim. The microphone is normally `You`; remote identities are provisional unless supported by observations or user correction.
5. Optional MediaRecorder WebM chunks go through Electron IPC to disk, not an accumulating renderer Blob. Stopping closes recording writes, drains realtime STT, optionally performs direct-key batch diarization, then summarizes and saves the completed record/documents.
6. `autoSummarize: false` suppresses automatic summary generation, **not live transcription transmission**. Batch diarization is disabled for cloud-managed clients; the direct batch path currently uploads the original recording file, which may contain screen video.

## AI architecture

`summarizer.rs` selects Gemini (default model `gemini-2.5-flash`), Claude CLI when available locally, or a heuristic fallback. OpenAI is a quota-exhaustion fallback with budget handling, not the normal primary provider. Cloud-managed calls use relay-held credentials.

Summaries use structured JSON, transcript-index source references mapped to stable turn IDs, topic sections, decisions, action items and an email draft. Long input currently retains the beginning/end around a 120,000-byte transcript limit; heuristic extraction and legacy decision records without provenance are limitations, not reliable confirmed facts. New memory records require exact quotes and stable turn references; changing transcript text/speakers invalidates them.

Ask AI retrieves **before** generation: completed meetings use SQLite FTS5/BM25 plus pinned multilingual E5-small embeddings/cosine ranking and reciprocal-rank fusion; absent embeddings fall back to keywords. Explicitly selected live meetings use a temporary keyword index. Scope supports meeting IDs, folders/all completed meetings and date bounds. Limits: 12 passages, 6,000 serialized evidence bytes, 1,500 history bytes, 8,000 prompt bytes. Prior assistant answers are never evidence.

Chat validates citation numbers/inline references, checks source revisions, allows one corrective response, and supports idempotent request IDs/cancellation. This proves reference resolution, not semantic truth. Coverage/retrieval mode are meaningful; cosine scores and transcript `confidence: 1.0` are not calibrated certainty. Preserve abstention for insufficient evidence.

The finished-meeting **Commitments** tab reviews local candidates from `metadata.meetingCommitments` v1. Detection runs at completion, summary regeneration, or explicit POST `/api/meetings/:id/commitments`; PATCH `/:candidateId` confirms/dismisses with the expected transcript revision. Explicit promises, suggestions, reported third-party promises, discussion and unclear speech remain distinct. Confirmation adds/deduplicates a local task with provenance; qualitative confidence describes wording, not calibrated truth. No provider calls or external actions occur in detection/review. Preserve review state, reviewed task fields/completion, stale-source rejection and atomic completed-meeting writes.

Finished-meeting **Actions** derives local suggestions from tasks, actionable commitments and existing email drafts, without a new model call. GET `/api/meetings/:id/actions` returns suggestions/history and safe provider destinations; POST `/:actionId` requires a reviewed payload, explicit confirmation and source revision. `metadata.postMeetingActions` v1 stores durable attempts, reviewed fields, source snapshot, local drafts and receipts. Local tasks preserve IDs/completion/custom fields; drafts are never sent. Google Calendar/Jira reuse existing credentials behind `ActionProvider`; no provider calls from extraction. Preserve atomic reservation before dispatch, provider destination revision checks, stale rejection and repeat-success idempotency. Definite permission/request/rate-limit rejections permit fresh user-confirmed retry; timeouts/malformed success/server errors and interrupted `executing` attempts block resend. History survives source edits/regeneration, with stale excerpts hidden. No automatic reconciliation or email-account integration exists yet. Completion auto-push excludes task connectors (including legacy opt-in settings); opted-in note exports and existing explicit manual exports remain.

Summary sharing: `SummarySharing.jsx` opens a focused review dialog directly from Summary or the compact Actions section; `useMeetingActions` shares the existing API/confirmation flow. Draft edits stay in component memory while that meeting view remains mounted, including cancel/settings/rejection; source or destination changes clear confirmation. Settings links open Connectors directly. `summary_slack`/`summary_jira` reuse the ledger/private credentials: Slack posts reviewed plain text through its channel-bound webhook; Jira creates one recap issue. No extra AI call, transcript/notes/email attachments or automatic delivery. Preserve revisions, webhook secrecy, mention/unfurl suppression and durable duplicate/unknown blocking across regeneration. Existing opted-in Slack auto-push is separate and disclosed in review. See `docs/SUMMARY-INTEGRATIONS-PLAN.md`.

## Local storage

- `library.rs`: canonical per-meeting `meeting.json`, derived `transcript.md`/`summary.md`, optional adopted `recording.webm`. Electron defaults to `~/Documents/Kesami Meetings`; standalone Rust defaults relative to its data base. `KESAMI_LIBRARY_DIR`/`KESAMI_RECORDINGS_DIR` override roots and must agree for recording adoption.
- Electron writes `.in-progress/<meetingId>/screen.webm` plus recording metadata before adoption. Preserve interrupted files and legacy playback paths.
- `settings.rs`: `.kesami/settings.json` and private `credentials.json`. Source startup normally uses `apps/core-backend`; packaged backend cwd is Electron userData (normally `~/Library/Application Support/Kesami`). `KESAMI_DATA_DIR` relocates the data base; `CORE_BACKEND_DATA_FILE` also affects compatibility paths.
- SQLite: `accounts.sqlite3` (hashed passwords/session tokens), `billing.sqlite3` (verified entitlements/usage); library `.kesami-chat/search.sqlite`, `threads.sqlite`, `models/`. Search schema v2 includes normalized entities, meeting links and fact records; canonical extraction lives in `metadata.meetingMemory`. Chat/search files are derived or auxiliary; preserve user conversations.
- Backend loads complete meetings into an in-memory map. `metadata.collectionId` represents a logical folder; `folder` represents the filesystem folder. Legacy JSON import and `ALPHA_*`/Alpha locations remain compatibility paths.
- Meeting files are plaintext; private credential-file permissions are not encryption. Deleting a meeting does not erase excerpts already stored in chat history.

## Security, privacy and invariants

- Never commit/log credentials, tokens, user transcripts or prompts. Gemini/OpenAI/Sarvam keys may be in ignored local `apps/core-backend/.kesami/credentials.json` or `KESAMI_*_API_KEY` environment overrides; private credential writes must remain owner-only (`0600`). Treat `.kesami`, meeting libraries and recordings as user data; do not delete/overwrite them without task authorization.
- Distributable clients carry only allowlisted public Supabase config and a bare HTTPS `KESAMI_CLOUD_URL`. Provider keys, service-role credentials and owner DB connections belong on the backend/server, never renderer bundles/packages.
- Distinguish local persistence from remote processing: live audio goes to STT; summary text/retrieved chat excerpts go to AI; connectors/MCP expose meeting content when used. Do not claim all processing is offline or providers never retain content.
- Preserve sandboxed Electron windows, `contextIsolation: true`, `nodeIntegration: false`, trusted top-frame IPC, navigation restrictions and narrowly allowed permissions. Do not expose generic IPC/filesystem APIs.
- Preserve canonical-path/symlink checks for media and batch recordings. Keep `48900` private by default; non-loopback core binding requires a strong token and exact allowed origins. Local core currently permits tokenless native requests; accounts share one library and one active session, without tenant isolation.
- Keep API payloads, WS event names/audio framing, stable meeting/turn IDs, timestamp-to-recording offsets, legacy imports and persisted formats backward-compatible. Use additive fields and intentional migrations.
- Preserve speaker edits, captured audio ownership, stop idempotency, cancellation, stale-source rejection, source references and user action-item completion. Summary regeneration currently replaces extracted fields; changes must account for user edits.
- Pro requires provider-verified active/unexpired entitlement. Preserve signed-webhook verification/idempotency and backend-only Supabase billing writes/RLS.

## Coding and future feature rules

- Inspect applicable guides, source and dirty status first. Preserve existing user changes; use `rg`/`rg --files`. Do not edit generated/dependency directories.
- Reuse feature hooks, shared backend clients and existing UI controls. Keep OS/capture work outside render and blocking DB/model work on workers; never hold session locks across provider calls.
- Prefer the smallest production-ready extension. Explain major architecture changes before implementation; avoid rewrites, microservices, agents, new databases or dependencies without a measured user benefit.
- Evolve meeting memory through factual structured records with provenance, revisions and human corrections; distinguish extraction from confirmed decisions/commitments. Preserve durable task state separately from regenerated AI text. New external-action flows require review/confirmation.
- Include loading/empty/error/retry/cancel states and meaningful business-logic tests. Validate the reachable user flow, not just compilation; report exactly what changed and each verification boundary.

## Development and validation

Run from root unless a prefix is shown. Start UI separately alongside `npm run dev`; the desktop dev script itself does not start Vite.

For local runs, use the local Rust backend at `http://127.0.0.1:48900` (HTTP and WebSocket), with the desktop meeting-library/recording roots aligned. Do not point local runs at a hosted workspace or enable the cloud relay unless explicitly requested. Keep packaged release configuration separate.

```bash
npm ci
npm run start:ui             # Vite, normally :5173
npm run dev                  # Electron development shell / backend lifecycle
npm run start:backend        # Rust release-mode standalone backend
npm run build:ui
npm run test:ui
npm run test:backend
npm run test:cloud           # no-default-features relay + public-config tests
npm run test:chat            # builds debug backend, then chat integration
npm run test:actions         # action domain/adapters + isolated local HTTP flow
npm run test:commitments     # detection/review logic + isolated real-backend flow
npm run test:audio           # synthetic echo/speaker integration
npm run test:meeting-end
npm run test:auth
npm run test:shell
npm run test:node            # builds debug backend + test/*.test.js
npm run test:desktop         # capture-flow + ui-design Electron harnesses
node_modules/.bin/electron test/widget-ui/render.cjs
npm run test:billing         # UI build, billing logic/client + payment render
npm run test:release         # broad local build/test/integration gate
git diff --check
```

UI changes require UI build/closest tests and applicable render harness; Rust changes require backend tests; Electron/full-flow changes require backend tests, UI build and integration checks. Root/UI have no declared lint/typecheck script; do not invent one. Website uses its own `npm run --prefix website typecheck`/`build`.

Inspect test environment before running: use synthetic fixtures and temporary `KESAMI_DATA_DIR`, library and recording roots. `test:billing:db`, live Supabase checks and ignored tests can need disposable/real databases or download the ~487 MB embedding model. Do not automatically run live checks. Mock providers/render harnesses do not prove physical audio, live OAuth/payments or deployed services.

## Build, package and release

- `npm run build:all`: Vite UI + Rust release build. `npm run build:mic-watch` requires Swift/macOS.
- `npm run dist:mac`: builds UI/backend/helper, prepares public auth config, runs electron-builder; ARM64 DMG/ZIP in `apps/desktop/release`, minimum macOS 13. Includes backend/UI/native helpers as resources. Preserve the unsigned path (`identity: null`, notarization disabled); do not require Apple credentials or disable Gatekeeper.
- `npm run dist:win`: builds UI/backend, prepares public auth config, runs electron-builder; x64 per-user NSIS installer `Kesami-Setup-x64.exe` (unversioned on purpose: the website links `releases/latest/download/Kesami-Setup-x64.exe`). Must run on Windows, since it bundles `kesami-core-backend.exe`. macOS-only resources (`SystemAudioDump`, `mic-watch`, the Unix backend) live in `build.mac.extraResources`; keep platform binaries out of the shared `extraResources`. Unsigned: SmartScreen warns on first run.
- `prepareAuthConfig.js` requires Supabase provider/HTTPS project/publishable key and HTTPS relay origin. Source `.env.local` is not packaged client configuration. Verify the actual artifact before claiming distribution works.
- `release.yml`: `v*` tag/manual trigger; `mac` (macos-14) and `windows` (windows-latest) jobs build with Node 22/stable Rust, public repository variables and the version from the tag, then `publish` attaches DMG/ZIP/EXE to `xenxorowdy/kesami-releases` using `RELEASES_TOKEN` (only when both builds succeed; re-runs replace files and notes). It does not invoke the full test gate. CI's `backend-windows` job keeps the backend compiling on Windows between releases.
- Root `package`/`make` delegate two directories upward; use the explicit desktop build path for this repository. `Dockerfile.cloud` builds the relay without desktop/model features; deployment files describe intended configuration, not confirmed live state.

## Known limits to consider before extending

Single active session/shared library; entity identity is normalized exact labels, without alias resolution or person/company management. Global UI search filters title/summary in the loaded 200 meetings, although backend search can examine transcripts. Full library records remain in memory; transcript UI is not virtualized; background indexing scans completed records. Realtime provider queues are unbounded locally. Long summaries omit middle input; legacy decisions lack turn-level provenance; older typed company/project extraction requires summary regeneration. Local commitment detection uses conservative English cues/common explicit date wording, can miss nuanced/multilingual promises, and bounds scanning at 2 MB/100 candidates (skipping sentences over 1 KB); partial coverage is shown. Company/project references use source-supported memory labels; relative dates remain as spoken. Heuristic fallbacks and static confidence fields must not be promoted to certainty. Podcast routes/desktop bridges are disabled while old modules/data remain. See `docs/MEETING-MEMORY.md`, `docs/MEETING-COMMITMENTS-PLAN.md`, and the earlier `docs/ENGINEERING-PRODUCT-AUDIT.md`; verify findings before fixing them.
