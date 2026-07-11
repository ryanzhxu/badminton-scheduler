# AGENTS.md

## Working Style

- Keep changes small and behavior-first.
- Start from the local source of truth: `index.html`, `server.js`, `worker/`, `package.json`, `shared-data.json`, and `worker/wrangler.toml`.
- Protect unrelated local changes. Do not overwrite user work.
- Prefer concise updates and practical verification over broad refactors.

## Project Shape

- The UI lives in `index.html`.
- Local Node API compatibility still lives in `server.js`.
- The deployed API also has a Cloudflare Worker implementation under `worker/`; keep the Node and Worker paths behaviorally aligned.
- `shared-data.json` is runtime state for the Node path, not source code. Treat its shape carefully.
- `worker/wrangler.toml` is the Worker config and holds the Worker env/binding setup.
- `package.json` only wires `start` and `dev`; the Worker has its own `worker/package.json` scripts.

## How It Runs

- The API starts with `npm start` or `node server.js`.
- The server listens on `PORT` and defaults to `3000`.
- `npm run dev` currently aliases `npm start`.
- `.env.example` documents the expected local env shape: `PORT`, `NODE_ENV`, and any Worker-facing flags mirrored for local dev.
- The UI can still be opened directly from `index.html`, but that path does not exercise the API.
- If you need the full app behavior, run the server rather than opening the HTML file directly.

## Backend Endpoints

- `GET /health` and `GET /api/health` return a simple live status payload.
- `POST /api/schedule` generates a schedule, QR code, and archive entry.
- `POST /api/schedule/share` marks an archived schedule as current.
- `GET /api/data` returns current schedule, players, and court location.
- `GET /api/schedule/:code` fetches an archived schedule by code.
- `POST /api/profiles` saves players and court location.

## Frontend Behavior

- The scheduler UI is self-contained in one file, including CSS and JavaScript.
- The core behaviors are fair sit-out rotation, 2v2 doubles with 1v1 singles overflow, conflict-group avoidance for same-team pairings, and schedule extension by 5 rounds.
- There is a demo helper in the UI that can append fake players for presentations or screen recordings.
- When a rotation is generated or extended, the UI immediately publishes the exact schedule to the Node API and shows a share QR/code card.
- The main state lives in browser memory, so refreshes reset the UI state.

## Verification

- For frontend-only edits, do a quick browser check of the changed behavior.
- For `server.js` changes, prefer a syntax check plus a local run:
  - `node -c server.js`
  - `npm start`
- For `worker/` changes, prefer:
  - `cd worker && npm run check`
  - `cd worker && npm run dev`
- If you change JSON persistence, verify the saved file still loads with the existing schema.

## Render Notes

- The deployed API is the Cloudflare Worker under `worker/`; keep `worker/wrangler.toml` and `worker/src/index.js` aligned with live behavior.
- If only the UI is being published, keep the frontend host aligned with `index.html` and the repo root.
