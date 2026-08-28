# AGENTS.md

This file is the canonical guidance for any coding agent (Claude Code, Codex, or otherwise) working in this repo. See `CLAUDE.md` for a short pointer back here, and see `REFACTOR.md` for the deploy shape, the frozen production contracts, and the current refactor plan — read it before touching anything deploy-related.

## Working Style

- Keep changes small and behavior-first.
- Start from the local source of truth: `index.html`, `server.js`, `worker/`, `package.json`, `shared-data.json`, and `worker/wrangler.toml`.
- Protect unrelated local changes. Do not overwrite user work.
- Prefer concise updates and practical verification over broad refactors.

## Project Overview

**Badminton Rotation Scheduler** is a full-featured single-page app (SPA) in `index.html` plus an Express API in `server.js`. It generates fair rotation schedules for badminton matches, then immediately publishes a shareable QR code through the backend. The app features:
- **Fair rotation**: minimizing variance in sit-out counts across players
- **Team fairness**: partner *and* opponent variety (repeat pairings are penalized by how often a pair has already met, and back-to-back rematches cost extra, so nobody gets stuck facing the same person all night), conflict rules to prevent specific players from being on the same team (this does not prevent conflicted players from playing on the same court as opponents — e.g. if A and C conflict, A+B vs. C+D is fine, they just can't be teammates)
- **Player assignment**: 2v2 doubles matches with 1v1 singles for overflow
- **Extensible schedules**: add more rounds on demand via server or client
- **Internationalization**: 6 languages (English, Simplified Chinese, Traditional Chinese, Korean, Hindi, Filipino) with live switching
- **Dark mode support**: theme toggle persisted to localStorage
- **Share & persistence**: generate QR codes to share exact schedules; server archives and can reload them; live sync pushes updates (e.g. extended rounds) to other viewers on the same share code

## Project Shape

- The UI lives in `index.html`. Local Node API compatibility lives in `server.js`.
- The deployed API also has a Cloudflare Worker implementation under `worker/src/index.js`; keep the Node and Worker paths behaviorally aligned — see "Deployment Targets" below for which one is actually live.
- `shared-data.json` is runtime state for the Node path, not source code. Treat its shape carefully.
- `worker/wrangler.toml` is the Worker config and holds the Worker env/binding setup.
- `package.json` wires `start`, `dev`, `test` and `check`; there is no build step and no runtime dependency needed to run the tests. The Worker has its own `worker/package.json` scripts.
- **No frontend dependencies**: pure HTML, CSS, JavaScript — no build step, no npm packages in the SPA.
- **Backend stack**: Express + QRCode + dotenv + cors (minimal, production-ready).
- **Persistent data**: the Node path stores all schedules in `shared-data.json` (auto-created, excluded from git); the Worker path stores schedules/registry/index in Cloudflare KV.

## How It Runs

- The API starts with `npm start` or `node server.js`.
- The server listens on `PORT` and defaults to `5000` (matches `index.html`'s local-dev `API_BASE` target of `http://localhost:5000`).
- `npm run dev` currently aliases `npm start`.
- `.env.example` documents the expected local env shape: `PORT`, `NODE_ENV`, and any Worker-facing flags mirrored for local dev.
- The UI can still be opened directly from `index.html`, but that path does not exercise the API.
- If you need the full app behavior, run the server rather than opening the HTML file directly.
- Alternative local run for the UI only: `python3 -m http.server 8000`, then visit `http://localhost:8000`.

## Architecture

The app is a **single-file, self-contained SPA** with three integrated layers, plus a backend (Express and/or Cloudflare Worker):

### 1. HTML Structure
- Header with title and settings buttons (theme, language, tabs)
- Tab interface: Setup, Schedule, Check-in, Leaderboard
- **Setup pane**: courts input, player management (add/bulk import/demo injection), conflict picker, generate button
- **Schedule pane**: round navigation, court grid, sit-out banner, QR share card, constraint validation panel — kept deliberately minimal; per-player stats live only on the Leaderboard tab, not here
- **Check-in pane**: per-player attendance status (Not arrived/Playing/Left), a global "Edit names" toggle covering every chip at once, an always-visible "+ Add player" row for late arrivals
- **Leaderboard pane**: cross-session stats table (games, sits, sessions, unique partners/opponents) per canonical player, backed by `GET /api/leaderboard` (Worker only)
- **Internationalization**: all user-facing text via `data-i18n` attributes; UI auto-translates on language switch

### 2. CSS Styling
- CSS variables for teal/green palette: `--p` (primary), `--ph` (primary highlight), `--ia` (interactive), `--ok`, `--er` (error), `--wa` (warning), etc.
- Dark mode support: `.dark-mode` class flips text/background colors via CSS custom properties
- Responsive grid for courts: 1–3 columns depending on court count
- Reusable classes: `.card` (container), `.btn-p`/`.btn-s` (primary/secondary buttons), `.pchip` (player chip), `.cx` (conflict chip), `.vrow` (validation row)
- Tables for stats, proper icon sizing with Tabler icons

### 3. JavaScript Logic
**State** (all in global scope):
  - `rawPlayers`, `conflictGroup` (Set), `schedule`, `sitC` (sit-out counts), `pairHistory` (`{partners, opponents, lastOpponents}` — see "Pairing variety" below)
  - `currentLanguage`, `currentLayout`, `currentNc`, `currentRound`
  - QR-related: `currentShareCode`, `currentShareUrl`, `currentQrDataUrl`, `qrSyncToken` (race-condition prevention)
  - Live sync: `currentScheduleRevision`, `currentScheduleStream` (an `EventSource`), `currentScheduleStreamCode`
  - Check-in: `attendance` (per-player status), `demoPlayers` (Set, excludes demo players from the leaderboard/registry)
  - `i18n` object: 6 language branches (en, zh-s, zh-t, ko, hi, fil) with 100+ keys each — Thai (`th`) was added, then removed; do not reintroduce without a fresh instruction

**i18n System**:
  - `i18n` = object with language keys mapping to term dictionaries
  - `t(key, vars)` = lookup + template substitution (e.g., `t('roundOf', {round: 1, total: 10})` → "Round 1 of 10")
  - `translateUI()` = crawl DOM for `data-i18n` attributes and update text/placeholder/title based on `currentLanguage`
  - `setLanguage(lang)` = switch language, save to localStorage, re-render UI + schedule

**Theme & Settings**:
  - `toggleTheme()` / `setTheme(t)` = add/remove `.dark-mode` on body, update icon, persist to localStorage
  - `loadSettings()` = on load, restore saved theme and language from localStorage

**Input Processing**:
  - `parseRawName()` — strips email addresses and role suffixes (e.g., "- Organizer")
  - `computeDisplayNames(list)` — auto-abbreviates to first name or first + last initial if collision exists
  - `parseBulk()` (client) / server-side processing in `/api/profiles` (server)

**Layout Algorithm** (`getLayout(n, nc)`):
  - Given `n` players and `nc` courts, compute court breakdown: doubles (4 per), singles (2 per), subs
  - Greedy search: iterate `s` from 0 up, prefer minimal substitutions
  - Example: 13 players, 3 courts → 3 doubles + 1 sub per round

**Scheduling** (`generateRounds()`, `buildRoundCourts()`):
  - For each round: shuffle players, sort by sit-out count, extract `layout.subs` lowest-count players
  - `buildRoundCourts()`: deterministic clique-first greedy matching (see "Key Algorithms" below) — no random-restart search
  - Repeat pairings are discouraged via `pairHistory` cost, not a hard "used team" exclusion — see "Pairing variety" below
  - Fair rotation: ensures sit-out count variance ≤ 1 (optimal fairness)

**Display**:
  - `renderSchedule()` — show current round's courts with dynamic grid columns; also calls `renderValidation()` and `renderCheckIn()`
  - `renderValidation()` — constraint panel (conflicts, repeats, sit-out fairness, summary)
  - `loadLeaderboard()` — fetches `GET /api/leaderboard` and renders the cross-session stats table (games, sits, sessions, unique partners/opponents) on the Leaderboard tab; this replaced an earlier per-schedule stats table that used to live on the Schedule pane
  - All text driven by `i18n` keys

**Share & Sync**:
  - `syncShareQr()` = POST to `/api/schedule`, receive QR data URL and share code, display immediately
  - QR link includes share base URL (handles file:// → production URL swap)
  - `shareSchedule()` = call `/api/schedule/share` to mark schedule active, show confirmation
  - `loadScheduleFromCode(code)` = fetch `/api/schedule/:code`, reload players + schedule + stats
  - `applyScheduleSnapshot()` = apply a fetched/streamed schedule snapshot to local state, optionally preserving the viewer's current round
  - Live sync opens an `EventSource` against `/api/schedule/:code/stream` so all viewers on the same share code receive pushed updates (e.g. another user extending the schedule) without polling; each viewer stays on their current round index rather than jumping to the end

**Conflict & Team Validation**:
  - `conflictPair(a, b)` — returns true if both players in `conflictGroup`
  - `teamOk(t)` — rejects a team (one side of a court) if any pair within it has a conflict; this is only ever evaluated per-side, never across the two teams sharing a court, so conflicted players can face off as opponents, just not partner up
  - `teamKey(t)` — canonical team ID (sorted player names joined by `|`), used by `renderValidation()` to flag an exact team repeated across rounds

## Key Algorithms

**Layout computation** (`getLayout(n, nc)`, in both client and server):
- Given `n` players and `nc` courts, determine the court configuration that fits all players fairly
- Strategy: prefer full doubles courts (4 per) + minimal singles (2 per) + few subs
- Greedy search: iterate substitution counts `s` from 0 up; return first valid configuration
- Example: 13 players, 3 courts → 3 doubles (12 in play) + 1 sub per round
- If no perfect fit exists, falls back to maximizing doubles with overflow subs

**Team generation via clique-first greedy matching** (`buildRoundCourts`, `matchPartnersRespectingConflicts`, `greedyMatch`):
- **History (Aug 2026)**: the algorithm used to be a stochastic search — `MAKE_TEAMS_ATTEMPTS` (600) random shuffles, scored by conflict violations (×1000, to dominate everything else) plus `repeatCost()`, keeping the best of the batch. That constant was never tuned against a benchmark; it was a fixed literal since the project's very first commit and only ever rationalized after the fact. It was replaced with a deterministic construction that both guarantees zero conflict violations (when mathematically feasible) and minimizes partner/opponent repeats directly, instead of hoping enough random attempts stumble onto a good one.
- **`greedyMatch(items, costFn)`**: a generic greedy minimum-cost perfect matching over an even-length list. Builds every candidate pair, shuffles first (so equal-cost ties vary run to run), stable-sorts by cost ascending, then greedily accepts the cheapest pair whose both items are still free. Not a guaranteed-optimal assignment (true optimality needs a full blossom algorithm), but effective for our small squared costs and runs once instead of hundreds of random restarts.
- **`matchPartnersRespectingConflicts(activePl, hist, conflictGroup)`**: the single global conflict group behaves like one "no two of these may be teammates" clique. This function matches clique members to non-clique partners *first*, while non-clique supply is still plentiful, which is what actually guarantees zero conflict violations whenever a valid pairing exists (a plain unconstrained greedy pass can paint itself into a corner and force an avoidable violation purely from bad candidate-order luck). A violation is only possible when the clique is larger than half the active doubles pool (`k > n/2`) — genuinely infeasible to avoid, not an algorithm bug.
- **`buildRoundCourts(activePl, layout, hist, conflictGroup)`**: splits the shuffled active pool into the singles slots and the doubles pool; runs `matchPartnersRespectingConflicts` on the doubles pool to form partner-pairs; then runs `greedyMatch` again on those partner-pairs (cost = summed cross-pair opponent-repeat cost) to decide which pairs face each other on a court, and separately on the singles pool (cost = opponent-repeat cost directly, since singles has no partners and no conflict restriction) — layering the same opponent-variety cost function from the old scoring on top of the deterministic partner construction.
- **No skill-based balancing**: an earlier skill-tier feature (rate players Beginner/Intermediate/Advanced, balance court totals) was removed (Aug 2026) in favor of relying solely on team conflicts for fairness — see "Conflict & Team Validation" above. Do not reintroduce a skill field without re-adding the removed UI, i18n keys, and `playerSkills` plumbing across all three copies.

**Pairing variety** (`pairHistory`, `recordRound`):
- `createPairHistory()` returns `{ partners: Map, opponents: Map, lastOpponents: Set }`, counting how many times each pair has been teammates and how many times they have faced each other. It is derived state — never persisted in the schedule JSON — and is rebuilt by replaying rounds (`rebuildSchedulingState()` in the SPA, and the extend handlers in both backends).
- Cost per pair is **squared** in the number of prior meetings (`n² × REPEAT_PARTNER_WEIGHT` for teammates, `n² × REPEAT_OPPONENT_WEIGHT` for opponents), fed straight into the `greedyMatch` cost functions above. Squaring matters: a flat/binary penalty stops discriminating once every combination has been used once.
- Facing the same opponent in the immediately preceding round costs an extra `CONSECUTIVE_OPPONENT_WEIGHT`, because a back-to-back streak is what players actually notice and report. Locked in by `tests/scheduling.test.js`.

**Fair sit-out rotation** (`sitC` tracking):
- Before each round, sort shuffled players by current sit-out count
- Extract bottom `layout.subs` players as this round's subs (lowest-count = fairest)
- Increment their sit-out count
- Result: variance in sit-out count ≤ 1 (provably optimal for uniform rotation)

**Bulk import parsing** (`parseRawName`, `parseBulk`, `injectDemoPlayers`):
- `parseRawName()` — regex-strip emails (anything after @) and role suffixes (- Organizer, etc.)
- `parseBulk()` — split textarea by newlines, normalize to Title Case, deduplicate
- `injectDemoPlayers()` — generate "Demo Player N" names with localized suffix, preserve real names

## Backend Endpoints

- `POST /api/schedule` — Generate schedule, return `{ scheduleCode, shareUrl, qrDataUrl, schedule }`
- `GET /api/schedule/:code` — Fetch archived schedule
- `GET /api/schedule/:code/stream` — Server-Sent Events stream for live schedule sync (pings every `SSE_PING_MS`, pushes updated schedule snapshots to connected viewers)
- `POST /api/schedule/:code/extend` — Extend schedule with new rounds; `{ count = 5 }`
- `POST /api/schedule/share` — Mark schedule active by code + organizer name
- `POST /api/profiles` — Save player list to persistent storage
- `GET /api/data` — Load current/default player list
- `GET /api/leaderboard` — (Worker only) Aggregate games/sits/sessions/unique partners & opponents per canonical player across every schedule in the schedule index
- `GET /health`, `GET /api/health` — Health check (uptime monitoring)

## Durable "current" share link

`?scheduleCode=current` is a stable, reusable link that always shows whichever schedule is presently active — before Wednesday noon it's last week's, and once a manual share publishes a new one, the same link reflects it automatically, without regenerating a new QR/link each week:

- Backend: `GET /api/schedule/current` and its `/stream` variant special-case the literal string `current` as a pseudo-code in `handleGetSchedule`/`handleScheduleStream` (`worker/src/index.js`) — it resolves via `loadCurrentSchedule()` (the same KV pointer `saveCurrentSchedule()` writes on every share/auto-import) instead of a real per-schedule KV key. Live SSE streaming isn't supported for the literal `current` pseudo-code itself (there's no single Durable Object room for a moving target); `handleScheduleStream` returns a 400 for it.
- Frontend (`index.html`): loading `?scheduleCode=current` sets `isCurrentLinkMode`, displays a stable `?scheduleCode=current` link/QR (`applyCurrentLinkShareDisplay()`) instead of the underlying schedule's own ephemeral code/link, and polls `GET /api/schedule/current` every `CURRENT_LINK_POLL_MS` (45s) via `pollCurrentSchedule()`. If the underlying `code` changes (a new week's schedule was published), it re-applies the snapshot from round 0 and reconnects the SSE stream to the new code; if only the revision changed (e.g. rounds extended), it preserves the viewer's current round. Regular per-code links (e.g. a specific `BADM-XXXX` share) are unaffected and keep their original one-time SSE-only behavior.
- A "Last updated" line (`renderLastUpdated()`, sourced from `schedule.updatedAt`/`generatedAt`) is shown under the round navigator for every loaded schedule (not just `current` mode), so viewers can tell at a glance whether they're looking at a fresh pull.

## Player Identity & Leaderboard (Worker only)

Cross-session stats require a stable player identity, since names are otherwise just free-floating strings with no link between weeks:

- `PLAYER_REGISTRY_KEY` (`players:registry` in KV) maps a normalized key (`normalizePlayerKey`: trim/lowercase/collapse whitespace) to `{ name, firstSeen, lastSeen }`. The **first-seen spelling wins** as the canonical display name (`canonicalPlayerName`). `registerPlayers()` is called on every schedule generation via `handleGenerateSchedule`, so the registry stays current without a separate sync step.
- `SCHEDULE_INDEX_KEY` (`schedules:index` in KV) is an append-only list of `{ code, date, playerCount, source }` pointers, written alongside every generated schedule. This lets `/api/leaderboard` walk history without scanning the whole KV namespace.
- `handleLeaderboard` loads the index, loads each referenced schedule, and aggregates per canonical player: `games`, `sits`, `sessions` (distinct schedules appeared in, whether played or sat out), `uniquePartners`, `uniqueOpponents`.
- The frontend surfaces this via a third "Leaderboard" tab in `index.html` (`loadLeaderboard()`), reusing the existing `.stats-tbl` styling.
- **Known gap**: `server.js` (the Express/Render backend) does **not** have any of the player registry, schedule index, or leaderboard code — this was only built into the Cloudflare Worker (`worker/src/index.js`), which is the actual production backend. If `server.js` is ever brought back into active use, this logic needs to be ported over.

## Frontend Behavior

- The scheduler UI is self-contained in one file, including CSS and JavaScript.
- The core behaviors are fair sit-out rotation, 2v2 doubles with 1v1 singles overflow, conflict-group avoidance for same-team pairings, and schedule extension by 5 rounds.
- There is a demo helper in the UI that can append fake players for presentations or screen recordings.
- When a rotation is generated or extended, the UI immediately publishes the exact schedule to the API and shows a share QR/code card.
- The main state lives in browser memory, so refreshes reset the UI state (shared/archived schedules can be reloaded via `?scheduleCode=...`).

## Development Notes

- **i18n patterns**:
  - All UI text in `i18n` object; no hardcoded strings except for URLs/codes
  - Use `data-i18n="key"` attributes on HTML elements; `data-i18n-type="placeholder"` for inputs
  - Call `t(key, {vars})` for dynamic text (plurals, counts, names)
  - Language/theme changes persist to localStorage and trigger full re-render
- **Conflict rules**: optional; designed for preventing specific player pairings from being teammates (e.g., workplace conflicts) — does not restrict which players can share a court as opponents
- **Schedule extensibility**: "Add 5 more rounds" via `extendSchedule()` either calls `/api/schedule/:code/extend` (if QR exists) or generates rounds locally
- **QR/Share flow**:
  - Generation → `syncShareQr()` POSTs to `/api/schedule`, receives code + QR data URL + share URL
  - Sharing → `shareSchedule()` marks schedule active server-side
  - Reload → URL param `?scheduleCode=...` loads from `/api/schedule/:code`
  - Live sync → viewers on the same share code hold an SSE connection to `/api/schedule/:code/stream` and re-apply the schedule snapshot as it changes
- **Display names**: auto-abbreviated when first names collide (e.g., "John Doe" & "John Smith" → "John D." & "John S.") to save space
- **Race condition protection**: `qrSyncToken` increments on each `syncShareQr()` call; old responses discarded if a new sync starts. Similarly, `currentScheduleRevision` guards against applying stale streamed snapshots.
- **Team identity** via `teamKey(t)`: canonical form is `"player1|player2|..."` (sorted); used only by `renderValidation()`'s repeat-pairing check, not by the generator itself, which discourages repeats through `pairHistory` cost instead of a hard exclusion set
- **i18n template substitution**: `t('roundOf', {round: 1, total: 10})` replaces `{round}` and `{total}` in the i18n key's string
- **UI state synchronization**:
  - `renderAll()` → calls `syncPlayerCountries()`, `syncAttendance()`, `renderPlayers()`, `renderConflictPicker()`, `updateHint()`, `renderCheckIn()`
  - `renderSchedule()` → calls `renderValidation()` and `renderCheckIn()`
- **Shorthand CSS classes**: `.cx` (conflict chips), `.pchip` (player pills), `.vrow` (validation row), `.pa`/`.pb` (team A/B badges)
- **Error messages in i18n**: all error strings (e.g., `errorNeedMore`, `errorLayout`) support template vars for pluralization and counts

## Testing

**Automated regression suite** for the scheduling algorithm — `npm test` (Node's built-in runner, no dependencies to install):

- `tests/scheduling.test.js` asserts the invariants that matter: no pair gets stuck facing each other round after round, opponents/partners are spread across the roster, sit-out counts stay within one round of each other, conflict-group players never end up as teammates, every round covers every player exactly once, and pair history survives schedule extension.
- Every test runs against **all three** implementations of the algorithm (the SPA's inline script, the Worker, and the Express server), plus an explicit check that identical seeds produce identical schedules in all three. This is what enforces the "keep the Node and Worker paths aligned" rule mechanically instead of by memory.
- `tests/helpers/load-scheduler.js` lifts the scheduling functions out of each source and runs them in a `node:vm` sandbox with a seeded PRNG. It extracts rather than imports because `index.html` is intentionally a self-contained single file with no build step, and importing the backends would pull in express/hono and start a listener. Extraction is strict: renaming or deleting a scheduling function fails the suite loudly rather than silently skipping coverage.
- Failures are reproducible — assertion messages carry the seed and the offending numbers.
- If you change the scoring weights, expect to re-measure; thresholds are set from observed behavior with margin, and are wide enough to distinguish real regressions from seed noise.
- **CI**: `.github/workflows/ci.yml` runs `npm run check` (syntax) and `npm test` on pushes to `main`, on pull requests, and on demand.

Validation is also built into the UI:
- **Constraint panel** (`renderValidation()`) shows real-time:
  - ✓/✗ Team conflict violations (if any paired players in `conflictGroup` end up as teammates)
  - ✓/✗ Repeated team pairings (any team used twice)
  - ✓/✗ Sit-out fairness (range of sit-out counts; fair if max − min ≤ 1)
  - Summary: total rounds, court count, format (e.g., "3×2v2 + 1×1v1")
- **Leaderboard tab** (`loadLeaderboard()`) tracks per-player games, sits, sessions, unique partners, unique opponents — cross-session, not per-schedule
- **Manual testing approach**: add players, set conflicts, generate, visually inspect the validation panel and (separately) the Leaderboard tab

## Versioning

The app shows its version in a small label under the header title ("Internal Tools · vX.Y.Z"), so it is visible at a glance that the app is maintained. There is no build step, so the version is not read from `package.json` at runtime — it is a plain `APP_VERSION` constant in `index.html`.

- **Source of truth**: bump `APP_VERSION` in `index.html`, `version` in `package.json`, and `version` in `worker/package.json` together, on every meaningful change. They should always match.
- **Scheme**: semantic versioning (`MAJOR.MINOR.PATCH`) — patch for fixes and small tweaks, minor for new user-facing features, major for a breaking change to the schedule data shape or a public API endpoint.
- **History note**: the project had no formal versioning before `1.6.0` — no git tags, and `package.json` had been stuck at the npm-init default (`1.0.0`) since the very first commit. `1.6.0` is a reconstruction from the commit history's feature milestones (share/QR, i18n, dark mode, Cloudflare Worker migration, brand redesign ≈ 1.0; cal.com auto-import + leaderboard ≈ 1.1; manual round editing ≈ 1.2; check-in/attendance ≈ 1.3; skill-tier balancing ≈ 1.4; the pairing-fairness overhaul + skill-tier removal + regression suite ≈ 1.5; the Setup-hiding/check-in-rename/15-round-default batch ≈ 1.6), not a set of real historical releases.

## Verification

- **Any change to the scheduling algorithm must pass `npm test`**, and the fix must be applied to all three copies (`index.html`, `worker/src/index.js`, `server.js`) — the suite fails if they diverge.
- For frontend-only edits, do a quick browser check of the changed behavior.
- For `server.js` changes, prefer a syntax check plus a local run:
  - `node -c server.js`
  - `npm start`
- For `worker/src/index.js` changes, run `node --check worker/src/index.js` before deploying, or `cd worker && npm run check` / `cd worker && npm run dev` if available.
- `npm run check` syntax-checks both backends in one step.
- If you change JSON persistence, verify the saved file still loads with the existing schema.

## Deployment Targets

- The repo has a deployed static site (frontend) and a separate production API. Confirm which backend is actually live before assuming `server.js`/Render is authoritative — as of this writing the frontend's `API_BASE` points at the Cloudflare Worker (`https://badminton-scheduler-api.rxlab.workers.dev`), not the Render-hosted `server.js`. Keep `worker/wrangler.toml` and `worker/src/index.js` aligned with live behavior.
- If the app is meant to use `server.js` in production instead, deploy it as a Render web service rather than a static site.
- If only the UI is being published, keep the frontend host aligned with `index.html` and the repo root.
- If deploying the Worker, watch for Durable Object migration format issues (the free plan requires `new_sqlite_classes` rather than the default classes migration).
