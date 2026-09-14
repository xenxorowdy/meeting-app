# Local accounts and pricing setup

The desktop workspace is usable without signing in. Choose **Use it locally, no account** on the welcome screen. This keeps a configured local backend (or switches a remote connection to `http://127.0.0.1:48900`), clears the current connection token on this device, and remembers the local choice across launches. It does not copy remote meetings. Returning to welcome is available under **Workspace tools** or the account page.

Run `npm run dev` for desktop development. The standalone UI (`npm run start:ui`) needs the Rust backend (`npm run start:backend`) for meeting operations. Local mode still requires this local service. AI/transcription depend on the configured providers and may incur provider charges.

## Account database

`accounts.sqlite3` is created automatically beside the existing settings and credentials. Normally this is `apps/core-backend/.alpha-meeting-assistant/accounts.sqlite3` when launched by the workspace scripts. `ALPHA_DATA_DIR` changes the base directory; `CORE_BACKEND_DATA_FILE`, when supplied, takes precedence and uses that file's parent directory.

The database holds `accounts`, `sessions`, and a migration ledger. It uses unique emails, foreign keys, transactions, and hashed session tokens. Passwords retain the existing PBKDF2-HMAC-SHA256 format. Newly created passwords use 600,000 iterations in release builds; only debug builds allow `ALPHA_PBKDF2_ITERATIONS` to reduce test time. Password work runs on blocking workers with at most two concurrent jobs and a workspace-wide limit of 30 auth attempts per minute. The limiter resets when the backend restarts; an exposed service also needs a proxy rate limit.

Sessions expire after 30 days, with at most 20 per account. Logout is persisted before success is returned. Password changes require the current password and a valid session, revoke previous sessions, and issue a replacement. Auth/API responses use `Cache-Control: no-store`. On Unix the database is created with `0600` permissions; Windows deployment must restrict its data directory to the current OS user.

On first startup, existing `accounts.json` accounts and unexpired sessions are imported in one transaction. The original file is preserved. Invalid legacy data stops startup without committing a partial import. After a successful migration, subsequent starts use SQLite and never re-import old sessions. Meetings and provider credentials keep their existing storage formats.

To back up accounts, stop the backend and copy the database together with the rest of the workspace data to private backup storage. The preserved JSON is a migration backup, not a current account store: downgrading to a JSON-only binary would restore obsolete passwords and sessions. No migration was run against the user's live data during development; tests use temporary directories.

## Private workspace access

All accounts on one backend share that backend's meetings and settings. This implementation is suitable for a local/private workspace, not a public multi-tenant service. Signing in does not enable cloud sync or isolate each account's meeting library.

For a backend protected by `ALPHA_BACKEND_TOKEN`, registration requires that deployment token. An ordinary account session cannot create more accounts. Configure the owner's connection in **Connection & preferences** before creating an account; login remains available without presenting a deployment token. Do not distribute the owner token to untrusted users. Without a deployment token, the default loopback backend permits local registration and local use without an account.

Non-loopback binding retains the existing strong-token and origin requirements. Keep TLS in front of any remote instance, configure exact `ALPHA_ALLOWED_ORIGINS`, and provision separate workspace storage for separate customers. Account identity alone is not tenant isolation.

## Pricing

Open **Workspace tools → Plans & pricing**. The catalog is served by `GET /api/plans`:

| Plan | Current availability | Account | Price |
| --- | --- | --- | --- |
| Local | Available | Optional | Free |
| Pro | In development | Planned requirement | Unpublished by default |

To preview an intended Pro monthly price, set both backend environment variables:

| Variable | Accepted values |
| --- | --- |
| `ALPHA_PRO_MONTHLY_MINOR` | Positive integer in minor currency units, at most 100000000 |
| `ALPHA_BILLING_CURRENCY` | `INR`, `USD`, `EUR`, or `GBP` |

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
