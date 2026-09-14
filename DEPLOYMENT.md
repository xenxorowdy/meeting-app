# Deploying the Alpha backend

The Rust core backend (`apps/core-backend`) runs as a hosted service on
[Fly.io](https://fly.io). A desktop or browser client connects to it over
HTTPS/WSS with a workspace access token; meeting audio streams to it live, and
the machine's local recording/screen-capture features stay on the client.

```
┌─────────────────────┐        HTTPS + WebSocket (bearer token)
│  Client (Electron   │ ───────────────────────────────────────────────▶  Fly.io
│  app or browser)    │ ◀───────────────────────────────────────────────  alpha-core-backend
└─────────────────────┘         live transcripts, events, REST            (persistent /data volume)
```

## What hosted mode changes

Binding to a non-loopback address flips the backend into **hosted mode**
(`apps/core-backend/src/security.rs`), which:

- requires every route except `GET /health`, CORS preflights, and the
  credential-minting auth routes to carry the workspace token
  (`Authorization: Bearer …`, or the `alpha-token.*` WebSocket subprotocol),
- only answers browser requests whose `Origin` is on the allowlist,
- refuses `POST /api/calendar/connect` and post-meeting diarization (both need
  OAuth browsers / recording files on the same machine),
- streams audio through Sarvam realtime only — batch transcription needs the
  recording file on the backend disk, so it is unavailable hosted.

The client discovers this through `GET /api/settings`
(`deploymentMode: "hosted"`) and adjusts the UI automatically.

## Accounts and sign-in

The welcome screen offers email sign-in and account creation
(`POST /api/auth/register`, `POST /api/auth/login`, plus `GET /api/auth/session`
and `POST /api/auth/logout` under `apps/core-backend/src/accounts.rs`). These
routes are reachable without the workspace token — they mint credentials — but
are still subject to the Host and Origin checks. A signed-in session token then
authorizes routes in place of the workspace token, so clients may keep the
deployment token private to operators.

Accounts live in `accounts.json` in the data directory (0600, alongside
`credentials.json`) with PBKDF2-hashed passwords and hashed session tokens only
— never a password or a token in plaintext. Sessions last 30 days and survive
restarts. Accounts identify people to a single shared workspace; meeting data
is not partitioned between them.

## One-time setup

```bash
# 1. Install the fly CLI: https://fly.io/docs/flyctl/install/
fly auth signup        # or `fly auth login`

# 2. Provision the app and a 5 GB volume for meeting data.
cd apps/core-backend
fly launch --no-deploy          # accepts fly.toml, creates the app
fly volumes create alpha_data --size 5 --region bom
# (fly.toml also sets initial_size = "5gb", so the volume is created
# automatically on first deploy if you skip this step.)

# 3. Generate and set the workspace token clients will paste into Settings.
openssl rand -base64 48 | tr -d '\n' > /tmp/alpha-token   # ≥32 printable chars
fly secrets set ALPHA_BACKEND_TOKEN="$(cat /tmp/alpha-token)"
rm /tmp/alpha-token

# 4. Provider keys live in fly secrets, never in the image or the repo.
fly secrets set ALPHA_SARVAM_API_KEY=sk_… ALPHA_GEMINI_API_KEY=AIza…

# 5. Tell the backend which browser origins may connect. The Electron desktop
#    app needs no entry — it loads its UI from file://, so Chromium sends
#    `Origin: null` on fetch and the literal `file://` on the WebSocket
#    handshake. ALPHA_ALLOW_NULL_ORIGIN covers both, and fly.toml sets it
#    while the workspace token still guards every route.
fly secrets set ALPHA_ALLOWED_ORIGINS="https://app.example.com"
```

Deploy:

```bash
fly deploy        # builds the Dockerfile remotely, health-checks /health
fly status        # confirm the machine is running and healthy
fly logs          # backend startup lines, transcription/summary engine status
```

`fly.toml` sets `min_machines_running = 0` with auto-stop, so an idle
workspace costs nothing; the first request after a stop pays a few seconds of
start latency. For a demo on a live call, set `min_machines_running = 1` in
`fly.toml` (or run `fly scale count 1 --stay-resident` beforehand) so the
machine never suspends mid-meeting.

## Connecting a client

**Electron desktop app** — open Settings → Connection, enter
`https://<your-app>.fly.dev` and the workspace token, then "Test connection" →
"Connect & reload". The token is kept for the session only.

**Browser client** — the UI is a static build; point it at the backend at
build time and serve it from any static host:

```bash
cd apps/ui
VITE_BACKEND_URL=https://<your-app>.fly.dev npm run build
```

The browser origin you serve it from must be in `ALPHA_ALLOWED_ORIGINS`. If
only browser clients will use this deployment, also lock the null-origin
allowance back down (this closes `null` and `file://` together, so the
Electron app can no longer connect to it):

```bash
fly secrets set ALPHA_ALLOW_NULL_ORIGIN=false
```

Local development is unchanged: `npm run dev` still starts the local backend on
`127.0.0.1:48900` with no token, and the UI defaults to it.

## Data on the volume

`/data` holds everything under `ALPHA_DATA_DIR`:

- `.alpha-meeting-assistant/meetings/…` — the meeting library,
- `.alpha-meeting-assistant/settings.json` and `credentials.json` (mode 0600),
- the chat embedding model (~470 MB, downloaded on first AI-chat use).

Back it up with `fly sftp get` on the machine, or snapshot the volume.
Because the workspace token and provider keys live in fly secrets and the
volume respectively, the Docker image itself contains no credentials.

## Updating

```bash
git pull
fly deploy
```

Meeting history survives deploys (volume); settings and keys survive too. The
UI/backend API contract is kept backward-compatible per `AGENTS.md`, so a
newer client can talk to a slightly older backend and vice versa.
