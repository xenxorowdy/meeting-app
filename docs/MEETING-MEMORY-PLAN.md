# Meeting Memory implementation

## Architecture and storage

Reuse the canonical per-meeting JSON, existing local SQLite/FTS5/E5 passage index,
chat routes, saved threads, summary provider and source cards. No new dependencies,
cloud services or autonomous agents.

- Add versioned `metadata.meetingMemory`: transcript fingerprint, extraction
  status and facts with stable IDs, kind, label, verbatim evidence, source turn IDs,
  owner and explicitly stated date. Existing action items remain authoritative.
- Model Person/Company/Topic as normalized local entity references associated with
  meetings; Decision/Commitment as source-linked facts. Dates and project mentions
  are references, not new standalone business objects.
- Extend the existing summary's structured response; no second provider call.
  Invalid or unsupported records are discarded. Changing transcript/speakers
  invalidates extracted facts until regeneration.
- Upgrade the rebuildable search index to version 2 with entity/fact tables and
  meeting relationships. Backfill old libraries locally from transcript speakers,
  grounded summary sections and existing action items. Historical transcripts
  remain fully searchable without uploading the library for reprocessing.
- Retrieve within folder/meeting/entity/date scope using FTS and existing local
  embeddings, a bounded recency boost and meeting diversity. Missing embeddings
  retain exact search. Source dates are included in the evidence prompt.
- Answer unresolved task lists from authoritative recorded completion flags;
  unknown status is explicit. Never infer completion from a later similar task.

## Files

- `apps/core-backend/src/memory.rs` (new): facts, validation, derived entities,
  provenance and task state helpers.
- `apps/core-backend/src/{main,summarizer}.rs`: persist facts on summary; preserve
  matching existing action IDs/completion on regeneration.
- `apps/core-backend/src/chat/{index,mod,tests}.rs`: schema migration, memory
  passages, metadata scope, ranking, evidence and deterministic tasks.
- `apps/ui/src/components/{MeetingChatPanel,SourceChip}.jsx`,
  `components/design/DesignWorkspace.jsx`, `lib/chat.js`, `design.css`: Ask Kesami,
  compact entity/date filters and dated sources.
- Focused Rust, Node HTTP/helper and Electron UI tests; update agent context.

## Test cases and verification

Validate exact quotes, invalid turn indices, fabricated entity names, source edits,
old JSON compatibility, index migration/reopen/pruning, entity and date scope,
semantic-only and exact retrieval, recent ordering and multi-meeting sources.
Check completed/open/unknown tasks and preservation of user-edited task state.
Exercise real HTTP routes and rendered filters/citations, errors and empty results.
Run backend tests, chat/recording/transcription regressions, UI build and native
render harness. Run Rust lint/check; report pre-existing failures separately.
There is no root/UI TypeScript or JavaScript lint configuration; do not introduce
a toolchain solely to satisfy those command names.
