# Kesami engineering and product audit

Audited 2026-10-06 against the current, intentionally dirty working tree. Application code was not changed. This report describes source behavior and isolated checks, not deployed production state.

Concurrent working-tree changes added Windows packaging and renamed the release workflow during the audit. Package/release facts and links below were refreshed before delivery; checks performed here remain macOS/local fixture checks.

**Assessment:** Kesami already provides a useful capture → transcript → replay → evidence-linked answer workflow. Its strongest value is keeping a reviewable personal record without a meeting bot. The next investment should make that record trustworthy, searchable across the complete library, and durable across corrections. More integrations or autonomous agents would not address the main gaps.

Inspection covered workspace/package manifests, active UI and desktop entry points, Rust session/routing/storage code, DSP/capture helpers, Sarvam and summary providers, chat indexing/context/validation, accounts/billing/Supabase migrations, IPC/security, test harnesses, CI/release/Docker/deployment configuration, the marketing site's privacy claims, and auxiliary directory/package boundaries. Dependencies, generated media/build files and private user-data/credential contents were excluded.

Evidence labels below distinguish verified source behavior from a risk inferred from a code path. Recommendations and roadmap gates are proposed work, not implemented capabilities.

## 1. Critical problems

### C1. Direct-key batch transcription can transmit screen video

**Verified source behavior; privacy priority.** Screen capture produces a WebM containing video and mixed audio. `finish()` passes its recording path to Sarvam batch transcription, which streams the original file to the provider's upload URL. There is no audio-only conversion at this boundary; an `audio/webm` content-type does not remove video bytes. Post-meeting diarization can be enabled by default in the direct-key path.

This affects direct-key/local development configurations. Cloud-managed release clients skip this batch pass, so it is not a claim that every released recording uploads video.

**Recommendation:** send an audio-only derivative; show exactly what leaves the Mac before batch processing; preserve the original locally. Verify with a synthetic recording containing a video track that uploaded bytes contain no video. This should precede expanding batch features.

Evidence: [screenRecorder.js](../apps/ui/src/lib/screenRecorder.js), `startScreenRecording`; [main.rs](../apps/core-backend/src/main.rs), `finish`/`batch_recording_path`; [sarvam.rs](../apps/core-backend/src/sarvam.rs), `transcribe`.

### C2. Long-running summary writes can replace newer user state

**Verified replacement behavior; concurrency consequences inferred, not race-reproduced.** Regeneration takes a meeting snapshot, awaits a provider, replaces summary/decision/action fields, and saves the entire snapshot. There is no chat-style source-revision check or conditional commit. A concurrent edit can be overwritten; deletion during generation can be followed by `Store::put` recreating the record. The regeneration confirmation acknowledges replacing notes, but it does not make a stale write safe.

Generated action items contain task/owner/deadline/priority/source IDs, but no stable task ID or carried-forward completion. Existing per-meeting completion/manual additions therefore do not survive replacement as durable work state.

**Recommendation:** versioned conditional writes and deletion tombstones; merge generated fields into current records; store human edits/task status independently. Cover edit-during-generation, delete-during-generation, cancellation and repeated regeneration with regression tests.

Evidence: [main.rs](../apps/core-backend/src/main.rs), `route_meeting` summary branch, `summarize_into`, `Store::put`; [summarizer.rs](../apps/core-backend/src/summarizer.rs), `from_structured`; [SummaryEditor.jsx](../apps/ui/src/components/SummaryEditor.jsx), regeneration confirmation.

### C3. Some successful-looking live updates ignore persistence errors

**Verified source behavior; durability priority.** Final transcript turns are checkpointed during recording, contrary to an end-only-persistence interpretation. However, `commit_live_turn` discards save errors and still emits the turn. Live note add/remove also discard write failures; some document writes are ignored or only logged. Disk-full/permission failures can leave visible state ahead of recoverable disk state.

`Store::delete` removes the in-memory entry before filesystem deletion succeeds. Library writes use temporary-file rename but not the credential writer's explicit flush/sync protocol. Interrupted media files are preserved, but there is no verified restart flow that reconciles an unfinished meeting, its transcript, and `.in-progress` recording into a recoverable user-facing result.

**Recommendation:** explicit durable/pending/failed state, bounded retry, flush at lifecycle boundaries and restart reconciliation. Surface errors without interrupting capture unnecessarily. Test failed saves/deletes and abrupt termination; preserve recoverable originals.

