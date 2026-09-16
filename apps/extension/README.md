# Alpha Meeting Names (browser extension)

The audio pipeline can tell voices apart, but it cannot know their names. The meeting's own
web client already knows them — this extension reads the participant list and the speaking
indicator out of Google Meet or Zoom and posts them to the Alpha backend running on the same
machine, so the transcript says **Aditi Sharma** where it would otherwise say **Others** or
**Speaker 2**.

Nothing leaves the machine: the only network call is to `http://127.0.0.1:48900`. No audio, no
page content, no message text — just names and who is talking right now.

## Install

1. Start Alpha (the backend must be listening; the extension talks to port 48900 by default).
2. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select
   this `apps/extension` directory. Chrome, Edge, Brave and Arc all take it as-is.
3. Join a Google Meet or Zoom call. The toolbar badge turns green once Alpha is recording and
   accepting names.

Open the popup to see what the extension currently sees: the roster, who it thinks is speaking,
which signal it used, and whether the backend answered. That view is the fastest way to tell a
broken selector from a stopped backend.

## How names reach the transcript

The content script polls the page every 700 ms and posts a snapshot to
`POST /api/session/participants`:

```json
{
    "source": "google-meet",
    "participants": ["Riyam Jain", "Aditi Sharma"],
    "speaking": ["Aditi Sharma"],
    "self": "Riyam Jain",
    "micMuted": false
}
```

Two more signals ride along when the page offers them:

- **`micMuted`** — whether *your* microphone is muted in the meeting client. Alpha stops
  capturing and transcribing your side of the call while it is true, and picks up again the
  moment you unmute. It is omitted when the page state cannot be read.
- **`ended`** — sent once, with a `reason` (`ended`, `left`, or `tab-closed`), when the page
  shows a post-leave screen, the meeting is over, or the tab closes. Alpha uses it to stop the
  recording and summarize; a rejoin within the grace window cancels the stop. Only a tab that
  actually joined a meeting reports this, so a parked `meet.google.com` home tab stays silent.

The backend turns that stream of snapshots into named speech intervals stamped against the
meeting clock, and uses them three ways:

- **Live turns.** A turn coming off the meeting-audio channel is labelled with whoever the page
  had talking across it, instead of `Others`.
- **Diarized turns.** After a Sarvam batch pass, each diarized speaker is matched to the name
  whose intervals it overlaps, one name per speaker.
- **The summary.** The roster joins the calendar attendees the summary is written against.

A name is only attached when one name covers at least half the turn and no other name comes
close, so cross-talk leaves the generic label in place rather than guessing. The microphone
still wins for your own turns: you are `You`, not your display name.

## When the page changes underneath it

Meet and Zoom ship obfuscated class names that change without notice. Every selector lives in
one place per site — `src/content/meet.js` and `src/content/zoom.js` — as a list of candidates
tried in order, so repairing a site is a one-file edit:

- `tiles` — the elements that represent one participant.
- `name` — where the display name sits inside a tile.
- `speaking` — the indicator that is visible only while that participant talks.
- `micMuted()` — whether the local microphone is muted in the client (`null` when unknown).
- `ended()` — why the meeting is over (`'ended'` or `'left'`), read from the post-leave screen.

If none of the `speaking` selectors ever match, the extension falls back to watching which tile
mutates most often — the speaking indicator is usually the only thing animating inside a tile.
The popup shows which signal produced the current answer (`the page indicator` or
`tile activity`), and the fallback can be switched off there. Roster names keep flowing either
way, so a broken speaking selector costs live attribution, not the attendee list.

## Layout

| File                      | What it does                                                             |
| :------------------------ | :----------------------------------------------------------------------- |
| `src/content/observer.js` | Polling, name tidying, change detection, the tile-activity fallback.     |
| `src/content/meet.js`     | Google Meet selectors and self-name lookup.                              |
| `src/content/zoom.js`     | Zoom web client selectors and self-name lookup.                          |
| `src/background.js`       | The only code that talks to the backend; owns the badge and last report. |
| `src/popup/`              | Status, roster, port, and the two switches.                              |

`observer.js` exports its pure helpers, which is what `test/extension-names.test.js` covers:
`node --test test/extension-names.test.js` from the repository root.
