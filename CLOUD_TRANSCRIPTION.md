# Hosted transcription and meeting AI relay

The packaged desktop app keeps its meeting library and recordings on each Mac. Its
local Rust backend uses the user's renewable Supabase Google session to open a
WebSocket to the cloud relay. Only the relay receives the Sarvam API key. The
relay verifies each access token with Supabase Auth before opening a provider
socket. Summaries and grounded chat use authenticated HTTP requests to the same relay,
which holds the Gemini key and selects the model. It does not save audio or meeting data.

This service is separate from the existing hosted core backend. Do not point
multiple customers at the hosted core backend: its meeting library and active
session are shared across accounts.

## Server setup

The public address must be an HTTPS origin with a certificate trusted by macOS.
For an initial deployment without a purchased domain, a fixed-IP `sslip.io`
name can point to the existing Oracle VM. Replace it with a domain you control
before a broad release. Keep the relay on the VM's loopback interface; allow
public traffic only through Caddy on port 443.

Build the relay image with `apps/core-backend/Dockerfile.cloud` from the
repository root. It compiles only the `kesami-cloud-relay` binary with
`--no-default-features`, which excludes the core backend's ONNX inference dependencies.
Billing includes the Postgres client and shared billing code. The image ships on
`debian:trixie-slim`. On Apple Silicon, build for `linux/amd64` locally or in CI, then load
the image on the VM; do not build the core backend's Rust/ONNX image on the VM.
To run the relay locally, use `npm run --prefix apps/core-backend start:cloud`.
For the existing Oracle VM, the initial DNS name can be
`api.144-24-109-107.sslip.io` if that public IP remains assigned. Confirm the
VM's address before packaging, since the hostname is embedded in the DMG.

```bash
docker buildx build --platform linux/amd64 --load -f apps/core-backend/Dockerfile.cloud -t kesami-cloud-relay:1 .
docker save kesami-cloud-relay:1 | ssh ubuntu@144.24.109.107 docker load
```

Run the relay with a private, owner-readable environment file containing:

```text
KESAMI_SUPABASE_URL=https://<your-project>.supabase.co
KESAMI_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
KESAMI_SARVAM_API_KEY=<private-key>
KESAMI_GEMINI_API_KEY=<private-key>
KESAMI_OPENAI_API_KEY=<optional-private-key>
KESAMI_SUPABASE_DB_URL=<server-only-postgres-pooler-uri>
KESAMI_RAZORPAY_KEY_ID=<provider-key-id>
KESAMI_RAZORPAY_KEY_SECRET=<private-provider-secret>
KESAMI_RAZORPAY_PLAN_INR=<monthly-plan-id>
KESAMI_RAZORPAY_WEBHOOK_SECRET=<private-webhook-secret>
```

Meeting AI needs the Gemini key. `KESAMI_OPENAI_API_KEY` is optional: when
Gemini answers 429 (quota exhausted), the relay retries that request once on
`gpt-5-nano`. OpenAI spend is capped at `KESAMI_OPENAI_DAILY_BUDGET_USD`
(default `3`, per UTC day, estimated from token usage). Set
`KESAMI_OPENAI_USAGE_FILE` to a path on a mounted volume so the tally survives
container restarts; without it the count lives in memory.

Bind the Docker port to `127.0.0.1:48901:48901` on the VM. Configure Caddy to
reverse proxy the chosen HTTPS hostname to `127.0.0.1:48901`. Keep the existing
core backend on private port 48900. Confirm `/health` answers over HTTPS and
that the relay rejects an unauthenticated WebSocket before distributing a DMG.

```text
api.144-24-109-107.sslip.io {
    reverse_proxy 127.0.0.1:48901
}
```

The relay can be started separately from the existing backend with a private
`/home/ubuntu/cloud.env` and a host-only port mapping:

```bash
docker run -d --name kesami-cloud-relay --restart unless-stopped \
  --env-file /home/ubuntu/cloud.env \
  -p 127.0.0.1:48901:48901 kesami-cloud-relay:1
```

