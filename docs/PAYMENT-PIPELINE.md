# Payment pipeline verification

Checked on 2026-10-02. The local backend address supplied for this audit is
`http://127.0.0.1:48900/`.

## Verified configuration and data

- The configured Razorpay credentials are in **test mode**.
- The provider's configured plan is monthly INR 49,900 minor units (₹499).
- The existing active Pro row in Supabase resolves to an active Razorpay
  subscription on that same plan.
- Supabase's billing tables have RLS enabled. Authenticated clients can read
  their own subscriptions and cannot insert or update plans. Webhook events
  remain backend-only.
- A live database insert, update, and read-back check passed inside a rolled-back
  transaction. The test row was removed by rollback; no account was upgraded by
  this check.

## Current flow

1. The signed-in client asks its local backend for plans and checkout.
2. Checkout stores a pending provider subscription before opening Razorpay.
   Reopening a pending checkout reuses it.
3. Razorpay returns the payment ID, subscription ID, and signed payment proof.
   The client sends all three to its backend.
4. The backend validates the proof against the stored subscription and checks
   Razorpay's current state and configured plan. Only an active, unexpired Pro
   subscription grants Pro access.
5. In local provider mode, SQLite persists the verified entitlement and a
   durable queue mirrors it to the paying user's Supabase billing row. Failed
   identity matches and database writes stay queued. Confirmation also attempts
   the mirror immediately and reports `accountSynced`.
6. In a packaged cloud client, the local backend forwards billing requests to
   the relay using the user's renewable Supabase session. The relay commits
   subscription changes and payment acknowledgements to Supabase before replying.
7. The UI refreshes the plan after activation, when the window gains focus, and
   periodically while connected. Closing checkout does not interrupt activation.
   A failed confirmation exposes a status retry instead of another charge.
8. Signed subscription webhooks update renewals and cancellations. Provider
   reads reconcile delayed events; event receipts and updates are atomic.

## Repeatable validation

```bash
npm run test:billing
npm run test:backend
npm run test:cloud
npm run build:ui
```

With a **local disposable Postgres database** configured:

```bash
KESAMI_DISPOSABLE_POSTGRES_URL=postgres://postgres:password@127.0.0.1:5432/disposable npm run test:billing:db
```

The database tests cover paid-user mapping, persistence, duplicate confirmation,
renewals, cancellation, late events, database failure and retry, and reads from
a fresh database connection. Existing local subscriptions keep their verified
Supabase ownership when used from a hosted client. The hosted test refuses
external database hosts.
The Electron test covers checkout authorization, Pro display, the billing view,
confirmation retries, payment errors, dismissal, and sign-in gating. These use
isolated data and provider fixtures, with no real charge.

## Checks completed

- UI production build and Rust release build.
- Rust suite: 269 passed; the two database flows were also run explicitly on
  disposable Postgres, and passed. The optional embedding test that downloads
  a 487 MB model was not enabled.
- Focused client and release-configuration tests: 14 passed.
- Auth, desktop security, and database-connection integration checks: 27 passed.
  The optional live database test in that suite was not enabled; the live audit
  and rollback check above were run separately.
- Electron UI tests and manual inspection of the Free-to-Pro transition.

Rust checks used the installed Xcode 26.5 SDK through a command-scoped `SDKROOT`
because the Command Line Tools SDK did not match the installed linker. No
system settings were changed.

## Release work still required

The installed client configuration inspected during this audit has public
Supabase sign-in values but no `KESAMI_CLOUD_URL`. The localhost address cannot
serve billing to other customers or receive public provider webhooks.

Deploy the updated relay with server-only payment and Postgres credentials,
configure its public HTTPS webhook URLs, verify the public routes, and build the
desktop client with that HTTPS origin. Keep all private keys and database
credentials out of the DMG. The updated source and UI build do not update an
already installed app or its backend executable.

A real payment through Razorpay's checkout, public webhook delivery, Stripe
checkout, and an independently installed release client were not exercised in
this audit. Production charging additionally requires live-mode credentials and
a matching live-mode provider plan.
