# Hyperframes Composition Brief: Kesami

Create the 22-second, 1920×1080 polished launch film specified in brag-plan.md. Output the editable composition in composition/, brag.mp4, a strong product poster brag.jpg baked into frame zero, and share-copy.txt. Voice is enabled by the explicit --voice invocation.

Product angle: a meeting ends but its useful details stay. The centerpiece is the working flow: live transcript → completed summary/decisions/actions → Ask AI answer with a source. Source files and claim grounding are listed in brag-plan.md. Use the current source's UI language and faithful source-derived layout; all meeting data is fictional. No customer data, secrets, private URLs, prices, speed statistics, release claims, or unverified integration claims.

Identity: #1c1c1e background, #232326 surfaces, #e0e0e0 text, #b0b0b6 secondary, #e8634e coral. Use the actual four-bar LogoMark, whose tile is #ec3013. Local Inter and DM Mono. Adapt UI text sizes for video readability. Keep text readable without motion or ornament. Use large app fragments and coherent shell continuity.

Scene contract: 0–4.5s “The meeting ends. / Keep the details.”; 4.5–10s live transcript; 10–18.5s completed brief and source-linked Ask AI; 18.5–22s Kesami and “Every meeting, remembered.” Narration generation may shift internal beats, within the total duration. Use the full storyboard as the source of truth.

Audio: locally generated Kokoro af_heart voiceover; bundled happy-beats-business-moves-vol-1 music. Duck the music to 0.13 during narration, smoothly return after it, fade the ending. Sparse motion-matched low-risk click and soft-impact SFX selected from the brag plugin's sfx-analysis.md. Use the bundled music-cues JSON as optional guidance. Final coral accent may land at 20.02s. Readability outranks beat snapping.

Audio-reactive: use hyperframes-creative/scripts/extract-audio-data.py to precompute music RMS/bands, then subtly vary coral edge illumination on the same seekable timeline. Keep all dependencies local after preparation. No waveform or equalizer decoration.

Implementation: follow the current hyperframes-core, animation, creative, keyframes, audio, and CLI skills read from the official Hyperframes repository. Single registered paused timeline, correctly timed clips and separate audio tracks, no render-time fetch/clock/random/input dependency. Animate inner wrappers, not timed clip lifecycle. Use local fonts and GSAP. Run hyperframes check, inspect snapshots, render locally using the user's authorized brag invocation, and verify MP4 dimensions, duration, audio, and frame-zero poster.