Evidence: [main.rs](../apps/core-backend/src/main.rs), `commit_live_turn`, `add_note`, `remove_note`, `Store::delete`; [library.rs](../apps/core-backend/src/library.rs), `write_atomically`; [settings.rs](../apps/core-backend/src/settings.rs), `write_object`; [recorder.js](../apps/desktop/recorder.js), exclusive in-progress creation.

### C4. Fallback notes can present guesses as decisions and commitments

**Verified source behavior; AI trust priority.** Heuristic extraction labels sentences containing “decided”, “agreed” or “we will” as decisions, and “will”, “need to” or “todo” as actions. It does not establish agreement, handle negation, resolve a proposed versus accepted commitment, or supply supporting turn IDs. “We haven't decided” can satisfy the decision keyword test.

The main brief displays the same decisions/next-steps surfaces and a generic “AI-generated” footer. Provider/warning information is not a durable, prominent reliability record in that brief. These derived summaries/decisions/actions are subsequently searchable evidence, which can amplify an incorrect extraction into historical answers.

**Recommendation:** visibly label degraded output and extraction candidates; abstain from asserting decisions/commitments without support. Require provenance for confirmed facts, including decisions, and prefer transcript evidence when derived claims conflict.

Evidence: [summarizer.rs](../apps/core-backend/src/summarizer.rs), `heuristic_summary`, summary schemas/`from_structured`; [MeetingDetail.jsx](../apps/ui/src/components/design/MeetingDetail.jsx), `BriefPoints`/brief footer; [chat/index.rs](../apps/core-backend/src/chat/index.rs), `chunks`.

## 2. High-impact improvements

### Make the complete library searchable

The active global search updates `DesignWorkspace`'s own query and filters only loaded titles/summaries. `useMeetingHistory` loads at most 200 records; its backend-search query is not connected to this field. The backend can search transcript text, but its list implementation scans/clones full records rather than using FTS. The visible experience therefore misses transcript-only matches and older meetings despite the searchable-memory positioning.

Connect global search to a paginated backend search contract; return metadata/snippets instead of whole transcripts. Expose person/project/date filters as structured capabilities emerge. Keep keyword search available before embeddings finish downloading. Verify transcript-only and >200-meeting matches through the real active search field.

Evidence: [DesignWorkspace.jsx](../apps/ui/src/components/design/DesignWorkspace.jsx), `visible`/global input; [useMeetingHistory.js](../apps/ui/src/hooks/useMeetingHistory.js), `load`; [main.rs](../apps/core-backend/src/main.rs), `Store::list`.

### Preserve complete long-meeting evidence

`MAX_TRANSCRIPT_CHARS` is actually enforced using byte length. Beyond 120,000 bytes, summary input keeps approximately 40% from the beginning and 60% from the end, omitting the middle. Source indices still resolve against the full original request, so reference resolution alone does not establish that a cited turn was supplied to the model. Notes/attendee metadata are appended outside that transcript cap. There is no end-to-end summary payload budget comparable to chat's bounded evidence packet.

Use bounded chronological extraction over every transcript segment, then synthesize supported facts. Record coverage, original turn IDs and omissions. Keep this an explicit job pipeline inside Rust with cancellation/caching, not an agent framework. Evaluate multilingual and middle-of-meeting decisions, not only valid JSON.

Evidence: [summarizer.rs](../apps/core-backend/src/summarizer.rs), `render_transcript`, `trim_middle`, `from_structured`.

### Turn existing next steps into durable meeting memory

Per-meeting task completion and manual creation already work. What is missing is stable lifecycle across regeneration/meetings, a global unresolved-work view, deduplication, and explicit links to owners/projects/commitments. The deterministic “all action items” answer emits JSON-like item text and does not provide a structured unresolved-only query. Person names are transcript labels/metadata, not resolved identities.

Start with stable action IDs, recorded completion state, explicit unknown status, original evidence and a global pending view. Then add human-correctable people/project associations and decisions that can be superseded by later decisions. Do not infer completion from silence.

Evidence: [MeetingDetail.jsx](../apps/ui/src/components/design/MeetingDetail.jsx), `NextSteps`; [chat/mod.rs](../apps/core-backend/src/chat/mod.rs), structured action listing; [main.rs](../apps/core-backend/src/main.rs), `Meeting`; [workspace.rs](../apps/core-backend/src/workspace.rs), logical folders.