## Desktop package

Set `KESAMI_CLOUD_URL=https://<chosen-hostname>` in the packaging command's environment
(or the public build configuration in ignored `apps/ui/.env`). `prepareAuthConfig.js` validates it
and bundles only the public URL plus public Supabase auth values. Never bundle
the Sarvam key, a Supabase secret key, or a workspace token. Release packaging fails if the cloud URL is missing. Development can still run
with local backend provider keys when no cloud URL is configured. In cloud mode,
saved batch preferences are overridden with realtime transcription; post-meeting
batch diarization is disabled because recordings stay on the client.

The relay covers Sarvam realtime transcription and Gemini meeting summaries and
grounded chat (`POST /v1/ai/generate`). It verifies the user with Supabase Auth
before calling a provider. The Gemini key is optional at relay startup, but must
be set on the server for meeting AI to work; authenticated `/v1/capabilities`
reports `meetingAi`. Only text and structured output requests are accepted,
with a 1 MiB request limit, one active AI request per user, and a daily allowance
of 100 requests (`KESAMI_CLOUD_DAILY_AI_LIMIT` overrides this). This is a relay
usage safeguard, separate from the desktop plan allowance.

Batch transcription, podcast generation, Google connector OAuth and one-click MCP setup
are separate from these meeting AI routes.

## One-click connectors

Settings → Connectors offers a one-click sign-in for Slack, Notion, Linear, Jira, Asana and
ClickUp. Every one of these providers needs the app's client secret to exchange the code,
and all except Slack and ClickUp also need it to refresh tokens, so the relay brokers the
OAuth flow and the desktop keeps the tokens:

1. The desktop backend calls `POST /v1/connectors/{provider}/start`. The relay returns the
   provider's authorize URL and a separate one-time `ticket`.
2. The provider redirects to `GET /v1/connectors/{provider}/callback`. The relay exchanges the
   code with the client secret and holds the result in memory for up to 10 minutes.
3. The desktop backend polls `POST /v1/connectors/{provider}/claim` with the ticket and gets the
   result once. Slack returns only the incoming-webhook URL (its bot token is discarded); the
   others return an access token, refresh token and expiry, stored in the local credentials file.
4. When a token is about to expire, or a call answers 401, the desktop calls
   `POST /v1/connectors/{provider}/refresh` with its refresh token. The relay adds the client
   secret and returns the rotated tokens. It stores nothing.
5. Disconnect calls `POST /v1/connectors/{provider}/revoke`. Notion, Linear and Asana revoke the
   grant; Slack, Jira and ClickUp have no revoke API, so the app tells the user where to remove
   Kesami in that product.

`GET /v1/connectors` lists the providers this relay has apps for; the desktop shows the
one-click button only for those and falls back to the paste-a-token form for the rest.

After signing in, Kesami sets up the destination itself, with no picker. On a later
sign-in it reuses what it created:

