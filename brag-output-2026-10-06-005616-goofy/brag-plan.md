# Kesami: your memory has left the meeting

## Planning rubric
1. Kesami captures meetings without inviting a bot, stores each in a local folder, transcribes multiple languages, and answers questions with source context.
2. Comic premise: your memory is on lunch break; your meeting files are better organized than you.
3. Visual hook: a goofy orange robot attempts to crash a private meeting, gets a NOT INVITED stamp, and recoils.
4. Source-based UI: expanded recording widget, meeting-language settings, folder contents, saved-meeting transcript and Ask AI.
5. Shortest satisfying version: 24 seconds, six scenes.
6. Tone: playful default with chaotic physical comedy; fast elastic entrances followed by readable holds.
7. Audio: bouncy instrumental and motion-matched soft pops. Voice enabled after the user requested it. Local Kokoro af_heart, energetic English delivery.
8. Caption: My brain left the meeting. Kesami stayed: bot-free capture, a floating widget, multilingual transcripts, local folders, and answers from past meetings.
9. Flow: record through the widget -> transcribe and save -> ask past meetings and see a source.

## Visual identity
1920x1080, 30fps, 24s. White panels; canvas rgba(255, 94, 0, 0.1) over white; #FF5E00 accent; #202124 text; #A63D00 accessible small accent text. Inter and DM Mono remain local.
Fictional meeting data. UI views are editorial recreations based on current source, not live recordings. Privacy claims limited to bot-free capture and local files; provider processing can be external.

## Storyboard
- 0-3.8: Who invited the bot? No bot invited. Robot with googly eyes arrives, stamp lands, robot flinches. Supporting Bot-free capture. Local meeting files. Settled hook holds over 2s.
- 3.8-7.8: Tiny widget. Big energy. Pill springs into recording controls; transcript switches to Ask Kesami. PAUSE FOR SNACKS sticker. Real control labels and mic/audio remain visible.
- 7.8-11.8: Your meeting has range. Show all 11 meeting languages, auto-detection and Hinglish mode. YES, HINGLISH TOO. Short label pops; settings remain readable.
- 11.8-15.8: Meetings, meet your folders. File browser: recording.webm, transcript.md, summary.md, meeting.json. MY FILES HAVE THEIR LIFE TOGETHER. Rows arrive sequentially; full set holds 2s.
- 15.8-21.2: Brain on lunch break? Revisit saved transcript, click Ask AI, show question What did we decide last week? Answer and source appear. Caption changes to It kept the receipts. All meetings scope and source timestamp visible.
- 21.2-24: Kesami. Your brain's backup dancer. Logo does a little wiggle, then settles. Bot-free. Local files. Actual receipts.
Transitions: quick slide/tilt exits and elastic entrances; no flashing text or strobing.

## Music cue guidance
Happy Beats Business Moves Vol1 by ende.app, bundled; 120.19 BPM. Beat grid: 4.02, 8.02, 12.02, 12.52, 13.01, 13.51, 17.02, 18.52, 23.02. Strong locks: click at17.02, answer at18.52. File rows 12.02/12.52/13.01/13.51. Reading holds take precedence. Moderate sparse SFX synchronized to robot stamp, widget expansion, file rows, click and logo. Fade music over final second. Music-derived orange edge warmth; no waveform decoration.

## Source grounding
README.md (bot-free, local library); apps/ui/src/components/StatusWidget.jsx (controls/transcript/Ask); SettingsModal.jsx (11 language choices and codemix); MeetingChatPanel.jsx and design/DesignWorkspace.jsx (meeting scopes and sources); components/brand/Logo.jsx (brand mark). Current files inspected; no application files changed.

## Voiceover
- 0.15s: A meeting bot? Sorry. Private party.
- 4.05s: Tiny widget. Record, pause, ask away.
- 8.1s: English, Hindi, Tamil. Even Hinglish.
- 12.05s: Your meetings have folders. Fancy.
- 16.05s: Forgot last week’s decision? Ask your meetings. Receipts included.
- 21.5s: Your brain’s backup dancer.
Music ducks and is spectrally carved around every narration clip.

## Voice revision
User rejected the first voice. Replace af_heart1.08 with bf_emma1.0, warm conversational delivery and fuller sentences. Visuals and24s duration retained. Every new clip fits its scene. Recompute music carve for the new narration. Final revised file: brag-voice-v2.mp4.

## Audio revision v3
User wants conversational delivery, rather than a scripted read, and faster background music. am_fenrir1.05 uses short, spoken phrases. Happy Beats begins at original8.02s and is sped up1.25x with pitch preserved:120.19 to150.24BPM. Bed volume0.42 replaces0.14; music carve strength0.35 replaces0.8 so the music remains present. Visual scenes and reading holds retained; audio-reactive data regenerated. Revised export:brag-audio-v3.mp4. Earlier exports preserved.