### Align external actions with the product principle

Seven connectors support publishing notes or creating tasks. An explicit “Send after every meeting” opt-in exists, so this is not unauthorized default sending. Nevertheless, `finish()` can publish generated content without per-meeting review, conflicting with the owner's confirmation-before-external-actions direction. Task connectors can create multiple external work items from uncertain extraction.

Make reviewable drafts the normal workflow. Show destination, content and task count; require confirmation, retain receipts and make retries idempotent. Decide explicitly how existing auto-push preferences migrate. Preserve useful export workflows rather than remove integrations indiscriminately.

Evidence: [ConnectorsPanel.jsx](../apps/ui/src/components/ConnectorsPanel.jsx), `handleAutoPush`; [main.rs](../apps/core-backend/src/main.rs), `auto_push`; [connectors.rs](../apps/core-backend/src/connectors.rs), `SPECS`/delivery methods.

### Improve trust and first-use UX

| Flow | What works | Friction / proposed improvement |
| --- | --- | --- |
| Onboarding | Cloud Google-only configuration, retries, honest engine-offline message | Cannot reach first value when engine/auth setup fails; prominent “your disk” language gives less processing context than the website privacy page. Add concise data-flow disclosure, capture preflight and an intentional local-only policy. |
| Recording | Source picker, audio/screen modes, mute/pause/stop, stop retry | Multiple device/platform fallback paths; permission failure can leave only one side captured. Show mic/system/recording/STT readiness separately and use a short test capture. |
| Meeting list | Clear cards/folders and destructive-delete confirmation | Partial loaded collection can look exhaustive; search changes folder scope to all. Add pagination/counts and preserve/announce scope changes. |
| Meeting details | Summary/transcript/recording tabs, source timestamps, replay | “Processing” conflates STT and summary; one label says “Generating summary” across stages. Show saved transcript immediately and stage-specific progress. |
| Transcript | Search, speaker filters/correction, copy, source navigation | Long lists fully render; remote names remain provisional without extension evidence. Mark uncertain attribution and persist transcription gaps. |
| Summary | Topic bullets with transcript links, editable advanced notes | Decisions lack source links; reliability/fallback/coverage is unclear. Provide persistent provenance and regeneration that preserves human state. |
| Action items | Completion and manual additions | Brief creation is simpler than advanced editing; no global lifecycle, completion provenance or reliable regeneration preservation. Unify task behavior. |
| Ask AI | Saved scopes/threads, sources, cancel/retry, coverage | Source-valid answers can still be unsupported; entity/date workflows are weak. Use factual starters, usable structured results and specific provider errors. |
| Settings | Explicit groups, save verification and useful permission guidance | Provider/platform/calendar/connectors/license complexity; extension setup asks users to load source in developer mode. Tailor settings to capabilities and ship an installable extension before depending on it. |
| Empty/loading/error states | Main library/transcript/chat/sign-in states exist; responsive harness passed | History load failure clears existing rows; dismissing an error can reveal an empty library. Preserve cached rows and distinguish “no data” from “not loaded”; attach retry to the failed operation. |

Evidence: [SignInView.jsx](../apps/ui/src/components/design/SignInView.jsx), [App.jsx](../apps/ui/src/App.jsx), [SettingsModal.jsx](../apps/ui/src/components/SettingsModal.jsx), [useMeetingSession.js](../apps/ui/src/hooks/useMeetingSession.js), [TranscriptView.jsx](../apps/ui/src/components/TranscriptView.jsx), [MeetingChatPanel.jsx](../apps/ui/src/components/MeetingChatPanel.jsx), and the native render harness.

### Bound audio queues and expose loss

Renderer WS sending and Electron recording writes have explicit buffer limits. The cloud relay also limits buffered bytes/messages and stalled providers. The local realtime transcriber uses unbounded audio/event channels; its pump awaits upstream sends without the relay's equivalent per-send bound. A stalled upstream can accumulate PCM locally. Reconnection intentionally discards queued audio during backoff, and normal renderer backpressure can drop audio too.

Add byte-bounded queues/send deadlines and explicit gap intervals while retaining local recording. Persist capture/STT quality metadata and offer a supported recovery path. Do not turn “reconnected” into a claim of complete transcription. Memory growth under a stalled local upstream is a source-derived risk, not a measured leak in this audit.

