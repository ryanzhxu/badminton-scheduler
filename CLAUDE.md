# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Badminton Rotation Scheduler** is a single-page scheduler UI in `index.html` plus a small Express API in `server.js`. It generates fair rotation schedules for badminton matches, then immediately publishes a shareable QR/code through the backend. Players are assigned to courts in 2v2 doubles matches, with 1v1 singles for overflow, ensuring:
- Fair sit-out rotation (minimizing variance in who sits out)
- No repeated team pairings across rounds
- Respect for team conflict rules (players who shouldn't be on the same team)
- Extensible schedule (add more rounds as needed)

## Running the App

Open `index.html` directly for the UI, or run the API when you want QR/share persistence:
```bash
open index.html
python3 -m http.server 8000
# Then visit http://localhost:8000
node server.js
```

## Architecture

The app is a **single-file, self-contained web application** with three integrated layers:

### 1. HTML Structure (lines 102–185)
- Tab interface: Setup and Schedule views
- Setup pane: configure courts, add players, define conflict rules, generate schedule
- Schedule pane: display rounds with court assignments, player stats, constraint validation

### 2. CSS Styling (lines 10–98)
- CSS variables for a consistent teal/green color scheme (`--p`, `--ph`, `--ia`, `--ok`, `--er`, etc.)
- Grid-based layout for courts (responsive: 1–3 columns)
- Reusable component classes (`.card`, `.btn-p`, `.btn-s`, `.pchip`, `.cx`, etc.)

### 3. JavaScript Logic (lines 198–420)
- **State**: `rawPlayers`, `conflictGroup`, `schedule`, `sitC` (sit-out counts), `usedTeams` (team keys to avoid repeats)
- **Input processing**: 
  - `parseRawName()` — clean bulk imports (strip emails, titles)
  - `parseBulk()` — parse multi-line input
  - `computeDisplayNames()` — auto-abbreviate display names when first names collide
- **Layout algorithm** (`getLayout(n, nc)`):
  - Given `n` players and `nc` courts, compute how many doubles (4 per), singles (2 per), and sit-outs per round
  - Greedy search: iterate substitution counts `s` from 0 up, find smallest valid layout
- **Scheduling** (`generateRounds()`, `makeTeams()`):
  - For each round, shuffle players and sort by current sit-out count (fair queue)
  - Assign lowest-count players as subs for the round
  - Use `makeTeams()` to generate court assignments: 600 shuffled attempts, score by conflict violations (1000×) + team repeats
  - Track `usedTeams` (team keys) to prevent pairings across rounds
- **Display**: `renderSchedule()`, `renderStats()`, `renderValidation()` update the UI based on current round and schedule state
- **Share QR**: `syncShareQr()` publishes the exact generated schedule to `/api/schedule` and immediately shows the returned QR/code card
- **Conflict rules**: `conflictPair()` checks if two players both in `conflictGroup`; `teamOk()` rejects teams with conflicts

## Key Algorithms

**Layout computation** (`getLayout`):
- Tries to balance court usage: prefer full doubles courts (4 players each) with minimal singles
- Example: 13 players, 3 courts → 3 doubles (12 players) + 1 sub per round
- The search prioritizes low substitution counts (`s` from 0 up)

**Team generation** (`makeTeams`):
- Stochastic: 600 random shuffles, picks the best by two criteria:
  - Conflict violations (weighted 1000× higher)
  - Repeated pairings in `usedTeams`
- Works because 600 attempts find near-optimal solutions for typical group sizes (12–30 players)

**Fair sit-out rotation** (`sitC`):
- Before each round, sort active players by their current sit-out count
- Lowest-count players sit out, keeping variance ≤ 1 (optimal)

## Development Notes

- **No dependencies**: pure HTML, CSS, JavaScript — no build step, no npm packages
- **Responsive**: grid layout adapts to 1–3 court columns depending on court count and screen width
- **Conflict rules**: optional; designed for avoiding same-team pairings (e.g., prevent conflicts of interest)
- **Extensibility**: schedules are stored in memory; "Add 5 more rounds" extends the current schedule (calls `extendSchedule()`)
- **Sharing**: schedule generation also archives the exact rounds through the Node API so the QR can reload the same schedule later
- **Display names**: auto-abbreviated (e.g., "John Doe" → "J." when another John exists) to save space in the UI

## Testing

No automated test suite. Validation is built into the UI:
- **Constraint panel** shows:
  - Team conflict violations (if any)
  - Repeated team pairings
  - Sit-out fairness (range of sit-out counts across players)
  - Schedule summary (rounds, courts, format)
- Manual testing: enter players, set conflicts, generate schedules, verify stats and constraints are acceptable

## Notable Patterns

- **Team deduplication** via `teamKey()`: encodes a team as `"player1|player2|..."` (sorted) to detect repeats
- **UI state synchronization**: `renderAll()` redraws players, conflicts, and hints; `switchTab()` toggles panes
- **Shorthand CSS classes**: `.cx` for conflict chips, `.pchip` for player pills, `.vrow` for validation rows
