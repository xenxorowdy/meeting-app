# Kesami Google Calendar OAuth recording

Target: 90 seconds for connection and agenda; up to 120 seconds if including event creation. Real desktop/browser footage, English consent UI, no narration or music. Prepared against the current source and running local app on 2026-10-07.

## Two corrections to the supplied script

- The Google Calendar Connect control is under **Settings → Calendar**, not Connectors.
- The current app requests `https://www.googleapis.com/auth/calendar.events`, not `calendar.events.readonly`. Use Google's actual permission wording on screen. The app describes this as permission to view, create, edit and delete events. A read-only script requires a separately authorized product change; this recording does not change scopes.

## Before recording

Use a test account/calendar with events suitable for showing to reviewers. The actual account email and OAuth client ID are deliberately visible in the verification recording; do not replace them with fictional values. Close unrelated windows and avoid showing transcripts, private event descriptions, passwords, authorization codes or tokens. Keep Kesami and the default browser large enough for the address bar and consent text to be readable. Use the browser's normal window mode so its address bar stays visible.

The inspected local app already has Calendar connected. A new grant recording requires reconnecting or using a separately configured test account. Reconnecting and granting the existing broader permission are pending the owner's decision. Do not disconnect the current calendar just to rehearse.

For a source run, use the local backend at `http://127.0.0.1:48900`, and align the desktop library/recording roots. Do not enable a hosted relay for this recording.

## Shot sequence

| Time | Action | Evidence to keep readable |
| --- | --- | --- |
| 00:00–00:08 | Show Kesami, then open Settings. | App identity and the Settings button. Keep unrelated meeting content out of frame. |
| 00:08–00:15 | Select the **Calendar** tab. | Google Calendar row and its permission description. |
| 00:15–00:20 | Click **Connect** on the Google Calendar row, once ready for a fresh grant. | Kesami opening the default system browser. |
| 00:20–00:30 | Show Google's real authorization/consent page. Focus the address bar and hold. | The actual `accounts.google.com` address and the complete `client_id` value. Use Cmd+L and navigate horizontally in the address bar if necessary; do not substitute a rendered URL. Google's current consent path can differ from the initial `/o/oauth2/v2/auth` request. |
| 00:30–00:40 | Select the intended account. If the unverified-app warning appears, show **Advanced**, then **Go to Kesami (unsafe)**. | The actual app name and warning. If no warning appears, continue naturally. Passwords and recovery codes stay outside the recording. |
| 00:40–00:50 | Show the Calendar permission, select its checkbox if presented, then Continue/Allow. | The actual permission granted for `calendar.events`; do not label it read-only. Grant only after the owner's approval. |
| 00:50–01:00 | Hold on the loopback callback completion page, then return to Kesami. | The real completion message. The current backend says that Google Calendar is connected and the user can return to Kesami; automatic app switching is not assumed. Avoid lingering on a callback URL containing an authorization code. |
| 01:00–01:10 | Show **Settings → Calendar** again. | **Connected** badge and the connected account email. |
| 01:10–01:20 | Close Settings and show Home's **Your schedule** / **Upcoming meetings** region. | Event title and start time for an event from the connected calendar. Frame the agenda rather than unrelated meeting summaries. |
| 01:20–01:30 | Show the same event in Google Calendar, then return to the Kesami agenda. | Matching title, time, date/timezone and account. Do not claim a match before comparing the real event. |
| 01:30–02:00, optional | If approved, use **Schedule meeting**, review a disposable test event, create it and show it in Google Calendar. | Real event-writing functionality for the requested scope. Use a test calendar, no guests and no conferencing link. Creating a real event needs an explicit owner decision. |

Starting a recording from an agenda row is optional and starts live audio processing. It is unnecessary for this connection/agenda demonstration. The source passes the event title and calendar metadata when starting from an agenda event; that path has not been exercised in this run.

## Capture

Run `./record-screen.command` from this folder when the desktop and consent flow are ready. It records the full display silently for up to 120 seconds and saves `calendar-oauth-raw.mp4`. Press `q` in the recording terminal to finish early. The helper does not click Connect, grant consent, modify Calendar, or start meeting recording. Screen Recording access must already be available to the terminal/ffmpeg process.

This is a capture script, not a completed video. After capture, inspect the whole recording for readable client ID, actual scope, account, callback and matching events. Trim login pauses if needed while preserving the actual sequence and retain the raw recording. Check the final video with ffprobe and inspect frames at every step before calling it ready.

## Verification boundary

Confirmed in this run: source requests `calendar.events`; Settings has a Calendar tab; the local app reports an existing Google Calendar connection and shows upcoming events. Not yet captured or verified: a fresh Google consent round trip, a browser comparison of matching events, event creation, physical screen recording, or a final MP4.

Google's verification guide asks for the real grant process, app name, OAuth client ID in the browser address bar, and use of each requested sensitive scope. Its Calendar scope reference distinguishes event read/write access from read-only access. An agenda-only clip does not demonstrate the app's event-writing use case.

Sources:

- https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
- https://developers.google.com/workspace/calendar/api/auth
- `apps/ui/src/components/SettingsModal.jsx`
- `apps/ui/src/hooks/useCalendar.js`
- `apps/ui/src/components/design/DesignWorkspace.jsx`
- `apps/core-backend/src/calendar.rs`
- `apps/ui/src/hooks/useMeetingSession.js`
