# Meeting App Agent Guide

## Project overview

This repository is an npm workspace for the Alpha desktop meeting assistant.

- `apps/ui`: React 19, Vite, Tailwind CSS, and Shadcn-based interface.
- `apps/desktop`: Electron shell, recording integration, and backend lifecycle.
- `apps/core-backend`: Rust HTTP/WebSocket backend. A legacy Node.js implementation remains for compatibility tests.
- `test`: Cross-application and end-to-end tests.

The Rust backend listens on `127.0.0.1:48900` by default. Keep the UI/backend API contract backward-compatible when changing either side.

## Common commands

Run commands from the repository root unless noted otherwise.

```bash
npm run dev                 # Electron development flow
npm run start:ui            # Vite UI only
npm run start:backend       # Rust backend only
npm run build:all           # Build UI and backend
npm run test:backend        # Rust backend tests
npm run --prefix apps/core-backend test:legacy
```

Prefer the narrowest relevant build or test while iterating, then run broader verification when a change crosses application boundaries.

## Working conventions

- Preserve existing user changes. The worktree may intentionally be dirty.
- Use `rg` and `rg --files` for repository searches.
- Keep frontend network access centralized through the existing backend client utilities.
- Keep long-running or platform-specific work out of the React render path.
- Do not silently change persisted API payloads, event names, or meeting-storage formats.
- Add or update tests for behavior changes, especially recording paths, backend routes, and summary-provider logic.
- Do not edit generated build output or dependency directories.

## Credentials and local data

- Never commit API keys or print them in logs, test output, or responses.
- Gemini and Sarvam credentials are stored locally in `apps/core-backend/.alpha-meeting-assistant/credentials.json` and must remain ignored by Git with owner-only permissions.
- The backend also accepts `ALPHA_GEMINI_API_KEY` and `ALPHA_SARVAM_API_KEY` as environment overrides.
- Treat files under `.alpha-meeting-assistant` as user data. Do not delete or overwrite them unless the task explicitly requires it.

## Validation expectations

For UI changes, run the UI build and the closest relevant tests. For Rust backend changes, run `npm run test:backend`. For Electron or full-flow changes, validate both the backend and UI build and run the applicable integration tests. Report any checks that could not be run and why.
