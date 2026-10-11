# Brag Plan: Kesami

## Angle and planning rubric
1. Product: Kesami, a bot-free desktop meeting assistant.
2. Strongest source line: “Every meeting, remembered.”
3. Privacy hook: “Your meeting.” / “No bot invited.”
4. Product material: the four-bar logo, floating recording widget, multilingual-transcription settings, local storage filenames, saved transcript, and Ask AI with meeting-history scope and dated citations.
5. Duration: 29 seconds, 1920×1080, 30fps. The extra four seconds are for the user-requested multilingual-transcription scene; preserve the widget, folder and history reading holds.
6. Tone: polished, white panels, orange accents, generous spacing and restrained motion.
7. Audio: opt-in Kokoro narration, quiet music, an Ask AI click and a soft logo accent.
8. Share caption: see share-copy.txt; specific to bot-free capture, the widget, local folders and previous-meeting questions.
9. Flow: record and ask through the widget → save a meeting folder → revisit a prior meeting → ask across history → inspect the source.

## Visual identity
Accent #FF5E00; background-color: rgba(255, 94, 0, 0.1) over white. Main panels and the hook text card are white. Text #202124; secondary #626369; borders #d8d8d4. Small orange text #A63D00 for contrast. Local Inter and DM Mono. Preserve the source logo geometry with the explicitly requested orange tile.

## Storyboard

### Privacy — 0–4.5s
“Your meeting.” then “No bot invited.” The source logo and a local-files card show “Meeting files” / “On your device.” Support: “Bot-free capture. Local meeting files.” Line-by-line entrance and readable hold.
Voice: “Your conversations deserve privacy. No bots invited.” Starts 0.2s, ends 4.093s.

### Floating widget — 4.5–9.5s
Headline: “Always within reach.” A Recording / 03:42 pill with Ask and Stop expands into the light widget. Show Product sync, recording status, transcript and Ask Kesami tabs, a fictional live turn, Mic on, Audio on, Pause and Stop controls. Switch to Ask Kesami and show “Ask about your meeting” with “Next steps.” Feature labels: “Pause. Resume. Stop.” / “Mic + meeting audio.” / “Live transcript. Ask Kesami.”
Motion: pill settles, expanded panel enters at 5.4s, transcript holds, Ask view enters at 7s, exit at 9.25s.
Voice: “Control recording and ask questions from the floating widget.” Starts 4.95s, ends 8.645s.

### Multilingual transcription — 9.5–13.5s
Headline: “Transcribe in your language.” Show the app’s Meeting language selector with Detect automatically and all 11 configured languages: English (India), Hindi, Bengali, Gujarati, Kannada, Malayalam, Marathi, Punjabi, Tamil, Telugu and Urdu. Transcript style selects “Transcribe in the spoken language”; the other visible choices include code-mixed Hinglish and translation to English. These are app transcription settings. The film’s narration stays in English.
Motion: settings panel enters at 9.5s, settles by 10.05s, holds until 13.2s.
Voice: “Transcribe English, Hindi, Tamil, or Hinglish.” Starts 9.75s, ends 12.873s.

### Local folders — 13.5–18s
Headline: “A folder for every meeting.” Three fictional dated folders; Product sync contains recording.webm, transcript.md, summary.md and meeting.json. “Saved on your device.” File rows enter at 14.25, 14.55, 14.85 and 15.15s and hold until 17.7s.
Voice: “Every meeting has a folder on your device.” Starts 14s, ends 16.639s.

### Previous meetings — 18–25.5s
Headline: “Ask your past meetings.” Open Product sync from September 25 with a saved transcript. Ask AI uses All meetings scope and asks “What did we decide last week?” The answer is “Start with a small onboarding pilot.” Its source card names Product sync, Sep 25, at 00:18 and quotes the saved transcript. Headline becomes “Answers with their source.”
Motion: transcript holds throughout; Ask click at 20.15s, answer at 20.9s, source at 21.3s, ending hold to 25.48s.
Voice: “Ask your past meetings. Find decisions, with their sources.” Starts 18.6s, ends 22.317s.

### Brand — 25.5–29s
Source logo and Kesami wordmark. “Every meeting, remembered.” Support: “Floating widget. Local folders. Past-meeting answers.” Rule resolves with a soft brand accent at 27.02s, then the frame holds.
Voice: “Every meeting, remembered.” Starts 25.95s, ends 27.699s.

Duration sum: 4.5 + 5 + 4 + 4.5 + 7.5 + 3.5 = 29 seconds. Wrapper overlaps support transitions without extending the total runtime.

## Narration and mix
Six local Kokoro af_heart clips generated through Hyperframes. Feature-scene synthesis speed 0.92 and latest Studio playback rate 0.97; outro synthesis speed 0.85 and playback rate 1. Exact measured durations are in voice-timings.json. Each spoken clip finishes before its scene exits; short silence tails prevent slow-playback media truncation. The earlier complete WAV remains preserved.
Music: bundled Happy Beats / Business Moves Vol. 1 by ende.app, under speech with an authored gain envelope and a voiceover carve against all six clips. SFX: low-risk Kenney click_003 and impactSoft_medium_001. Music-preset cue guidance informed the original edit; the final rule is a story-timed brand accent. Pre-extracted music-band data gently drives the orange edge light on the seek-safe registered timeline.

## Current source grounding
- README.md and docs/HOW-KESAMI-WORKS.md: bot-free capture, a visible local folder per meeting, actual artifact filenames and the external processing boundary.
- apps/ui/src/components/StatusWidget.jsx: recording pill, expand/collapse, live transcript, current-meeting Ask Kesami, microphone and meeting-audio controls, pause/resume and stop.
- apps/ui/src/design.css and apps/desktop/widget.js: rounded widget structure and floating desktop window behavior.
- SettingsModal.jsx and sarvam_live.rs: 11 explicit meeting-language choices, automatic detection, spoken-language transcription, code-mixed Hinglish and English transcript translation.
- SignInView.jsx: recordings and meeting library stay on the computer.
- DesignWorkspace.jsx and MeetingChatPanel.jsx: questions across meeting history and source-linked answers.
- MeetingDetail.jsx and Logo.jsx: saved transcript, closing tagline and source brand mark.

All titles, dates, turns, replies and widget timer values are fictional demo content. The views are source-grounded editorial recreations. Processing waits are compressed without a performance claim. Privacy refers to bot-free capture and local file storage; the app can use external AI processing. Do not claim all processing is offline, zero data sharing, or unverified encryption. Widget questions use the current meeting; the desktop Ask AI scene uses meeting history.
