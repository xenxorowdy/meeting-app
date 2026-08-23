# Competitive Analysis & Roadmap

Krisp / Granola / Otter / Fathom vs. this app — Aug 2026.

## 1. Where we stand

| Built | Where |
|---|---|
| Bot-free mic + system capture, screen recording, replay | `apps/desktop/recorder.js` |
| Live STT — WhisperKit `large-v3-turbo` on ANE, auto language | `core-backend/src/stt.rs` |
| Indic / Hinglish batch pass — Sarvam Saaras v3 + diarization | `core-backend/src/sarvam.rs` |
| Summaries — Claude Code CLI, JSON schema, Gemini alt, heuristic fallback | `core-backend/src/summarizer.rs` |
| History + search, Markdown/PDF export, Free/Pro license | `core-backend/src/main.rs` |

**No live diarization** (`main.rs:594` — remote audio is one voice: `You` vs `Others`). Biggest visible gap.

## 2. What Krisp is

Three products; only one competes with us.

1. **Virtual-mic DSP** — CoreAudio/Windows driver, 800+ apps, >40 dB noise/echo removal, local. The real moat.
2. **Accent conversion** — speaker + listener side. Their BPO wedge. Don't copy.
3. **Bot-free note taker** — 17+ langs, live transcript, summaries, "Ask Krisp", CRM/PM integrations, mobile.

Pricing: Krisp $8 / $15 / custom. Granola $14 / $35. Fathom free tier.

## 3. Gaps, ranked

### Tier 0 — blocks selling

| Gap | Fix |
|---|---|
| Summaries need the `claude` CLI installed + logged in | Bundle a local LLM (Qwen3-4B / Gemma3-4B, llama.cpp or MLX); CLI = power-user path; BYO-key third |
| No live diarization | Sortformer v2-streaming on the system stream |
| Unsigned builds, no auto-update | Developer ID + notarization, EV cert, `electron-updater` |
| No consent UX | Recording indicator, per-meeting consent record, retention/auto-delete |

### Tier 1 — competitive

- Speaker **names** — local voiceprint enrollment (ECAPA-TDNN) + rename + "remember this voice"
- **Ask across meetings** — FTS5 + embeddings over the meeting store
- **Summary templates** (Granola "Recipes" — their most-cited feature); ours is hardcoded
- **Calendar** — auto-title, attendees → speaker names (loopback PKCE, no token shortcut)
- **Push to Slack / Notion / email** — pasted tokens first, OAuth later
- **Upload existing audio/video** — Sarvam batch already has this shape
- **Export breadth** — DOCX, SRT/VTT, JSON (today: Markdown + print-PDF)

### Tier 2 — moat

- **Virtual mic** — signed HAL plugin (macOS) + WDM/APO (Windows), DeepFilterNet3 on ANE (2.2 MB CoreML). ~1 quarter.
- **Grounded summaries with timestamp citations** — nobody in the category ships this; FRAME cuts hallucination up to 3/5 pts on QMSum. Cheap vs. marketing value.
- **MCP server over the meeting store** — Granola has it; we're already Claude-native.
- **Indic / Hinglish accuracy** — Saaras v3: 19.31% WER on IndicVoices, beats GPT-4o Transcribe, Gemini 3 Pro, Deepgram Nova3, Scribe v2. Whisper mistranslates Hindi. **Already wired. Nobody else has it.**

## 4. To market it

1. **Pick a wedge**, not the category:
   - *Regulated work* (therapists, lawyers, clinicians) — pays $0.99/session–$30/mo, buys on privacy.
   - *India* — Hinglish/Tamil/Telugu meetings where Otter and Granola visibly fail.
2. **Verifiable privacy claim** — publish a network-egress audit ("unplug the ethernet, it still works"). No competitor can demo that. 2026 lawsuits hit Otter, Granola, Fireflies over consent and training on user content.
3. **Published WER benchmark** vs Otter/Granola/Fathom on Svarah + IndicVoices. Reproducible numbers are a wedge by themselves.
4. **Price on zero COGS** — local inference has no per-minute cost. One-time $79–99, or $5/mo, undercuts $8–15 structurally.
5. **Landing page** — 60s demo, comparison table, privacy page, changelog.

## 5. Sequence

1. Replace the Claude-CLI dependency with a bundled local model.
2. Streaming diarization + local speaker enrollment → real names.
3. Consent UX, retention, signing/notarization/auto-update.
4. Templates, Ask-across-meetings, upload, richer export.
5. Pick the wedge; publish the benchmark and egress audit; ship the virtual mic against it.

## 6. Research

- Streaming diarization — NVIDIA Sortformer v2-streaming (560 ms lookahead, 12.4 ms latency, DER 7.0% ALI); pyannote Live-1 (sub-300 ms, cloud); Picovoice Falcon (221× less compute); benchmark arXiv 2509.26177
- Hallucination — FRAME arXiv 2509.15901; "Reasoning or Not?" arXiv 2507.02145
- Code-switching ASR — arXiv 2507.07741; HiACC Hinglish corpus
- Denoise — DeepFilterNet3 (CoreML/ANE) vs RNNoise
