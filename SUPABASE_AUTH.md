# Desktop Google sign-in through Supabase

Google provider credentials are configured in Supabase, using a Google **Web
application** OAuth client. Google's authorized redirect URI for this project is:

```text
https://uidcdqlfuugdprjqeprx.supabase.co/auth/v1/callback
```

In Supabase **Authentication → URL Configuration → Redirect URLs**, add:

```text
http://127.0.0.1:*/auth/callback/**
```

Electron opens the system browser and listens on a random IPv4 loopback port.
Each attempt has a random callback path and a fresh PKCE verifier. The allowlist
above permits that return to the desktop. Google's redirect URI remains the
Supabase callback, even during local desktop development. A website Site URL does
not replace the desktop redirect allowlist; this flow explicitly sets `redirect_to`.

## Local backend configuration

The Rust backend loads `apps/core-backend/.env.local` when launched by Electron or
the backend npm scripts. It does not load `.env`. Set these values in that ignored
file, or provide them through the process environment, which takes precedence:

```dotenv
KESAMI_AUTH_PROVIDER=supabase
KESAMI_SUPABASE_URL=https://uidcdqlfuugdprjqeprx.supabase.co
KESAMI_SUPABASE_PUBLISHABLE_KEY=<your-project-publishable-key>
```

The Google client secret stays in the Supabase dashboard. No Google Desktop
client ID, database password, service-role key, or frontend environment variables
are required for this sign-in flow. The existing Calendar connection remains a
separate integration. `KESAMI_SUPABASE_JWKS_URL` is not used: the backend verifies
the Supabase access token through the project's Auth `/user` endpoint.

For a distributable macOS app, copy `apps/ui/.env.example` to the ignored
`apps/ui/.env` and set those three public sign-in values before running
`npm run dist:mac`. The packaging step validates them and includes only the
project URL and publishable key in the app. It does not include the backend's
development `.env.local` or its unrelated credentials. Recipients can sign in
without configuring a Google Desktop client ID.

An installation can override the bundled settings by putting the three backend
settings in `~/Library/Application Support/Kesami/.env.local` and restarting
Kesami. Keep that local file readable only by its owner.

Rebuild and fully relaunch Electron after changing its main process or backend:

```sh
npm run build:all
npm run start:app
```

`GET /api/auth/config` should contain `googleAuth.provider: "supabase"` and
`googleAuth.configured: true`. The response never includes the publishable key.
An old backend process must exit before the rebuilt backend can take its port.

## Session and account behavior

### Optional public.users profiles

The backend can create a private `public.users` profile for each verified Google
sign-in. Supabase Auth still creates `auth.users`; the app never inserts into that
managed table directly.

From the repository root, run the explicit backend migration:

```sh
npm run --prefix apps/core-backend migrate:users
```

This command needs an owner database connection through `KESAMI_SUPABASE_DB_URL`
(the Supabase pooler connection string also works), or `KESAMI_SUPABASE_URL` plus
`KESAMI_SUPABASE_DB_PASSWORD`, in the backend process environment or `.env.local`.
The explicit migration command also reads `.env` as a fallback; the normal
desktop server continues to load only `.env.local`.
It creates the table, foreign key to `auth.users`, and row-level security rules
inside one transaction. Re-running it is safe. An existing unrelated
`public.users` table causes the command to stop without changing it.

After applying the migration, set `KESAMI_SUPABASE_SYNC_USERS=true` in the backend
`.env.local` and restart the backend. New sign-ins insert a profile; repeat
sign-ins update its name, email, and `updated_at` using the Supabase user ID.
The creation timestamp is preserved. Re-running the migration inserts missing
profiles for existing Google Auth users with an email and fills blank names
from Google identity data. It preserves nonblank profile names. A later sign-in
refreshes the name and email.

Profile requests run in Rust using the signed-in user's access token and the
publishable key. Users can access only their own row. Profile fields are not
authorization claims. Database credentials are needed to run the migrations and,
on the backend that processes payments, to copy billing into Supabase; do not
distribute them with the desktop app. The profile write must succeed
before a local session is issued when synchronization is enabled.

### Billing tables

Supabase Auth owns `auth.users`; app billing records live in `public.billing`
and `public.billing_events`, with `public.billing.user_id` referencing
`auth.users(id)`. Apply the billing migration explicitly with an owner database
connection:

```sh
npm run --prefix apps/core-backend migrate:billing
```

The command reads the same database settings as `migrate:users`. It creates
both tables in one transaction and refuses to adopt unrelated existing billing
tables. Signed-in users can read only their own subscription rows; neither
anonymous nor signed-in clients can write provider status or webhook events.
These rows are for verified payment-provider updates, never client-reported
plan changes.

When the backend has an owner database connection, it copies billing into
these tables after each payment event:

- Every verified Stripe or Razorpay webhook is recorded in `public.billing_events`
  with the time the backend received it.
- Every subscription change, whether from a webhook or from the Razorpay
  confirmation the app requests right after Checkout, is upserted into
  `public.billing` for the payer's Supabase user. That user is found through the
  account's Google identity in `auth.identities`. A cancelled subscription stays
  cancelled, and a late pre-activation event never replaces an active one.
- Subscriptions for accounts without a Supabase Google identity, such as local
  password accounts, stay local only.

The copy runs in the background, right after each payment event, every five
minutes, and on startup, so webhook responses never wait for Supabase. If Supabase
is unreachable or the billing migration is missing, the rows stay pending in
`billing.sqlite3` and are copied on a later pass; nothing is lost across
restarts. The first pass after upgrading also copies subscriptions recorded
before this existed. The local `billing.sqlite3` still decides who has Pro;
Supabase holds a copy.

### Local sessions

1. Electron opens Supabase `/auth/v1/authorize` with Google and PKCE.
2. Google returns to Supabase, which returns a one-time code to Electron.
3. The UI forwards only the code and verifier to `/api/auth/supabase/google`.
4. Rust exchanges the code with Supabase and verifies the access token using
   `/auth/v1/user`. It requires a Google provider identity with a verified email;
   editable user metadata is never used as identity proof.
5. The verified Google subject maps to the existing local account. Rust issues
   the same 30-day local session used by the rest of the desktop app.

This is Supabase-backed Google sign-in with a local desktop session. Supabase
access/refresh tokens are not persisted or sent to the renderer. Logout revokes
the local app session; it does not globally sign out Supabase or Google. Deleting
or banning a Supabase user does not revoke an already issued local session.
Signing in again requires network access. Existing local sessions and anonymous
local use continue to work offline.

An existing direct-Google account keeps its local ID because its Google subject
stays the same. Matching email alone never links accounts; an existing password
account still requires its password. Owner authorization is still required to
create accounts on a backend protected by a deployment token. Meetings remain in
the existing shared local library; this does not introduce per-user storage.

## Verification

```sh
npm run test:backend
npm run test:auth
node --test test/google-desktop-auth.test.js
npm run build:ui
```

Automated tests use fake Auth responses and real loopback callbacks. Complete one
Google sign-in in the desktop to verify the live Google consent, Supabase redirect
allowlist, account creation, restart persistence, and logout together.

References: [Supabase Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google),
[redirect allowlists](https://supabase.com/docs/guides/auth/redirect-urls),
[PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow).