Evidence: [sarvam_live.rs](../apps/core-backend/src/sarvam_live.rs), stream channels/`pump`/`discard_audio_for`; [backend.js](../apps/ui/src/lib/backend.js), `sendAudio`; [recorder.js](../apps/desktop/recorder.js), write limits; [cloud relay](../apps/core-backend/src/bin/kesami-cloud-relay.rs), buffer limits/tests.

## 3. Medium-priority improvements

### Performance and state ownership

| Source observation | Practical risk | Recommended next step |
| --- | --- | --- |
| Entire meeting library loaded into a Rust HashMap; full records cloned before list pagination | Startup/RSS/response size grow with transcript history | Metadata-only lists, on-demand detail, measured cache bounds. |
| Every finalized turn clones and pretty-serializes the growing meeting | Cumulative serialization/write work grows faster than meeting length | Append journal or batched durable checkpoints; reconcile into existing JSON format. |
| Idle indexing clones/hashes all completed meetings every three seconds; questions resync scoped records | Repeated scans even when unchanged | Dirty IDs/revisions, bounded incremental jobs and coalesced updates. |
| Query embedding and background embedding share one model mutex; vectors scanned exactly within scope | Contention and linear retrieval cost | Benchmark at realistic library sizes, prioritize interactive work; add ANN only when justified. |
| Whole-meeting fingerprint includes action/summary state | Task toggles invalidate and re-embed otherwise unchanged transcript chunks | Separate source revisions by content type while preserving stale-evidence protection. |
| Transcript maps all rows; top-level session/interim state reaches a large workspace | Long-meeting DOM/render cost | Profile before virtualizing; isolate subscriptions and preserve citation/focus behavior. |

Existing mitigations deserve preservation: AudioWorklet capture, chunked disk recording, shared level subscriptions, lazy dialogs/player/editor, memoized transcript rows, model work on blocking workers, and paused background indexing during live processing. No RSS, FPS or p95 benchmark was performed; the table identifies code-supported growth/contended work, not measured regressions.

Evidence: [main.rs](../apps/core-backend/src/main.rs), `Store`/`commit_live_turn`; [chat/mod.rs](../apps/core-backend/src/chat/mod.rs), `start`/`answer`; [chat/index.rs](../apps/core-backend/src/chat/index.rs), `fingerprint`/`retrieve`; [useMeetingSession.js](../apps/ui/src/hooks/useMeetingSession.js), [TranscriptView.jsx](../apps/ui/src/components/TranscriptView.jsx), [pcmCapture.js](../apps/ui/src/lib/pcmCapture.js).

### AI quality, latency, costs and failures

- **Chunking:** overlapping transcript windows and 1,100-byte slices are bounded and Unicode-safe, but byte splitting may separate a condition/negation from its claim. Multiple slices can share turn IDs. Build retrieval fixtures for qualifiers, long turns, exact names and code switching.
- **Embeddings:** pinned local E5 assets/checksums and keyword fallback are good privacy/availability choices. The ~487 MB first download/inference footprint needs explicit progress, cancellable/retryable setup and measurement. Failed indexing work is currently discarded by the sweep; surface actionable failure state.
- **Retrieval/context:** scoped FTS/cosine fusion, revision checks, user-only bounded history and no full-meeting chat serialization are strong. Twelve passages/~6 KB evidence cannot establish exhaustive three-month histories. Overview selection is heuristic, not a guaranteed balanced chronological comparison. Report coverage and use structured queries for exhaustive work.
- **Hallucination:** citation validation checks membership and marker consistency, not that a claim follows from the excerpt. Summary references are weaker than chat validation; derived summaries can become evidence. Add support/abstention evaluations and distinguish spoken facts, user notes and extraction candidates.
- **Confidence:** live/batch transcript `confidence` is assigned `1.0`; semantic similarity threshold `0.75` is explicitly not confidence. No calibrated decision/answer confidence was verified. Prefer attribution/provenance and review status to invented percentages.
- **Latency/retries:** chat has a 60-second deadline/two permits/one corrective response. Local summary timeout defaults to 360 seconds per attempt, relay AI to 180 seconds; fallbacks can add latency. Stop awaits processing before returning completion. Separate durable stop from background generation, bound total attempts and communicate stages honestly.
- **Tokens/cost:** chat has byte budgets and 2,000 answer tokens for Gemini; summary input omits middle data and lacks the same total budget/output cap in the local Gemini request. OpenAI budget handling exists, but comprehensive per-job tokens/cost across providers was not verified. Add content-free timings/usage and revision-based cache reuse.
- **Errors:** chat maps multiple provider failures into a generic Google sign-in/retry message even for other configured providers. Preserve structured offline/rate-limit/auth/timeout/cancel distinctions. Sanitize direct-provider errors before logging: some Gemini/Sarvam/CLI branches include clipped raw upstream text. A possible exposure channel is verified; no actual secret leak was observed.

