# Production readiness checklist

This document is the launch checklist for Alpha Meeting Assistant. It records
the current product boundary so a configured demo or private workspace is not
mistaken for a public multi-tenant SaaS release.

## Current status

| Area                       | Status                                | Notes                                                                 |
| -------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| Desktop meeting capture    | Ready to validate on target devices   | Requires macOS/Windows recording and microphone permissions.          |
| Hosted Rust backend        | Deployable                            | Fly configuration and a persistent `/data` volume are included.       |
| Browser UI                 | Deployable                            | Build it with the HTTPS backend URL.                                  |
| Password sign-in           | Implemented for one private workspace | SQLite stores PBKDF2 password hashes and hashed sessions.             |
| Calendar strip             | Implemented for local desktop use     | Google can read/write events; Outlook is read-only.                   |
| Sarvam transcription       | Configurable                          | Hosted mode supports realtime only; batch needs a local recording.    |
| Supabase Postgres          | Connection only                       | The backend connects and reports health; no data is stored there yet. |
| Payments and subscriptions | Not implemented                       | The displayed Pro price is informational; checkout is disabled.       |
| Multi-tenant SaaS          | Not implemented                       | Accounts on one backend share meetings and settings.                  |

## 1. Install and build

```bash
cd /Users/riyamjain/person/alpha/packages/meeting-app
npm ci
npm run build:all
```

Install Rust before building the backend. Desktop packaging also needs Electron's
platform-specific dependencies and should be tested on each target operating
system.

For local development:

```bash
npm run dev
```

## 2. Local configuration

Fill in these private, Git-ignored files:

- `apps/ui/.env.local`
- `apps/core-backend/.env.local`

The UI file is public browser configuration. It must never contain API keys,
OAuth secrets, passwords, or the backend access token.

```env
# apps/ui/.env.local
VITE_BACKEND_URL=https://your-backend.example.com
```

The Rust backend loads `apps/core-backend/.env.local` at startup. Shell,
Electron, Docker, and Fly secret variables take precedence.

```env
# apps/core-backend/.env.local
ALPHA_GEMINI_API_KEY=
ALPHA_SARVAM_API_KEY=
ALPHA_GOOGLE_CALENDAR_CLIENT_ID=
ALPHA_GOOGLE_CALENDAR_CLIENT_SECRET=
ALPHA_MICROSOFT_CALENDAR_CLIENT_ID=
ALPHA_SUPABASE_DB_URL=
```

Use a host secret manager for production values instead of copying this local
file to a server.

## 3. Supabase Postgres

Supabase is optional. Without it the backend runs entirely on local storage, and
every route except the two below behaves exactly as before.

Copy the connection string from **Supabase Dashboard → Connect → URI** into
`ALPHA_SUPABASE_DB_URL`. The session pooler (port 5432) is the safe default; the
transaction pooler (port 6543) also works and disables prepared statements
automatically, because that pooler cannot support them. As an alternative, set
`ALPHA_SUPABASE_URL` and `ALPHA_SUPABASE_DB_PASSWORD` and the backend assembles
the direct `db.<project-ref>.supabase.co` connection itself.

TLS is required: a connection string without an explicit `sslmode` is upgraded
to `sslmode=require`.

Verify the connection:

```bash
curl -s http://127.0.0.1:48900/health | jq .supabase
curl -s -X POST http://127.0.0.1:48900/api/supabase/check | jq
```

`/api/supabase/check` opens the pool, runs `select version()`, and answers `200`
on success or `503` with a reason. `GET /api/supabase/status` returns the last
result without reconnecting, and the same block appears under `supabase` in
`/api/status`. Both routes need the workspace token on a hosted backend; the
public `/health` probe reports only whether Supabase is configured and whether
the last check passed, never the host or credentials.

A missing or unreachable project never blocks startup: the first connection is
probed in the background and only logged.

## 4. Calendar strip

The calendar strip appears after a calendar connection is configured. Calendar
OAuth uses a temporary loopback callback, so connect it from the local desktop
backend; hosted mode deliberately rejects calendar connection requests.

### Google Calendar

