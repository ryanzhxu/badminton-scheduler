# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Badminton Rotation Scheduler** is a full-featured single-page app (SPA) in `index.html` (657 lines) plus an Express API in `server.js`. It generates fair rotation schedules for badminton matches, then immediately publishes a shareable QR code through the backend. The app features:
- **Fair rotation**: minimizing variance in sit-out counts across players
- **Team fairness**: no repeated pairings across rounds, conflict rules to prevent specific players on same team
- **Player assignment**: 2v2 doubles matches with 1v1 singles for overflow
- **Extensible schedules**: add more rounds on demand via server or client
- **Internationalization**: 6 languages (English, Simplified Chinese, Traditional Chinese, Korean, Hindi, Filipino) with live switching
- **Dark mode support**: theme toggle persisted to localStorage
- **Share & persistence**: generate QR codes to share exact schedules; server archives and can reload them

## Running the App

Open `index.html` directly for the UI, or run the API when you want QR/share persistence:
```bash
open index.html
python3 -m http.server 8000
# Then visit http://localhost:8000
node server.js
```

## Architecture

The app is a **single-file, self-contained SPA** with three integrated layers, plus a Node.js backend:

### 1. HTML Structure (lines 125–248)
- Header with title and settings buttons (theme, language, tabs)
- Tab interface: Setup and Schedule views
- **Setup pane**: courts input, player management (add/bulk import/demo injection), conflict picker, generate button
- **Schedule pane**: round navigation, court grid, sit-out banner, QR share card, player stats table, constraint validation panel
- **Internationalization**: all user-facing text via `data-i18n` attributes; UI auto-translates on language switch

### 2. CSS Styling (lines 10–100)
- CSS variables for teal/green palette: `--p` (primary), `--ph` (primary highlight), `--ia` (interactive), `--ok`, `--er` (error), `--wa` (warning), etc.
- Dark mode support: `.dark-mode` class flips text/background colors via CSS custom properties
- Responsive grid for courts: 1–3 columns depending on court count
- Reusable classes: `.card` (container), `.btn-p`/`.btn-s` (primary/secondary buttons), `.pchip` (player chip), `.cx` (conflict chip), `.vrow` (validation row)
- Tables for stats, proper icon sizing with Tabler icons

### 3. JavaScript Logic (lines 250–654)
**State** (all in global scope):
  - `rawPlayers`, `conflictGroup` (Set), `schedule`, `sitC` (sit-out counts), `usedTeams` (team dedup keys)
  - `currentLanguage`, `currentLayout`, `currentNc`, `currentRound`
  - QR-related: `currentShareCode`, `currentShareUrl`, `currentQrDataUrl`, `qrSyncToken` (race-condition prevention)
  - `i18n` object: 6 language branches (en, zh-s, zh-t, ko, hi, fil, th) with 100+ keys each

**i18n System** (`lines 258–265`):
  - `i18n` = object with language keys mapping to term dictionaries
  - `t(key, vars)` = lookup + template substitution (e.g., `t('roundOf', {round: 1, total: 10})` → "Round 1 of 10")
  - `translateUI()` = crawl DOM for `data-i18n` attributes and update text/placeholder/title based on `currentLanguage`
  - `setLanguage(lang)` = switch language, save to localStorage, re-render UI + schedule

**Theme & Settings** (`lines 268–304`):
  - `toggleTheme()` / `setTheme(t)` = add/remove `.dark-mode` on body, update icon, persist to localStorage
  - `loadSettings()` = on load, restore saved theme and language from localStorage

**Input Processing** (`lines 335–341`):
  - `parseRawName()` — strips email addresses and role suffixes (e.g., "- Organizer")
  - `computeDisplayNames(list)` — auto-abbreviates to first name or first + last initial if collision exists
  - `parseBulk()` (client) / server-side processing in `/api/profiles` (server)

**Layout Algorithm** (`getLayout(n, nc)`, lines 343–350):
  - Given `n` players and `nc` courts, compute court breakdown: doubles (4 per), singles (2 per), subs
  - Greedy search: iterate `s` from 0 up, prefer minimal substitutions
  - Example: 13 players, 3 courts → 3 doubles + 1 sub per round

**Scheduling** (`generateRounds()`, `makeTeams()`, lines 535–544):
  - For each round: shuffle players, sort by sit-out count, extract `layout.subs` lowest-count players
  - `makeTeams()`: 600 random shuffles, score by conflict violations (1000×) + repeated pairings
  - Track used team keys in `usedTeams` to prevent repeats across rounds
  - Fair rotation: ensures sit-out count variance ≤ 1 (optimal fairness)

**Display** (`lines 574–607`):
  - `renderSchedule()` — show current round's courts with dynamic grid columns
  - `renderStats()` — player stats table (games played, sits, unique partners/opponents)
  - `renderValidation()` — constraint panel (conflicts, repeats, sit-out fairness, summary)
  - All text driven by `i18n` keys