Evidence: [chat/index.rs](../apps/core-backend/src/chat/index.rs), [chat/mod.rs](../apps/core-backend/src/chat/mod.rs), [embeddings.rs](../apps/core-backend/src/chat/embeddings.rs), [summarizer.rs](../apps/core-backend/src/summarizer.rs), [sarvam.rs](../apps/core-backend/src/sarvam.rs), [openai.rs](../apps/core-backend/src/openai.rs), [cloud relay](../apps/core-backend/src/bin/kesami-cloud-relay.rs).

### Privacy lifecycle and local access

Meeting JSON/Markdown are plaintext. Backend credentials/refresh tokens use `0600` files; Electron's saved backend connection uses safeStorage encryption. These are distinct protections. Add clear retention/export/backup controls and consider Keychain-backed provider/session secrets; meeting encryption should follow an explicit threat model and portability decision.

Meeting deletion removes canonical files, but chat messages contain copied answers/excerpts. Search cleanup waits for an idle index sweep, which pauses during recording/processing. Decide and expose whether deletion also purges derived copies/chat content; do not promise complete erasure from one delete operation. Interrupted `.in-progress` files and model `.download` files need deliberate recovery/cleanup rather than blind deletion.

Local core requests from native clients can be tokenless, and configured opaque `file/null` origins are permitted locally. Host/origin checks help against browser attacks, but account sign-in does not isolate the shared library or block every other local process. Adopt a desktop-scoped token if local application access control is part of the intended privacy model; design extension pairing compatibility explicitly.

Evidence: [security.rs](../apps/core-backend/src/security.rs), [settings.rs](../apps/core-backend/src/settings.rs), [connection.js](../apps/desktop/connection.js), [library.rs](../apps/core-backend/src/library.rs), [chat/mod.rs](../apps/core-backend/src/chat/mod.rs), [threads.rs](../apps/core-backend/src/chat/threads.rs).

## 4. Nice-to-have improvements

- Saved searches and a chronological person/project view once complete search and identity correction work.
- A concise pre-meeting recap of supported previous decisions and unresolved tasks; manually requested initially.
- Quick capture-health diagnostics and a local exportable report containing counts/error codes, never meeting content by default.
- Keyboard access to search/task filters and clearer scope breadcrumbs; retain existing accessible chat resizing, responsive layouts and light/dark contrast.
- Better recording disk-use estimates and optional retention reminders before automatic cleanup is considered.

These are downstream of reliability and factual memory. More integrations, autonomous agents, cloud sync, a vector service or a graph database are not justified by this audit.

## 5. Technical debt

- **Composition density:** `main.rs` is ~5,150 lines, connectors ~1,875, session hook ~990, workspace ~745 and settings ~900. Routing, lifecycle, billing/provider concerns and UI ownership concentrate in a few files. Extract cohesive services/adapters when touching those areas; retain contracts instead of a broad rewrite.
- **Transport maintenance:** core hand-parses HTTP/WS while the relay uses Hyper/tungstenite. Existing size/origin/token checks and tests are valuable. Consolidate protocol implementation only after proving framing/compatibility and a measurable maintenance benefit.
- **Flexible domain data:** action items, notes, sections and metadata use generic JSON while decisions are strings. That preserves compatibility but leaves weak identity/provenance/lifecycle contracts. Add typed, versioned records behind backward-compatible adapters.
- **Disabled/older systems:** Podcast code/data remain with routes/desktop bridges disabled; old workspace/presentation modules coexist with the active design workspace. Treat these as quarantined maintenance scope, not features to revive or data to delete.
- **UX breadth:** seven connectors, calendar creation and legacy license activation compete with the central capture/review/search workflow. Hide unconfigured capabilities progressively; defer new connector work unless users demonstrate demand.
- **Documentation drift:** `ARCHITECTURE.md` still describes Vite 5, unsandboxed main rendering and an absent connection bridge; current source has Vite 6, `sandbox: true` and a safeStorage-backed bridge. Root guide now distinguishes current facts from old design plans.
- **Release assurance:** root/UI have no declared lint/typecheck scripts. CI covers selected Node/integration suites and a Windows backend compile check; the macOS/Windows release workflow builds/publishes without invoking the complete gate, and Linux backend CI does not pin Node explicitly. Root package/make delegate outside this repository. Add targeted gates and packaged-platform smoke tests before publishing; compilation is not a release sign-off.
- **Relay accounting:** audio/AI daily counters live in the process ledger; restarts reset them and replicas would have independent counters. Optional OpenAI usage persistence is a separate mechanism. Keep one relay until durable/account-aware quota enforcement is needed; do not add infrastructure merely for elegance.

