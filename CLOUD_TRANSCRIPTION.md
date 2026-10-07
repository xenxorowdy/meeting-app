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

Batch transcription, podcast generation, connector OAuth and one-click MCP setup
are separate from these meeting AI routes.

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
