# Brag Plan: Kesami

## What is this app?
Kesami is a bot-free desktop meeting assistant with live transcription, structured meeting briefs, and source-linked Ask AI answers.

## The angle
The meeting ends; its useful details stay. Show the working journey from conversation to transcript to decisions and next steps. A quiet, confident product film rather than a feature inventory.

## Planning rubric
1. App: a desktop meeting assistant that captures conversations and makes them useful afterward.
2. Strongest project line: “Every meeting, remembered.” (`MeetingDetail.jsx`).
3. Visual hook: coral voice bars become ordered transcript turns and then a meeting brief.
4. Actual UI: meeting detail, Transcript / Summary / Recording tabs, Summary / Decisions / Actions / Email tabs, and Ask AI's source card.
5. Shortest satisfying cut: 22 seconds, including narration and a held outro.
6. Tone: polished; warm desktop product film with precise UI motion.
7. Audio: conversational Kokoro narration, understated business-music bed, three quiet UI/reveal accents.
8. Caption: “Built Kesami: a bot-free meeting assistant that turns conversations into transcripts, decisions, and next steps. Every meeting, remembered.”
9. User flow: record a conversation → read transcript and summary → ask about a decision and see its source.

## Hook
“The meeting ends.” followed by “Keep the details.” Two generous lines, a small coral voice mark, and a recording control settling into a completed state.

## Key moments
- Live transcript turns with You / Speaker 1 / Speaker 2, adapted from the actual meeting detail view.
- The same fictional meeting becomes a Summary with Decisions and Actions.
- Ask AI answers a specific question and points back to the transcript.

## Outro
Kesami. “Every meeting, remembered.”

## User flow worth showing
Capture → transcript → structured brief → source-linked question. UI is a faithful editorial recreation from current source. All meeting contents are fictional demo stand-ins, not recorded users or customer data. Processing and response waits are compressed for the edit; no performance claim is made.

## Tone
- Preset: polished.
- Creative direction: conversation becomes clarity.
- Interpretation: oversized readable type, warm dark surfaces, restrained coral accents, deliberate camera moves, and longer settled holds.

## Format: landscape — 1920x1080
## Duration: 22 seconds

## Visual identity
- Background: #1c1c1e.
- Elevated surface: #232326; line: #45454c.
- Accent: #e8634e; source logo tile: #ec3013.
- Text: #e0e0e0; secondary: #b0b0b6.
- Display/body: local Inter, matching the source app's sans-serif identity.
- Metadata: local DM Mono.
- Strongest visual: the source LogoMark's four coral/white voice bars plus the working meeting detail surface.

## Audio direction
- Role: a warm bed beneath close, natural narration.
- Music: happy-beats-business-moves-vol-1-by-ende-dot-app.mp3.
- Treatment: fade in, duck to 0.13 during voice, return gently after narration, fade out over the last second.
- Audio-reactive treatment: subtle music-driven coral edge illumination; no audio visualizer decoration.
- SFX: low-risk clicks for the simulated stop/tab actions, one warm soft impact for the final logo.
- Restraint: no sound should compete with speech; no dense typing or repeated high-frequency accents.

## Music cue guidance
Bundled cue preset read: assets/music/cues/happy-beats-business-moves-vol-1-by-ende-dot-app.music-cues.md. Approximate tempo: 120.19 BPM. Strong logo lock at 20.02s; nearby small UI reveals may use 7.02 / 8.02 / 9.02s. Reading time takes precedence, with long holds after sequential turns.

## Storyboard

### Scene 1 — Keep the details — 0–4.5s
Hook at left. A large source voice mark and a simple recording control at right. Recording settles to a completed state as the first line lands. Second line enters fast and holds.
Sequential/interaction: the two hook lines arrive in order; simulated stop button press.
Audio intent: a warm opening beneath the first narration sentence; one quiet click.
Transition: confident slide into the working app.

### Scene 2 — Follow the conversation — 4.5–10s
Kesami meeting detail with a fictional “Product sync.” Transcript tab active. Three speaker turns arrive one by one: the team chooses a pilot, confirms its scope, and assigns the checklist. Recording HUD uses actual product language. Primary headline: “Follow the conversation.”
Sequential/interaction: turn-by-turn reveals around 6.03 / 7.02 / 8.02; then hold the complete transcript.
Audio intent: gentle rhythm, no extra sound on every word.
Transition: match the same app shell into its completed state.

### Scene 3 — Find the next step — 10–18.5s
The same meeting opens Summary. A concise summary, a decision, and an assigned action appear. Simulate selecting Ask AI. A panel asks “What did we decide?” and answers with a source card referencing the fictional transcript.
Sequential/interaction: brief content enters, Ask AI click, then answer and source reveal; full response holds at least 2 seconds.
Audio intent: low music with conversational narration and one quiet UI click.
Transition: smooth move to the final brand lockup.

### Scene 4 — Every meeting, remembered — 18.5–22s
Large source logo, Kesami wordmark, and the source tagline. Coral rule settles at 20.02s. Hold the final frame through the end.
Sequential/interaction: logo and tagline resolve in order.
Audio intent: narration closes; one soft warm logo accent; music fades out.

**Duration sum:** 4.5 + 5.5 + 8.5 + 3.5 = 22s.

## Voiceover script
The meeting ends. The details don't have to disappear. Meet Kesami. Follow the conversation as it happens. Turn the transcript into a summary, decisions, and action items. Ask a question when you need context. Every meeting, remembered.

Generate locally with Hyperframes Kokoro, voice af_heart. Measure the WAV and adapt the cut within 22 seconds; shorten the script if it exceeds 25 seconds.

## Claim sources
- README.md: standalone bot-free desktop assistant, transcript stream, summary editor, decisions, action items.
- apps/ui/src/components/design/MeetingDetail.jsx: Every meeting, remembered; Transcript, Summary, Recording, Export brief, Ask AI.
- apps/ui/src/components/SummaryEditor.jsx: Summary, Decisions, Actions, Email.
- apps/ui/src/components/MeetingChatPanel.jsx: questions about decisions/next steps, answers link to their source.
- apps/ui/src/components/brand/Logo.jsx and apps/ui/src/design.css: brand geometry and palette.
