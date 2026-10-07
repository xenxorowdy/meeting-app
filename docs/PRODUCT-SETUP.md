# Local accounts and pricing setup

Release builds (any build with `KESAMI_CLOUD_URL`, which release packaging requires) offer **Continue with Google** as the only way in, because hosted transcription and meeting AI run on the user's Supabase Google session. The backend reports this as `cloudManaged: true` in `GET /api/auth/config`, and the welcome screen hides email/password sign-in and **Connection & preferences** in that mode.

Development builds without a cloud URL keep email/password sign-in, Google sign-in when it is configured, and **Connection & preferences**, which opens the workspace without an account for that launch. An install that chose local use in an earlier version (`kesami.local-mode` in local storage) still opens the workspace directly. Returning to the welcome screen is available under **Workspace tools** or the account page.

If the local engine is unreachable while a saved session is being restored, the app keeps the session and retries instead of signing the user out.

Run `npm run dev` for desktop development. The standalone UI (`npm run start:ui`) needs the Rust backend (`npm run start:backend`) for meeting operations. Local mode still requires this local service. AI/transcription depend on the configured providers and may incur provider charges.

## Account database

`accounts.sqlite3` is created automatically beside the existing settings and credentials. Normally this is `apps/core-backend/.kesami/accounts.sqlite3` when launched by the workspace scripts. `KESAMI_DATA_DIR` changes the base directory; `CORE_BACKEND_DATA_FILE`, when supplied, takes precedence and uses that file's parent directory.

The database holds `accounts`, `sessions`, `google_identities`, and a migration ledger. It uses unique emails, foreign keys, transactions, and hashed session tokens. Passwords retain the existing PBKDF2-HMAC-SHA256 format. Newly created passwords use 600,000 iterations in release builds; only debug builds allow `KESAMI_PBKDF2_ITERATIONS` to reduce test time. Password work runs on blocking workers with at most two concurrent jobs and a workspace-wide limit of 30 auth attempts per minute. The limiter resets when the backend restarts; an exposed service also needs a proxy rate limit.

Sessions expire after 30 days, with at most 20 per account. Logout is persisted before success is returned. Password changes require the current password and a valid session, revoke previous sessions, and issue a replacement. Auth/API responses use `Cache-Control: no-store`. On Unix the database is created with `0600` permissions; Windows deployment must restrict its data directory to the current OS user.

On first startup, existing `accounts.json` accounts and unexpired sessions are imported in one transaction. The original file is preserved. Invalid legacy data stops startup without committing a partial import. After a successful migration, subsequent starts use SQLite and never re-import old sessions. Meetings and provider credentials keep their existing storage formats.

To back up accounts, stop the backend and copy the database together with the rest of the workspace data to private backup storage. The preserved JSON is a migration backup, not a current account store: downgrading to a JSON-only binary would restore obsolete passwords and sessions. No migration was run against the user's live data during development; tests use temporary directories.

## Private workspace access

All accounts on one backend share that backend's meetings and settings. This implementation is suitable for a local/private workspace, not a public multi-tenant service. Signing in does not enable cloud sync or isolate each account's meeting library.

For a backend protected by `KESAMI_BACKEND_TOKEN`, registration requires that deployment token. An ordinary account session cannot create more accounts. Configure the owner's connection in **Connection & preferences** before creating an account; login remains available without presenting a deployment token. Do not distribute the owner token to untrusted users. Without a deployment token, the default loopback backend permits local registration and local use without an account.

Non-loopback binding retains the existing strong-token and origin requirements. Keep TLS in front of any remote instance, configure exact `KESAMI_ALLOWED_ORIGINS`, and provision separate workspace storage for separate customers. Account identity alone is not tenant isolation.

## Google account sign-in

The desktop welcome screen creates a Google account on the first authorized sign-in and returns to that account on later sign-ins. The system browser uses OAuth authorization code + PKCE with `openid email profile` only. Electron receives a one-time code; the backend exchanges it with Google, verifies the signed ID token (including audience, issuer, expiry, verified email, and the attempt's nonce), and issues an ordinary Kesami session. Google Calendar permission is separate.

Create a Google Cloud OAuth consent screen and a client of type **Desktop app**. Add your Google account as a test user while the consent screen is in testing. Set the client ID in **Settings → Calendar → Google client id**, or set `KESAMI_GOOGLE_OAUTH_CLIENT_ID` on the backend. The same Desktop client ID can be used for Calendar and account sign-in. If Google requires the issued client secret for token exchange, save it in **Settings → Calendar → Google client secret**, or set `KESAMI_GOOGLE_OAUTH_CLIENT_SECRET` on the backend. The backend also checks the corresponding Calendar environment variables. The secret stays in backend credentials and is never sent to the UI.

Google account creation follows the same owner-token rule as password registration. A returning Google identity can sign in without the owner token. Accounts are bound to Google's stable subject identifier; an existing password account with the same email is not automatically linked, and Google sign-in reports the collision. Google-only accounts manage their password at Google. Standalone Vite UI in a normal browser does not provide this desktop loopback flow.

`GET /api/auth/config` reports the configured public client ID. `POST /api/auth/google` accepts the desktop flow's one-time code, PKCE verifier, loopback redirect, and nonce; it returns the same session grant shape as password sign-in. Neither Google's token nor the authorization code is persisted in the account database.

## Pricing

Open **Workspace tools → Plans & pricing**. The catalog is served by `GET /api/plans`:

| Plan | Current availability | Account | Price |
| --- | --- | --- | --- |
| Local | Available | Optional | Free |
| Pro | In development | Planned requirement | Unpublished by default |

To preview an intended Pro monthly price, set both backend environment variables:

| Variable | Accepted values |
| --- | --- |
| `KESAMI_PRO_MONTHLY_MINOR` | Positive integer in minor currency units, at most 100000000 |
| `KESAMI_BILLING_CURRENCY` | `INR`, `USD`, `EUR`, or `GBP` |

For example, `99900` and `INR` display a **planned** ₹999/month price. This is an illustration, not a chosen commercial price. Missing or invalid configuration displays **Price to be announced**. No price is stored in ordinary user settings, and no payment secrets are needed for the catalog.

Checkout stays disabled even when a price is configured. `POST /api/billing/checkout` returns 503, Pro is marked **Coming soon**, and the Rust settings view hides unsupported license activation. No subscription, managed AI quota, cloud sync, or payment collection is claimed or enabled.

A paid launch still requires a provider decision and integration: verified checkout/subscription webhooks, durable customer/subscription/event records, idempotency, cancellation and refund handling, entitlement enforcement, a billing portal, and end-to-end sandbox payment tests. Email verification/recovery, tenant isolation, deployment operations, signed installers/updates, and live device recording validation also remain launch work. This change does not certify the whole app as production ready.

## Verification

```sh
npm run test:backend
npm run test:auth
npm run build:ui
node_modules/.bin/electron test/ui-design/render.cjs
```

Tests use temporary databases. They cover JSON migration, failed-write rollback, permissions, registration/login, duplicate emails, expiry, session limits, logout/restart, password rotation, registration access control, anonymous local APIs, pricing validation, and disabled checkout. The Electron harness checks local-mode persistence with the backend offline, account/password UI, pricing in light/dark themes, and responsive layout.

The database and password choices follow [SQLite transaction semantics](https://www.sqlite.org/lang_transaction.html), [SQLite foreign key guidance](https://www.sqlite.org/foreignkeys.html), and [OWASP's PBKDF2-HMAC-SHA256 guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