Evidence: [package.json](../package.json), [desktop package](../apps/desktop/package.json), [ci.yml](../.github/workflows/ci.yml), [release.yml](../.github/workflows/release.yml), [main.js](../apps/desktop/main.js), [preload.js](../apps/desktop/preload.js), [cloud relay](../apps/core-backend/src/bin/kesami-cloud-relay.rs), active imports in [App.jsx](../apps/ui/src/App.jsx).

## 6. Product risks

| Risk | Why it matters | Response |
| --- | --- | --- |
| Privacy promise exceeds processing/deletion reality | Local storage can be mistaken for local-only processing or complete erasure | Explain audio/text/video boundaries and derived-copy retention in desktop flows. Website policy already distinguishes local storage from cloud processing. |
| Incorrect speaker → incorrect commitment | Cloud-managed clients skip post-meeting batch diarization; extension observations can be absent | Mark provisional names, retain corrections and require supported ownership. |
| Broad historical question answered from sparse top-k | Customer complaints/decisions across three months need coverage and chronology | Structured scope/date/entity filtering plus coverage-aware retrieval; abstain when incomplete. |
| Lost edits undermine personal memory | A completed action or corrected decision is more authoritative than fresh extraction | Preserve durable human overrides and versioned fact history. |
| Provider/auth/network dependence at first use | No local STT path was verified in the current runtime; cloud mode requires sign-in | Define local capture-only behavior explicitly and make network readiness visible. |
| Shared library mistaken for account privacy | Accounts and billing do not establish meeting tenant isolation | Keep private single-workspace positioning; design isolation before multi-user hosting. |
| Platform validation/parity | Release config now includes macOS ARM64 and Windows x64, but the native system-audio helper is macOS-only; no Windows installer/capture flow was validated here | Validate loopback/display fallback and document Windows limitations. Intel macOS packaging is not configured. |
| Broad feature scope dilutes memory quality | Connectors/calendars/license/podcast legacy increase support surface | Prioritize repeated record → review → retrieve → follow-up value and measure usage. |

Provider retention, live payment/OAuth reliability, public relay availability and real-world transcription accuracy cannot be established from this repository audit. No production databases were queried.

## 7. Recommended architecture direction

Keep Electron + React + one local Rust service + the existing hosted provider relay. Keep recording/native ownership in Electron, feature state in focused hooks, shared networking in client utilities, and slow model/database work outside render/session locks. Current renderer sandboxing, trusted-frame IPC, navigation controls, canonical media paths, private credential writes, provider-verified billing and scoped RAG are useful foundations.

Evolve the storage layers incrementally:

1. **Canonical evidence:** stable meeting/turn IDs, locally stored source files, durable checkpoints, source-specific revisions and recoverable media.
2. **Durable user state:** task IDs/status, corrections, identity aliases and confirmed/superseded decisions. Preserve this independently of regenerated text/embeddings.
3. **Derived knowledge in local SQLite:** extracted facts with meeting/turn/timestamp/revision provenance; distinguish candidate/confirmed/disputed status. Add people/projects first, company associations when needed; commitments should represent supported obligations, not generic future-tense sentences.
4. **Rebuildable retrieval:** FTS/embedding projections over the above, incremental invalidation, bounded workers and measured cache/memory limits. A search rebuild must never erase user corrections or work state.
5. **Evidence-constrained answers:** structured queries for exhaustive lists/status, scoped retrieval for narrative questions, chronology/conflicts/coverage and support validation.
6. **Reviewed external actions:** preview → user confirmation → bounded/idempotent connector delivery → receipt. Keep drafts useful without requiring publishing.

