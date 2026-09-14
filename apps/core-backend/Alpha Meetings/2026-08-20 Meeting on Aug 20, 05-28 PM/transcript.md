# Meeting on Aug 20, 05:28 PM — transcript

2026-08-20 17:28 · 53 seconds · 14 turns

**[00:00] You:** Welcome everyone! Thanks for joining today’s sync on the alpha release.

**[00:04] Sarah Chen (Lead PM):** Happy to be here! The response to the bot-free architecture has been outstanding across our initial test users.

**[00:09] David Miller (Head of Eng):** The native audio capture layer is operating at under 2.5% CPU overhead on both macOS and Windows builds.

**[00:13] You:** That satisfies our performance requirement. What is the current status of on-device WhisperKit integration?

**[00:18] David Miller (Head of Eng):** WhisperKit runs directly on the Apple Neural Engine. Zero cloud data transmission for speech-to-text.

**[00:22] Sarah Chen (Lead PM):** And for summaries, we support Claude 3.5 Sonnet out of the box, with local Ollama for air-gapped corporate deployments.

**[00:27] You:** Let us confirm the launch checklist and make sure the action items are assigned with clear deadlines.

**[00:31] Sarah Chen (Lead PM):** I will coordinate the beta onboarding documentation and sample templates by Tuesday.

**[00:36] David Miller (Head of Eng):** I will wrap up the final WASAPI loopback device change listener and notarization steps.

**[00:40] You:** Excellent progress everyone. Let us wrap up and get these notes distributed.

**[00:45] You:** Welcome everyone! Thanks for joining today’s sync on the alpha release.

**[00:49] Sarah Chen (Lead PM):** Happy to be here! The response to the bot-free architecture has been outstanding across our initial test users.

**[00:54] David Miller (Head of Eng):** The native audio capture layer is operating at under 2.5% CPU overhead on both macOS and Windows builds.

**[00:58] You:** That satisfies our performance requirement. What is the current status of on-device WhisperKit integration?