1. In Google Cloud Console, enable **Google Calendar API**.
2. Configure the OAuth consent screen and add the `calendar.events` scope.
3. Create a **Desktop app** OAuth client.
4. If the app is in testing, add each user as a test user.
5. Place the client ID and, when required, client secret in the backend local
   configuration or enter them in **Settings → Calendar**.
6. Select **Connect** and complete the browser consent flow.
7. If a prior connection granted read-only access, disconnect and reconnect to
   grant the current write scope.

Google supports upcoming-event display, event creation, invites, and optional
Google Meet links. Event editing and deletion are not implemented.

### Microsoft Outlook

1. Create an Entra app registration that accepts personal Microsoft accounts.
2. Add a **Mobile and desktop applications** redirect URI of `http://localhost`.
3. Put its application client ID in `ALPHA_MICROSOFT_CALENDAR_CLIENT_ID`.
4. Connect from **Settings → Calendar**.

Outlook currently supplies read-only calendar events.

## 5. Hosted deployment

The included Fly deployment expects a persistent volume and these secrets:

```bash
cd apps/core-backend
fly launch --no-deploy
fly secrets set ALPHA_BACKEND_TOKEN="<generated 32+ character token>"
fly secrets set ALPHA_ALLOWED_ORIGINS="https://your-ui.example.com"
fly secrets set ALPHA_GEMINI_API_KEY="..." ALPHA_SARVAM_API_KEY="..."
fly secrets set ALPHA_SUPABASE_DB_URL="postgresql://..."
fly deploy
```

Build and deploy the static browser UI separately:

```bash
cd apps/ui
VITE_BACKEND_URL="https://your-backend.fly.dev" npm run build
```

For browser-only hosting, set `ALPHA_ALLOW_NULL_ORIGIN=false`. Keep it `true`
when Electron clients must connect, because Electron uses a null/file origin.

Before a live demo, keep at least one Fly machine running to avoid wake-up
latency:

```bash
fly scale count 1 --stay-resident
```

## 6. Password accounts

Passwords are created through the app's sign-up flow; there is no password
environment variable. The backend stores `accounts.sqlite3` under
`ALPHA_DATA_DIR`, with PBKDF2-HMAC-SHA256 password hashes and hashed session
tokens. Sessions last 30 days.

For a hosted backend, account registration needs the owner-provided
`ALPHA_BACKEND_TOKEN`. Do not distribute that token. Login uses a user's
session token after account creation.

This is appropriate for a private shared workspace. It does not isolate one
customer's data from another customer's data on the same backend.

## 7. Required pre-launch checks

Run before every release candidate:

```bash
npm run test:backend
npm run test:auth
npm run test:supabase
npm run build:ui
```

Then validate on a real target device:

1. Launch the packaged desktop app and grant microphone and screen-recording
   permissions.
2. Record a real Google Meet, Zoom, or equivalent call.
3. Confirm live transcript, stop flow, saved meeting, summary, and restart
   persistence.
4. Connect Google Calendar and confirm the strip shows an upcoming event.
5. Create a test event with a Google Meet link.
6. Create an account, sign out, sign in, and change its password.
7. Test a deployed browser UI against the hosted backend with its exact origin.
8. Confirm `/health`, logs, persistent-volume backup, and recovery procedure.

## 8. Work required before a public SaaS launch

- Tenant isolation for meetings, settings, credentials, and usage.
- Email verification, password recovery, and operational account support.
- Payment provider, webhook signature verification, idempotent billing records,
  entitlement enforcement, cancellation/refunds, and sandbox tests.
- Signed installers, an update channel, and platform-specific release testing.
- Monitoring, alerting, backups, retention/deletion policy, and an incident
  recovery runbook.
- Provider usage limits, cost controls, and abuse/rate limiting at the edge.
- A privacy policy, terms, and review of data handling for recordings,
  transcripts, and third-party AI providers.

## References

- `DEPLOYMENT.md` — Fly deployment details.
- `docs/PRODUCT-SETUP.md` — account, password, and pricing behavior.
- `README.md` — calendar, transcription, media-tool, and desktop behavior.
