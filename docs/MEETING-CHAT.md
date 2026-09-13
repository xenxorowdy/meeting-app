# Ask Alpha

Open **Library** to chat with selected meetings, an entire folder, or all completed meetings. Use **Ask meeting** in the toolbar for the currently open meeting. Conversations are saved locally and restored when returning to that scope. Choosing another scope preserves the previous conversation. Use the conversation menu to reopen older threads.

Answers include expandable **Sources** with excerpts and transcript timestamps. Opening a source loads its meeting even when it is outside the currently loaded library page, highlights the transcript, or seeks the recording. Edited/deleted source passages are marked unavailable until you ask again. Enter sends a question; Shift+Enter adds a line. Cancel stops the pending answer and returns the question to the composer; Retry reuses the request ID after a failed submission.

Answers display compact source chips with timestamps or meeting titles. Hover or focus a chip to preview the evidence, then click to open the passage. Copying an answer produces clean text followed by a readable source list. The backend's validated numeric citation contract is unchanged.

Drag the meeting chat's left divider to resize it. A focused divider also supports Left/Right arrows, Home/End for minimum/maximum width, and Enter or double-click to reset. The panel retains its chosen width while opening and closing in the same view, and fits smaller windows automatically.

## Questions while recording

**Ask AI** in the current meeting stays available during recording and pauses. Each question uses a snapshot of finalized transcript turns and typed notes available when it is sent. Recording continues while the answer is generated. Answers show the captured transcript time; send another question to include newer speech. Batch transcription has no live transcript, so questions about speech must wait until that transcript arrives after recording.

Live meetings are included only when explicitly selected. All-meetings and folder searches continue to use completed meetings. Live retrieval uses a temporary keyword index on a worker, without updating the persistent search index or running embedding inference. Requests for live action items use the captured speech rather than unfinished summary fields.

Live citations use an opaque `sourceRevision` value encoding transcript/note prefix lengths and a content hash. Appending speech or notes, and completing the meeting, preserve these citations; edits, deletions, and post-meeting transcript replacement invalidate changed evidence. Existing completed-meeting revisions and meeting files keep their format. Chat responses add `coverage.live` and `coverage.capturedThroughMs` to identify the snapshot.

## How retrieval works

The Rust backend indexes bounded passages in local SQLite FTS5. It combines keyword matches with cosine similarity from local multilingual E5 embeddings, fuses the rankings, and selects at most 12 passages. Evidence is capped at 6,000 serialized UTF-8 bytes, with up to 1,500 bytes of recent user context. The generation prompt has an 8,000-byte ceiling, reserving 2,000 bytes/tokens for its fixed instructions and schema. These byte limits conservatively bound token usage. An over-budget request fails explicitly rather than sending full meetings.

Only selected excerpts, their source labels, the question, and bounded user conversation context reach the configured Gemini or Claude answer provider. Meeting audio, whole library records, and old assistant answers are not chat context. Sources are revision-checked before dispatch and again before returning an answer. Numeric citations are checked against the evidence packet; this checks provenance, not the truth of every generated claim.

The Claude chat invocation disables built-in tools, MCP servers, and skills. Its provider process is terminated when the request is cancelled or times out.

The existing meeting summarizer retains its separate behavior. The chat retrieval change does not alter what the summarizer sends when generating meeting summaries.

“List every action item” reads recorded structured action items directly, without a model call, and offers pages of 100. Completion is unknown unless explicitly recorded. This cannot establish that every spoken task was captured in those records. Comparisons and overviews show coverage and may require a narrower scope when evidence exceeds the passage budget.

## Local model and files

The first backend start downloads approximately **487 MB** of public multilingual E5 model/tokenizer assets. Model inference runs locally on one ONNX thread. Keyword search remains available during download or if setup fails. Background indexing pauses while the meeting session is active. New or edited meetings become keyword-searchable on demand; semantic embeddings are filled in bounded background batches.

Model: `intfloat/multilingual-e5-small`, MIT license, pinned revision `614241f622f53c4eeff9890bdc4f31cfecc418b3`, 384 dimensions. The ONNX and tokenizer assets are SHA-256 verified. Small configuration files are fetched from the same immutable revision and checked for expected size. Ordinary passages fit the tokenizer limit; oversized inputs are embedded in bounded windows and pooled without dropping text. [Model repository](https://huggingface.co/intfloat/multilingual-e5-small/tree/614241f622f53c4eeff9890bdc4f31cfecc418b3)

Under the resolved meeting library:

```text
.alpha-chat/
  search.sqlite       # Derived passages and vectors; can be rebuilt
  threads.sqlite      # User conversations; preserve this file
  models/<revision>/  # Verified public model cache
```

SQLite may create adjacent journal files. The containing directory is owner-only on Unix, as are the databases. No meeting-storage migration is performed. Do not delete `.alpha-chat` as a way to rebuild search: it also contains conversations. Search reconciliation repairs changed/deleted records automatically, including after restart. A failed model download can be retried by restarting the backend when online; partial assets are never used.

Set `ALPHA_CHAT_EMBEDDINGS=off` when intentionally running keyword-only search. The UI reports the active search mode and remaining embedding count. No cloud embedding fallback is used.

## Verification

```bash
npm run test:backend
npm run test:ui
npm run test:chat
npm run build:ui

# Explicit public-model download/inference smoke test, cached under the temp directory:
cargo test --manifest-path apps/core-backend/Cargo.toml local_multilingual_embedding_smoke -- --ignored --nocapture
```

The HTTP test starts an isolated Rust server with 205 synthetic meetings and a fake Claude executable. It captures the provider input, tests request idempotency, follows up on a question, paginates 105 action items, cancels a request, and verifies deleted citations become unavailable. It does not call a paid provider or touch the normal meeting library.

The local-model smoke test checks English paraphrase ranking, Hindi ranking, dimensions, and semantic-only passage retrieval. This is an initial correctness check, not a broad multilingual quality benchmark. The initial semantic similarity gate is 0.75 and still needs corpus-specific evaluation. Full-library vector search currently scans the scoped vectors; large-library latency/RSS benchmarks, other desktop platforms, and live Electron interaction remain release-validation work. Token streaming, model-driven query rewriting, and exhaustive transcript-wide extraction remain future work.
