# AGENTS.md

## Working Style

- Keep changes small and behavior-first.
- Start from the local source of truth: `index.html`, `server.js`, `package.json`, and `shared-data.json`.
- Protect unrelated local changes. Do not overwrite user work.
- Prefer concise updates and practical verification over broad refactors.

## Project Shape

- This repo now has two parts: the UI in `index.html` and the API in `server.js`.
- `shared-data.json` is runtime state, not source code. Treat its shape carefully.
- `package.json` only wires `start` and `dev`; there is no build step.

## How It Runs

- The API starts with `npm start` or `node server.js`.
- The server listens on `PORT` and defaults to `3000`.
- `npm run dev` currently aliases `npm start`.
- `.env.example` documents the expected local env shape: `PORT` and `NODE_ENV`.
- The UI can still be opened directly from `index.html`, but that path does not exercise the API.
- If you need the full app behavior, run the server rather than opening the HTML file directly.

## Backend Endpoints

- `POST /api/schedule` generates a schedule, QR code, and archive entry.
- `POST /api/schedule/share` marks an archived schedule as current.
- `GET /api/data` returns current schedule, players, and court location.
- `GET /api/schedule/:code` fetches an archived schedule by code.
- `POST /api/profiles` saves players and court location.

## Frontend Behavior

- The scheduler UI is self-contained in one file, including CSS and JavaScript.
- The core behaviors are fair sit-out rotation, 2v2 doubles with 1v1 singles overflow, conflict-group avoidance for same-team pairings, and schedule extension by 5 rounds.
- There is a demo helper in the UI that can append fake players for presentations or screen recordings.
- The main state lives in browser memory, so refreshes reset the UI state.

## Verification

- For frontend-only edits, do a quick browser check of the changed behavior.
- For `server.js` changes, prefer a syntax check plus a local run:
- `node -c server.js`
- `npm start`
- If you change JSON persistence, verify the saved file still loads with the existing schema.

## Render Notes

- The repo already has a deployed static site.
- If the app is meant to use `server.js` in production, deploy it as a Render web service instead of a static site.
- If only the UI is being published, keep the service aligned with `index.html` and the repo root.
