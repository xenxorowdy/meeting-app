<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Kesami website

Marketing site for the Kesami desktop app in `../apps`. Static Next.js App Router page, no backend.

- Product claims must match the app. Prices, plan features, platform and languages live in `lib/site.ts`, each
  with the source file it was copied from; check that file before changing a number. Kesami ships for macOS
  (Apple silicon) and Windows (x64); never position it as Mac-only, and never put OS branding ahead of what the
  product does. Contact details (email and phone) live in `CONTACT` in `lib/site.ts` and appear in the footer. Copy must not promise Intel Mac or Windows-on-Arm builds,
  auto-update, or the Chrome extension (it is only installable unpacked from source).
- Positioning (2026-10-06 brief): Kesami is meeting memory and follow-through, not "AI meeting notes" and not
  better transcription. Anything the app does not do yet (cross-meeting commitment tracking, actions beyond what
  the connectors and the follow-up email do) is shown as a labelled product concept, never as shipped.
- Type: Inter everywhere, headlines included, via `next/font/google` in `app/layout.tsx` (`--font-sans`), with
  `'Mona Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif` as the fallback stack (`--font-ui` in
  `app/globals.css`). `--font-display` is the same stack; it stays a separate token so headlines can change alone.
- Shared scenario: every product mock (hero brief, memory chain, commitments, Ask, the follow-through tour,
  the privacy folder, the desktop windows) reads `lib/demo.ts`, one fictional Acme account, so they agree.
  Mocks copy the app's real UI shapes; change the data there, not in a component.
- Colour: components use the semantic tokens in `app/globals.css` (`--bg`, `--fg`, `--accent` …) and a
  section sets `data-theme="light" | "paper" | "tint"` (Canvas, white, orange tint). The page is light by
  decision; `dark` is only for the product mocks, which copy the app's dark UI. Orange (#ff5e00) is the only
  signal colour: filled buttons (with Ink labels), link underlines, decorative borders, and accent text on its
  10% tint, darkened on light backgrounds until it passes contrast.
- Sections are server components. Client code is limited to small islands (`AskDemo`, `CurrencyToggle`,
  `NavMenu`, `WaveFloor`, `StepObserver`, `RevealObserver`) that write DOM attributes or CSS
  variables instead of re-rendering on scroll or pointer movement.
- Accessibility rules the design review (2026-10-03) settled: text sizes are rem so the reader's browser text
  size applies (the app mocks stay px, as stand-ins for screenshots); dimmed text recedes by colour, never
  by opacity, so it keeps 4.5:1; touch targets get 44pt under `(pointer: coarse)`. There is deliberately no
  "pause animations" control — Riyam declined one; looping motion stops only for `prefers-reduced-motion`.
