# Kesami relay on Azure

This deployment hosts `kesami-cloud-relay`, not the desktop core backend. It uses
the existing Supabase identity and billing database, Sarvam streaming, hosted AI,
connector OAuth routes and signed Razorpay webhooks. No local model or meeting
library is moved to Azure.

## Beta target

- Subscription: `Azure subscription 1`, `52de3443-2577-4ba6-84f7-f5c866421f8a`.
- Resource group: `kesami`; region: `centralindia`.
- One Consumption replica, 0.25 vCPU and 0.5 GiB RAM, HTTPS/WSS on port 48901.
- 20 concurrent meetings, **40 provider streams** with microphone and system
  audio enabled. The relay permits 64 streams and two streams per user.
- Up to two hours per stream. Capacity on this Azure instance size must be
  demonstrated before DNS cutover; constants alone do not prove throughput.
- Azure budget: ₹3,000/month. The working cost assumption is one recording hour
  per user daily on average, or 20 meeting hours daily across the beta.
  This changes the estimate, not the application's recording limits.

One replica preserves the process-local stream ledger and connector tickets.
It does not provide high availability. A restart or deployment can terminate
recordings and pending OAuth handoffs. The manual workflow requires the operator
to confirm recordings have drained.

## Current deployment blocker

On 2026-10-08, the signed-in principal
`bd3963ad-7b46-4735-92e3-dc4b82809143` had Contributor access at resource-group
scope only. `Microsoft.App` was not registered. Registration returned
`AuthorizationFailed`; no Azure service was deployed.

A subscription administrator must register the provider:

```bash
az provider register --namespace Microsoft.App --wait
```

There is no paid Log Analytics workspace in this template. Console logs can be
read through Container Apps log streaming, but there is no durable log retention.
If durable logging is added later, register `Microsoft.OperationalInsights` and
include its ingestion/retention cost in the estimate.

## Server settings and image access

Copy `relay-settings.example.json` to `relay-settings.private.json`, restrict it
with `chmod 600` and replace every placeholder. This private filename is ignored
by Git. Never put server settings in repository variables, desktop release config
or public workflow logs. The parameter writer creates a new file with mode 0600
and refuses to overwrite it.

Use the Supabase **transaction pooler URL**, with a URL-encoded password and TLS,
instead of its IPv6-only direct database hostname. The relay's billing pool
requires `KESAMI_SUPABASE_DB_URL`; a database password alone is insufficient.
Retain the existing billing schema; this deployment performs no migration.

For configured connectors, add the matching `KESAMI_<PROVIDER>_CLIENT_ID` and
`KESAMI_<PROVIDER>_CLIENT_SECRET` server settings used by the relay's
`connector_apps` function. Keep `KESAMI_RELAY_PUBLIC_URL` at the existing public
origin during staging. Test OAuth callbacks only once their hostname routes to
Azure. Do not disconnect existing accounts as part of deployment verification.

The image workflow publishes `ghcr.io/xenxorowdy/kesami-relay`, then deploys its
immutable sha256 digest. A new GHCR package can be private even for a public
repository. Either make the package public or provide a dedicated `read:packages`
token as the `GHCR_PULL_TOKEN` environment secret. Do not use the short-lived
Actions `GITHUB_TOKEN` as the Container App's permanent pull credential.

## GitHub OIDC setup

Create the `azure-beta` GitHub environment in `xenxorowdy/meeting-app`. Configure
an Entra application/service principal with a federated credential:

```json
{
  "name": "github-kesami-azure-beta",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:xenxorowdy/meeting-app:environment:azure-beta",
  "audiences": ["api://AzureADTokenExchange"]
}
```

An administrator with permission to manage role assignments must grant that
principal Contributor on the `kesami` resource group. Resource-group Contributor
cannot grant this role or register subscription providers.

Set these GitHub environment variables:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | Deployment application's client ID |
| `AZURE_TENANT_ID` | `0f305d2c-c91c-48e0-9e03-e74a83713818` |
| `AZURE_SUBSCRIPTION_ID` | `52de3443-2577-4ba6-84f7-f5c866421f8a` |
| `AZURE_MONTHLY_BUDGET` | Budget amount **in the subscription billing currency** |
| `AZURE_BUDGET_EMAIL` | Address receiving 50%, 80% and 100% cost alerts |
| `AZURE_BUDGET_START_DATE` | First day of the budget month, e.g. `2026-10-01` |

Store the JSON settings as a GitHub environment secret:

```bash
gh secret set KESAMI_RELAY_ENV_JSON --repo xenxorowdy/meeting-app \
  --env azure-beta < deploy/azure/relay-settings.private.json
```

Budget variables are optional for staging. Without a positive amount, no budget
resource is created. Before production cutover, configure the amount after
checking the invoice currency: `3000` represents ₹3,000 **only for INR billing**.
Budget alerts do not impose a spending limit or stop the app.

The `Azure relay` workflow is manual. Leaving `recordings_drained` false builds
and publishes the image without deployment. Setting it true stages the app,
runs Bicep what-if, deploys and checks HTTPS health and the billing catalog.
It does not alter DNS, connector registrations or payment-provider settings.

## Local verification

