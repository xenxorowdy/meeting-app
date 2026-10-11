# Azure relay validation, 2026-10-08

## Result

Deployment files are prepared locally. No Azure app, environment, budget, GitHub
deployment identity or DNS cutover was created. The current relay remains the
public endpoint. The workflow has not been pushed or executed on GitHub.

## Passed

- Bicep compilation with CLI 0.48.1 and current stable Container Apps API
  `2026-07-01`.
- Azure resource-group what-if with synthetic parameters: `Succeeded`, exactly
  two intended resource creations and no deletions. This is a preview, not a
  provider-registration or deployment guarantee.
- Nine Python parameter-validation tests and three public client-config tests.
- GitHub workflow validation using actionlint 1.7.12.
- Linux amd64 runtime image build and `/health` HTTP 200 under Docker limits of
  0.25 vCPU and 512 MiB. Health was checked with synthetic configuration.
- 25 existing non-database relay tests in the Linux test image.
- New 20-user/40-stream test for 60 seconds at 0.25 vCPU and 512 MiB, including
  mock upstreams in the same allocation. Completed in 60.79 seconds with audio
  and transcript forwarding, per-user rejection, stream-slot cleanup and health
  assertions. One Docker sample reported 5.68% of a CPU and 31.64 MiB of memory;
  this is a sample, not a peak or average.
- Existing hosted-billing integration test with a disposable local PostgreSQL
  container and mock payment provider. Entitlement persistence, duplicate events,
  retries and restart behaviour passed. No real Supabase or Razorpay data was
  written. The disposable database container/network were removed afterwards.
- `git diff --check`; pre-existing source/UI changes were preserved.

The initial host test run passed. A later macOS rebuild encountered an SDK/linker
error for `arm64e.x1` in the installed macOS 27 SDK. Verification was completed
using the Linux image instead; the system SDK was not changed.

## Deployment blockers

1. `Microsoft.App` is not registered. The signed-in user has Contributor on
   `kesami` only; registration returned `AuthorizationFailed` at subscription
   scope. A subscription administrator must register it.
2. The user retained the ₹3,000 monthly budget. The working estimate now assumes
   one recording hour per user daily on average, yielding about 184 GB/month of
   dual-stream egress and ₹2,330 for compute plus egress before taxes. Free
   allowances must remain available. This is an estimate, not an enforced usage
   or spending limit. The original two-hour daily average would exceed the budget
   at approximately ₹4,450 before taxes.
3. GitHub OIDC identity, environment settings and GHCR image access need setup
   before the workflow can deploy. No production credentials were uploaded.
4. Actual Sarvam account capacity has not been verified. Twenty dual-stream
   meetings require 40 available connections, rather than Starter's published
   allowance of 20.

## Remaining live checks

Azure provisioning, sustained two-hour WSS through Azure ingress, actual Sarvam
capacity, connector OAuth, Razorpay test-mode events, authenticated billing reads,
custom hostname TLS, desktop recording and DNS rollback remain unverified.
Mock tests, Bicep compilation and what-if do not establish those behaviours.