Use relational links before a graph database. Introduce an ANN index, cloud sync or additional services only after measured scale or a specific collaboration problem justifies them. Treat jobs such as extraction and summary as resumable, cancellable Rust workflows rather than autonomous agents.

## 8. Recommended 30/60/90-day roadmap

Targets below are acceptance criteria to establish, not current measured results. Sequence assumes work begins after review and prioritization.

| Period | Deliverables | Completion gates |
| --- | --- | --- |
| Days 1–30: reliability and trust | Audio-only batch upload; truthful transmission/deletion messaging; persistence failure reporting and interrupted-session recovery; conditional summary writes preserving edits/task state; full-library transcript search/pagination; reviewed connector publishing | Synthetic screen-video bytes never reach batch upload; failed disk writes remain visible/recoverable; edit/delete during generation cannot be overwritten/recreated; transcript-only and >200-record search works through the active UI; captures survive restart reconciliation; external sends show a reviewable payload. |
| Days 31–60: useful memory | Stable action IDs/status/provenance and global unresolved view; decision provenance; bounded full-transcript extraction; people/project aliases with correction; incremental indexing; content-free timing/usage metrics | Regeneration preserves completed/manual tasks; unknown status stays unknown; middle-of-meeting and multilingual evidence remains retrievable; aliases can be corrected without losing sources; benchmarks report startup/RSS/render/retrieval p50/p95 on a named reference Mac. |
| Days 61–90: historical intelligence and release assurance | Person/project history; date-scoped commitments/complaints; conflicting/superseded decision handling; requested pre-meeting recap; evaluation dashboard and release gates | Evaluate the owner's five example questions on a labeled multi-month synthetic corpus; claims have usable evidence and coverage; unsupported questions abstain; exhaustive unresolved lists use structured queries; clean-machine packaged capture/replay/auth flow and approved live provider checks pass on supported macOS. |

Track durable capture completion, successful evidence navigation, action-state preservation, retrieval recall/support accuracy, abstention on unknowns, time to first useful meeting and repeat historical-query use. Choose numeric budgets after establishing a baseline; do not claim quality from fixture JSON/schema validity alone.

### Verification performed

| Check | Result / boundary |
| --- | --- |
| `npm run --prefix apps/ui build -- --outDir /tmp/kesami-audit-ui.3ucSUD` | Passed; temporary output kept the existing UI build untouched. |
| `npm run test:backend` | Passed; ignored model-download/disposable-database checks were not enabled. |
| `npm run test:cloud` | Passed: 19 relay tests, 1 ignored live/disposable DB test, plus 3 public-config tests. |
| Focused Node suites | Passed: 64 tests across desktop security, recorder lifecycle/paths, capture controller, chat, transcripts, plans/auth, colors, speaker suggestions and public release config. |
| `cargo build --manifest-path apps/core-backend/Cargo.toml` | Passed for the debug binary used by integration fixtures. |
| `node --test test/meeting-chat-integration.test.js test/live-echo.test.js test/live-speakers.test.js test/auth-flow.test.js` | Passed: 9 real-local-backend integration tests with synthetic data/mock providers. |
| `KESAMI_UI_DIST=/tmp/kesami-audit-ui.3ucSUD node_modules/.bin/electron test/ui-design/render.cjs` | Passed: sign-in/config/offline states, folders, tasks, transcript/replay, sources/follow-ups, responsive layout, themes/contrast and other fixture flows. Screenshots visually inspected for onboarding, home, summary and chat. |

The preferred agent-browser CLI was unavailable; the repository's native Electron harness supplied isolated render/interaction validation. Screenshots were generated in `/var/folders/55/h11y85gd2q9cbj9bkmmz6tth0000gn/T/kesami-render-v6hmDr`.

Not performed: production DB access, actual OAuth/payment transactions, public relay/deployment smoke tests, physical microphone/system-audio capture, packaged clean-machine testing, the complete release suite, full lint/typecheck for unconfigured desktop scripts, hardware performance benchmarking or semantic accuracy evaluation with live providers. Existing fixture passes do not resolve the source-derived defects/risk scenarios above.
