# Meeting commitments implementation plan

Inspected 2026-10-06: canonical meeting JSON, memory facts/revisions, summary generation, meeting PATCH routes, React MeetingDetail and Electron interaction tests. Preserve the existing dirty checkout.

## Architecture and scope

- Add a conservative local English detector over final transcript sentences. Recognize personal promises with concrete action verbs; classify suggestions, conditional discussion, reported promises by another person, and unclear language separately. Future tense alone is insufficient. No additional provider calls, credentials, dependencies, or external actions.
- Reuse stable turn IDs, transcript fingerprints, source-validated memory entity labels, and existing action items. Retain explicit date wording (including relative dates); do not infer a calendar date or company identity. Speaker labels remain provisional until reviewed.
- Persist additive `metadata.meetingCommitments` version 1: transcript revision, detection version, candidates, classification, person/speaker, action, explicit due-date text, references, confidence/reason, exact quote/turn/timestamp, review status, and confirmed task link. No SQLite schema change is needed: confirmed tasks already participate in retrieval.
- Detect on meeting completion and summary regeneration; support explicit local detection for existing meetings. Reading/reviewing never uploads historical transcripts. Limit candidates and input size; expose partial coverage.
- Review is a separate mutation: confirm a selected person/action and add one local task, or dismiss. Require the expected transcript revision, reject stale/live sources and unsupported confirmation categories, preserve decisions across repeat detection, and make repeat confirmation idempotent. User-created task IDs, completion, and provenance survive summary regeneration.
- Add a finished-meeting Commitments tab with loading/empty/error/retry states, exact quotes and transcript jumps. Show suggestions separately and require adoption of a named owner; discussion/unclear statements cannot be confirmed as promises. No external connector calls.

## Files

- New `apps/core-backend/src/commitments.rs`; extend `main.rs` lifecycle, atomic storage/review routes; adjust `memory.rs` task merge to preserve reviewed tasks and source fields.
- New `apps/ui/src/components/MeetingCommitments.jsx`; integrate in `design/MeetingDetail.jsx`, extend shared design CSS.
- New isolated real-backend `test/meeting-commitments-integration.test.js`; extend `test/ui-design/fixture.jsx` and `render.cjs`; document limits in this plan/AGENTS.

Inspection during implementation found that completed-session note saves and folder moves could replace a reviewed record with an older whole-meeting snapshot. Extend the atomic update helper to completed note writes and `workspace.rs` folder moves, and refresh the completed-session mirror after commitment writes. Add HTTP regressions for note/folder edits preserving reviews. Preserve the existing live capture paths.

## Tests and validation

- Explicit examples, named speakers, reported other-person promises, suggestions, questions, hypothetical/conditional/modal/negated speech, quoted/example text, future facts, ambiguous ownership, non-English abstention, explicit dates vs inferred dates, Unicode, and source grounding.
- Persistence across reload/re-detection, confirm/dismiss, owner/action review, duplicate confirmation, stale revision, live source rejection, invalid payload, summary regeneration/completion preservation, bounded coverage, and task source navigation.
- Rust backend tests/check/production clippy; isolated Node HTTP test and relevant recording/transcription/chat regressions; UI tests/build and Electron render/interaction flow in both themes. Root/UI have no lint/typecheck script. Do not run live databases or upload user data.

## Implemented behavior and limits

Open a finished meeting → **Commitments**. Existing transcripts use **Detect commitments** without AI calls; newly finished meetings are detected even when auto-summarize is off. Review a promise, edit its person/action, then **Confirm & add action**, or dismiss it. Suggestions require an explicitly reviewed owner; unclear/discussion records cannot be confirmed. A confirmation authorizes only a local task, not an external action. Source buttons open the original transcript turn; reviewed tasks also retain source references in historical search.

The detector uses explicit English cues/concrete action verbs, not a new LLM classifier. It favors precision and can miss nuanced or multilingual promises. Surrounding conditional/quoted utterances are treated conservatively. Company/project references reuse source-supported memory entity labels, so labels absent from older summaries are not guessed. Common explicit dates remain literal text (including “tomorrow”); date extraction is not comprehensive or a calendar scheduler. High/medium/low describe wording/attribution strength, not calibrated probabilities. Scanning caps at 2 MB and 100 candidates, skips sentences over 1 KB, and marks partial coverage. Reviewed tasks survive source edits, while candidate evidence requires re-detection.

Validated 2026-10-06:

- `npm run test:backend`: 302 passed, 3 ignored (including the existing model/download/live-DB boundaries).
- `npm run test:commitments`: 7 detector/review unit tests with numerous false-positive cases, plus a real local HTTP test for concurrent confirmation/note/folder writes, reload, dismissal, stale sources, completion/regeneration, and automatic detection with summaries disabled.
- `npm run test:ui`: 45 passed; `npm run build:ui` passed. Main bundle grew from 218.67 KB to 226.42 KB; shared bundle unchanged at 294.97 KB.
- Real-Rust/mock-provider chat and synthetic audio/recorder regressions: 11 passed; separate device-source/recorder suite: 16 passed.
- Electron capture harness: 10 scenarios passed. Full UI harness passed detection/errors/retry, owner review, confirmation/dismissal, saved tasks and transcript navigation in light/dark themes, alongside existing chat/recording/replay checks. Screenshots inspected.
- `cargo check --all-targets`, production-bin `cargo clippy`, Rust release build, and `git diff --check` passed. Clippy reports existing warnings; no UI lint/typecheck scripts are configured.
- Restarted the inactive local release backend with aligned desktop storage roots and cloud relay disabled; localhost backend/UI health and the new route verified. No real meetings were edited during validation. Physical audio devices, live OAuth/payments, semantic recall across arbitrary language, and release packaging were not validated by these synthetic checks.
