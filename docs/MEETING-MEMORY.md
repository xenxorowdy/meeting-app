# Meeting Memory

Open **Ask Kesami** to ask about your completed meeting history. Folder scope and
optional exact entity-name/date filters constrain retrieval before ranking. Every
answer carries sources with a meeting title, date and excerpt; open a source to
return to its transcript. Missing evidence produces an explicit insufficient-
evidence response. Retrieval is bounded, so coverage is not an exhaustive audit.

New summaries also extract up to 40 useful, deduplicated people/company/topic/
project/date references, decisions and commitments in the existing provider call.
Each retained record requires valid stable transcript turn IDs and an exact quote;
names, owners and dates must occur in the referenced text or speaker labels. These
are model extractions, not human-confirmed decisions. Relative dates stay verbatim.
The answer prompt requires spoken evidence for decision/commitment claims.

Older transcripts remain searchable immediately. Their speaker labels, existing
topics and action records are indexed locally. Regenerate an older summary to add
the richer extracted company/commitment records; the library is not automatically
uploaded for an AI backfill. If automatic summarization is disabled, finishing a
meeting does not trigger memory extraction either. Generic unnamed speakers and
calendar invitees are not promoted to named attendees.

## Storage and lifecycle

- Canonical meeting JSON has additive `metadata.meetingMemory` with version,
  transcript fingerprint, extraction status and source-linked fact records.
- `.kesami-chat/search.sqlite` schema version 2 retains passages/FTS/vectors and
  adds `entities`, `meeting_entities` and `memory_facts`. Person, Company and Topic
  use typed normalized references; Decision/Commitment use facts; ActionItem uses
  the existing authoritative action list. Projects/dates are lightweight references.
- Old indices upgrade automatically and changed revisions rebuild locally. Edits
  to transcript text or speakers invalidate extracted facts; deletion prunes facts,
  entity links, passages and vectors. Saved chat excerpts retain existing behavior.
- Ranking combines keyword/BM25 and existing local E5 embeddings with a small
  recency boost and representation from multiple matching meetings. Keyword search
  remains available while embeddings are disabled, unavailable or loading.
- Unresolved task lists exclude explicitly completed items. Missing completion
  state is labeled unknown; a similar later task never implies completion. Summary
  regeneration preserves task IDs/completion and unmatched user tasks. Concurrent
  source changes/deletion reject a stale summary save.

Memory uses existing local paths and API security. Asking a question sends bounded
relevant excerpts to the configured AI provider. Summarizing uses the same provider
and privacy controls as before; local persistence does not mean offline AI.

## Validation

See `MEETING-MEMORY-PLAN.md` for the inspected architecture and initial plan.
Rust memory/chat tests cover validation, migration, reopening/pruning, scope,
recency, semantic fallback, provenance and task-state persistence. Node HTTP tests
exercise extraction through summary routes, company filtering, dated citations,
unresolved tasks and insufficient evidence. The native UI harness exercises
filter validation/application/reset alongside existing recording and citation flows.

Verified locally: `npm run test:backend` (198 core tests passed), 32 Node chat/
capture/recording/transcription/end-flow checks, the extended real HTTP chat test,
native Electron UI rendering, UI and optimized backend builds, `cargo check
--all-targets`, and production-target Clippy. The existing ignored model-download
and live-database tests were not enabled. All-target Clippy remains blocked by an
existing unchecked socket read in the summary test harness. The JavaScript apps
have no lint/typecheck configuration. Real provider quality and physical audio
capture were not exercised.