| Provider | Destination |
| :------- | :---------- |
| Notion | Creates a private "Kesami Meetings" page in the workspace (or under the first shared page if that isn't allowed) |
| Linear | The first team the user belongs to |
| Jira | The first Jira site, the project the user most recently updated, issue type Task |
| Asana | Creates a "Kesami Meetings" project in the first workspace (in the user's first team for organizations) |
| ClickUp | Creates a "Kesami Meetings" list in the first Space |

If setup fails (for example, no Jira project the user can create issues in), the card says so
and offers **Try again** (`POST /api/connectors/setup`) without signing in again.

Every delivery carries the summary, tasks and commitments. Notes apps (Slack, Notion,
Google Docs) get the summary, tasks, commitments and a "Done after the meeting" list of
completed post-meeting actions. Task apps create one item per open task and per commitment,
each with the meeting summary and, when the meeting was sent to Notion or Google Docs, a
link to those notes. Commitments follow the Actions tab's rules: dismissed and stale
commitments are skipped, and a commitment linked to a task appears once.

Set the relay's public origin once, then add each provider's app credentials:

```text
KESAMI_RELAY_PUBLIC_URL=https://<relay-host>
KESAMI_SLACK_CLIENT_ID=...       KESAMI_SLACK_CLIENT_SECRET=...
KESAMI_NOTION_CLIENT_ID=...      KESAMI_NOTION_CLIENT_SECRET=...
KESAMI_LINEAR_CLIENT_ID=...      KESAMI_LINEAR_CLIENT_SECRET=...
KESAMI_JIRA_CLIENT_ID=...        KESAMI_JIRA_CLIENT_SECRET=...
KESAMI_ASANA_CLIENT_ID=...       KESAMI_ASANA_CLIENT_SECRET=...
KESAMI_CLICKUP_CLIENT_ID=...     KESAMI_CLICKUP_CLIENT_SECRET=...
```

Each provider's redirect URL is `https://<relay-host>/v1/connectors/<provider>/callback`.

| Provider | Where to create the app | Settings that matter |
| :------- | :---------------------- | :------------------- |
| Slack | api.slack.com/apps → From scratch | Bot scope `incoming-webhook`; Manage Distribution → activate public distribution |
| Notion | Developer portal → Public connections | Installation scope **Any workspace** (fixed at creation); capabilities: read, insert and update content, user info with email |
| Linear | linear.app/settings/api/applications/new | Distribution **public**; the relay asks for `read,issues:create` |
| Jira | developer.atlassian.com console → OAuth 2.0 integration | Permissions → Jira API with `read:jira-work`, `write:jira-work`, `read:jira-user`; Distribution → enable sharing. Until Atlassian reviews the app, users see an "unreviewed app" warning |
| Asana | app.asana.com/0/my-apps | Scopes `tasks:write projects:read projects:write teams:read workspaces:read users:read`; Manage distribution → **Any workspace** (Asana's docs disagree on whether outside workspaces also need a review) |
| ClickUp | Workspace settings → Apps / ClickUp API → Create app | Only workspace owners and admins can create apps; tokens never expire |

Without a provider's ID and secret, its `start` answers 503 and the app keeps the paste form.
Development builds without `KESAMI_CLOUD_URL` show only the paste forms.

## Subscription billing

The relay also serves `GET /v1/plans`, authenticated `GET /v1/billing/subscription`,
`POST /v1/billing/checkout`, `POST /v1/billing/razorpay/confirm`, and
`POST /v1/billing/razorpay/sync`. The desktop continues using its existing
`/api/billing/*` routes; its backend forwards them with a renewable Supabase session.
Only the relay holds payment secrets and the database connection. Its verified
Supabase user ID owns the subscription, so a plan follows the user across installations.

Apply the existing `002_supabase_billing` migration before enabling relay billing.
Configure Razorpay to deliver subscription webhooks to
`https://<relay-host>/v1/billing/webhook/razorpay`. Provider signatures authenticate
this route; a user session is not required. Checkout confirmation verifies the
payment signature against the server's stored subscription, fetches its current
provider state, and commits the plan to Supabase before reporting success.
Webhook receipts and changes commit in one transaction; failures return an error
so Razorpay can retry. The service also checks provider state when events arrive,
which prevents delayed events from replacing newer provider state.

For Stripe, also configure `KESAMI_STRIPE_SECRET_KEY`, `KESAMI_STRIPE_PRICE_USD`,
`KESAMI_STRIPE_WEBHOOK_SECRET`, and an HTTPS `KESAMI_BILLING_RETURN_URL` on the
relay. The webhook URL is `https://<relay-host>/v1/billing/webhook/stripe`.

See [the payment pipeline verification record](docs/PAYMENT-PIPELINE.md) for
the local and public-service verification boundaries.
The relay's daily audio and AI allowances are currently held in memory and resets if the
service restarts; move it to durable storage before opening this beta broadly.