**Share & Sync** (`lines 409–489`):
  - `syncShareQr()` = POST to `/api/schedule`, receive QR data URL and share code, display immediately
  - QR link includes share base URL (handles file:// → production URL swap)
  - `shareSchedule()` = call `/api/schedule/share` to mark schedule active, show confirmation
  - `loadScheduleFromCode(code)` = fetch `/api/schedule/:code`, reload players + schedule + stats

**Conflict & Team Validation**:
  - `conflictPair(a, b)` — returns true if both players in `conflictGroup`
  - `teamOk(t)` — rejects team if any pair has a conflict
  - `teamKey(t)` — canonical team ID for dedup (sorted player names joined by `|`)

## Key Algorithms

**Layout computation** (`getLayout(n, nc)`, in both client and server):
- Given `n` players and `nc` courts, determine the court configuration that fits all players fairly
- Strategy: prefer full doubles courts (4 per) + minimal singles (2 per) + few subs
- Greedy search: iterate substitution counts `s` from 0 up; return first valid configuration
- Example: 13 players, 3 courts → 3 doubles (12 in play) + 1 sub per round
- If no perfect fit exists, falls back to maximizing doubles with overflow subs

**Team generation via stochastic search** (`makeTeams(activePl, layout, used)`, line 526–534):
- **Why stochastic**: Finding the absolute-best team assignment is NP-hard; 600 random attempts with greedy scoring is pragmatic
- **Scoring**: for each configuration, sum:
  - Conflict violations × 1000 (dominates all other concerns)
  - Repeated team pairings (penalizes reuse from `usedTeams`)
- **Why 600 attempts**: empirically sufficient for 12–30 players; larger groups may need tuning
- Early exit if score = 0 (perfect: no conflicts, no repeats)

**Fair sit-out rotation** (`sitC` tracking, line 538):
- Before each round, sort shuffled players by current sit-out count
- Extract bottom `layout.subs` players as this round's subs (lowest-count = fairest)
- Increment their sit-out count
- Result: variance in sit-out count ≤ 1 (provably optimal for uniform rotation)

**Bulk import parsing** (`parseRawName`, `parseBulk`, `injectDemoPlayers`):
- `parseRawName()` — regex-strip emails (anything after @) and role suffixes (- Organizer, etc.)
- `parseBulk()` — split textarea by newlines, normalize to Title Case, deduplicate
- `injectDemoPlayers()` — generate "Demo Player N" names with localized suffix, preserve real names

## Development Notes

- **No frontend dependencies**: pure HTML, CSS, JavaScript — no build step, no npm packages in the SPA
- **Backend stack**: Express + QRCode + dotenv + cors (minimal, production-ready)
- **Persistent data**: server stores all schedules in `shared-data.json` (auto-created, excluded from git)
- **Responsive layout**: courts grid auto-adjusts 1–3 columns based on count and viewport
- **i18n patterns**: 
  - All UI text in `i18n` object; no hardcoded strings except for URLs/codes
  - Use `data-i18n="key"` attributes on HTML elements; `data-i18n-type="placeholder"` for inputs
  - Call `t(key, {vars})` for dynamic text (plurals, counts, names)
  - Language/theme changes persist to localStorage and trigger full re-render
- **Conflict rules**: optional; designed for preventing specific player pairings (e.g., workplace conflicts)
- **Schedule extensibility**: "Add 5 more rounds" via `extendSchedule()` either calls `/api/schedule/:code/extend` (if QR exists) or generates rounds locally
- **QR/Share flow**: 
  - Generation → `syncShareQr()` POSTs to `/api/schedule`, receives code + QR data URL + share URL
  - Sharing → `shareSchedule()` marks schedule active server-side
  - Reload → URL param `?scheduleCode=...` loads from `/api/schedule/:code`
- **Display names**: auto-abbreviated when first names collide (e.g., "John Doe" & "John Smith" → "John D." & "John S.") to save space
- **Race condition protection**: `qrSyncToken` increments on each sync; old responses discarded if a new sync starts

## API Endpoints

- `POST /api/schedule` — Generate schedule, return `{ scheduleCode, shareUrl, qrDataUrl, schedule }`
- `GET /api/schedule/:code` — Fetch archived schedule
- `POST /api/schedule/:code/extend` — Extend schedule with new rounds; `{ count = 5 }`
- `POST /api/schedule/share` — Mark schedule active by code + organizer name
- `POST /api/profiles` — Save player list + court location to persistent storage
- `GET /api/data` — Load current/default player list and court location
- `GET /health`, `GET /api/health` — Health check (Render uptime monitoring)

## Testing

**No automated test suite.** Validation is built into the UI:
- **Constraint panel** (`renderValidation()`, lines 593–607) shows real-time:
  - ✓/✗ Team conflict violations (if any paired players in `conflictGroup`)
  - ✓/✗ Repeated team pairings (any team used twice)
  - ✓/✗ Sit-out fairness (range of sit-out counts; fair if max − min ≤ 1)
  - Summary: total rounds, court count, format (e.g., "3×2v2 + 1×1v1")
- **Stats table** (`renderStats()`) tracks per-player games, sits, unique partners, unique opponents
- **Manual testing approach**: add players, set conflicts, generate, visually inspect stats and validation panel

## Notable Patterns

- **Team deduplication** via `teamKey(t)`: canonical form is `"player1|player2|..."` (sorted) for set-based lookups in `usedTeams`
- **i18n template substitution**: `t('roundOf', {round: 1, total: 10})` replaces `{round}` and `{total}` in the i18n key's string
- **UI state synchronization**: 
  - `renderAll()` → calls `renderPlayers()`, `renderConflictPicker()`, `updateHint()`
  - `renderSchedule()` → calls `renderStats()` and `renderValidation()`
- **Shorthand CSS classes**: `.cx` (conflict chips), `.pchip` (player pills), `.vrow` (validation row), `.pa`/`.pb` (team A/B badges)
- **Race-condition safety**: `qrSyncToken` increments on each `syncShareQr()` call; if response arrives from an old request, it's discarded
- **Error messages in i18n**: all error strings (e.g., `errorNeedMore`, `errorLayout`) support template vars for pluralization and counts