```bash
python3 -m unittest discover -s deploy/azure -p 'test_*.py'
az bicep build --file infra/azure/main.bicep --outfile /tmp/kesami-relay-template.json
cargo test --manifest-path apps/core-backend/Cargo.toml \
  --no-default-features --bin kesami-cloud-relay
docker build --platform linux/amd64 -f apps/core-backend/Dockerfile.cloud \
  -t kesami-relay:azure-beta .
```

The capacity test uses 20 synthetic identities, 40 WebSocket connections,
200 ms PCM chunks per stream and mock provider transcripts. It checks forwarding,
per-user limits, slot release and health. It uses no production keys or database.
Its default host-test duration is three seconds. A longer soak can run with:

```bash
KESAMI_RELAY_SOAK_SECONDS=7190 cargo test \
  --manifest-path apps/core-backend/Cargo.toml --no-default-features \
  --bin kesami-cloud-relay twenty_meetings_forward_two_audio_streams_each \
  -- --nocapture
```

The soak ends shortly before the existing two-hour deadline, which otherwise
closes streams by design. Host tests do not prove the 0.25 vCPU Azure allocation,
real provider capacity or long-lived Azure ingress behaviour.

The capacity image can run the same fixture under Docker CPU/memory limits:

```bash
docker build --target capacity-test -f apps/core-backend/Dockerfile.cloud \
  -t kesami-relay-capacity .
docker run --rm --cpus 0.25 --memory 512m \
  -e KESAMI_RELAY_SOAK_SECONDS=60 kesami-relay-capacity
```

This includes both mock providers and relay in the allocation. It is a useful
local constraint check, not an Azure ingress or real-provider test. The workflow
runs this 60-second check before publishing the deployment image.

## Staging, cutover and rollback

1. Confirm the Sarvam key has **at least 40 concurrent STT connections** available
   across all services sharing that key. Starter's published allowance is 20;
   Pro and Business publish 100. Do not silently upgrade a provider subscription.
2. Validate the deployed HTTPS endpoint, authenticated WSS and the Supabase
   billing catalog. Run 20 dual-stream sessions near the two-hour limit through
   Azure, monitoring CPU, memory, resets and transcript delays. Use synthetic
   audio and explicit beta accounts; account creation is not automatic.
3. Verify connector OAuth with a test account and Razorpay **test-mode** signed
   webhook retries and entitlement persistence. A passing catalog endpoint is
   not payment verification. Do not reuse synthetic events against production
   billing or claim real-payment verification from mock tests.
4. Confirm the full cost estimate and budget alerts fit the ₹3,000 target.
   Save existing DNS records, public hostname, webhook URLs and image digest.
5. After recordings drain, bind `app.kesami.online` with a managed TLS certificate
   and change its DNS to Azure. Verify hostname ownership using the app's domain
   verification ID. Keep the old server running until verification completes.
   The hostname stays the same, so packaged clients and registered callback and
   webhook URLs need no changes.
6. Verify a real desktop recording, enabled connectors and billing reads through
   the public hostname. If verification fails, restore the saved DNS records.
   DNS rollback is subject to caching and does not restore interrupted streams.

No automatic DNS cutover runs in CI. If 0.25 vCPU fails the load gate, measure
0.5 vCPU/1 GiB separately and revise the cost estimate before provisioning it.

## Cost boundary

Central India retail rates retrieved on 2026-10-08 were ₹0.0023 per active
vCPU-second and ₹0.0003 per GiB-second. At 0.25 vCPU/0.5 GiB running actively for
30 days, compute is approximately ₹1,357 after the subscription's monthly free
grants of 180,000 vCPU-seconds and 360,000 GiB-seconds. Without unused free grants,
the same compute estimate is approximately ₹1,879.

Bandwidth, requests beyond the free allowance and applicable taxes are additional.
Under the one-hour daily average assumption, both audio channels together can
forward about **184 GB/month**. With the first 100 GB free, egress is roughly
₹971 and compute plus egress is approximately **₹2,330 before taxes**. This leaves
about ₹670 for taxes, protocol overhead and other charges within the ₹3,000
target. It depends on the free grants being available and is not a spending cap.
Measure actual daily usage before cutover and configure budget alerts.

For comparison, the original two-hour daily average would produce twice the audio.
40 audio hours daily at 16 kHz/16-bit, with both channels always sending, can
forward roughly **369 GB/month** to Sarvam after base64 encoding, excluding JSON
and protocol overhead. Silence suppression can reduce this, but do not assume
it in a conservative estimate. Central India's Microsoft-network internet-egress
rate is ₹11.5187/GB after the first 100 GB/month. For the conservative 369 GB
workload, egress is about ₹3,096, bringing compute plus egress to approximately
**₹4,450 before taxes**. This exceeds the approved ₹3,000 target. Do not deploy
on the assumption that silence suppression will close this gap without measuring
it. Sarvam and other provider fees are excluded.

References: [Azure pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/),
[billing rules](https://learn.microsoft.com/en-us/azure/container-apps/billing),
[bandwidth pricing](https://azure.microsoft.com/en-in/pricing/details/bandwidth/),
[WebSocket ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview),
[Sarvam limits](https://docs.sarvam.ai/api/getting-started/ratelimits).
