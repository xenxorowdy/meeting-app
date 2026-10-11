# Kesami website

The marketing site for Kesami, meeting memory for macOS and Windows: a static homepage, privacy policy and terms built with Next.js 16 (App Router).

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build of /, /privacy, /terms, icon and share image
npm run typecheck
```

It is a standalone package on purpose: it sits outside the `apps/*` npm workspaces, so the desktop
release workflow's root `npm ci` and the root lockfile are unaffected by its dependencies.

## Deploying

Any static-capable Next.js host works (Vercel needs no configuration; set the project root to
`website`). The default public origin is `https://kesami.online`. Set `SITE_URL` to override it;
for production, use `https://kesami.online` so generated share image URLs use the public domain.

For Google OAuth branding, use `https://kesami.online/` as the homepage,
`https://kesami.online/privacy` as the privacy policy and `https://kesami.online/terms` as the terms.
Add `kesami.online` under Authorized domains and verify ownership in Google Search Console
using an account that is an owner or editor of the Google Cloud project. Verify and publish
branding before submitting sensitive Calendar scopes for data access verification.

## Type

The whole page is set in **Inter**, falling back to `'Mona Sans', 'Helvetica Neue', Helvetica, Arial,
sans-serif`. `next/font` downloads Inter at build time and serves it from this site, so visitors never
make a request to Google Fonts.

## Where the facts come from

Everything the page states about the product is copied from the app, and `lib/site.ts` names the
source of each value: prices from `apps/core-backend/src/plans.rs`, platforms from
`apps/desktop/package.json` (`build.mac`: Apple silicon, macOS 13+; `build.win`: x64 NSIS), languages from
`apps/ui/src/components/SettingsModal.jsx`, and the download links from the `kesami-releases` repository
that `.github/workflows/release.yml` publishes to. Both buttons link straight to the file:
`releases/latest/download/Kesami-arm64.dmg` and `releases/latest/download/Kesami-Setup-x64.exe`, which
only resolve once the latest release carries those names, so publish the release before deploying the site. Update them together when the app changes.

The product mocks all read one fictional account in `lib/demo.ts`. Their shapes copy the app: a brief's
sections, decisions and next steps from `apps/core-backend/src/summarizer.rs`, Ask's numbered sources from
`apps/ui/src/components/MeetingChatPanel.jsx`, the send-to tools from `apps/core-backend/src/connectors.rs`,
and the shortcuts from `apps/ui/src/App.jsx`. Two things on the page are labelled concepts because the app
doesn't do them yet: the cross-meeting open-commitments view, and reminders or calendar events as follow-up
actions. The privacy section's data boundary follows `docs/HOW-KESAMI-WORKS.md` and `CLOUD_TRANSCRIPTION.md`.
