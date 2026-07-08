# Badminton Scheduler - Project Documentation

**Last Updated:** June 2026  
**Project Status:** 95% Complete (Ready for Design Review)  
**Repository:** https://github.com/ryanzhxu/badminton-scheduler

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Current Implementation Status](#current-implementation-status)
3. [Feature Checklist](#feature-checklist)
4. [Architecture](#architecture)
5. [File Structure](#file-structure)
6. [API Endpoints](#api-endpoints)
7. [Frontend Features](#frontend-features)
8. [Backend Implementation](#backend-implementation)
9. [Design System Integration](#design-system-integration)
10. [Design Review Prompt](#design-review-prompt)
11. [Implementation Notes](#implementation-notes)
12. [Deployment](#deployment)

---

## Project Overview

**Badminton Scheduler** is an internal tool for Trulioo employees to generate fair badminton doubles rotations and share them with the team via QR codes. The app handles 10-round schedules (extendable by 5 rounds) with player conflict rules, sub rotation fairness tracking, and team preference management.

**Target Users:** Trulioo badminton group (weekly games)

**Key Goals:**
- Fair rotation algorithm (no repeat teams, balanced sub distribution)
- Easy sharing via QR codes
- Dark mode support
- Multi-language support (5 languages)
- Trulioo brand-aligned design

---

## Current Implementation Status

### ✅ Fully Implemented

| Component | Status | Notes |
|-----------|--------|-------|
| Schedule Generation | ✅ | 10 rounds, extendable by 5 |
| Fair Rotation Algorithm | ✅ | 2v2 doubles + 1v1 singles overflow, no repeat teams |
| Team Conflict Rules | ✅ | Single conflict group, prevents paired players on same team |
| Sub Rotation Tracking | ✅ | Fairness validation across all rounds |
| QR Code Generation | ✅ | Unique codes, data URL display |
| Schedule Sharing | ✅ | POST /api/schedule/share marks as "current active" |
| Share Banner | ✅ | Shows "✓ ACTIVE SCHEDULE - Shared by X at TIME" |
| Extend Rounds | ✅ | Add 5 more rounds (disabled when schedule shared) |
| Player Management | ✅ | Add/remove, bulk import, demo seeding |
| Dark Mode | ✅ | CSS variables + toggle, localStorage persistence |
| Settings Modal | ✅ | Gear icon in header, theme + language selector |
| Language Selector UI | ✅ | 5 languages (EN, ZH-Hans, ZH-Hant, Filipino, Korean) |
| i18n Strings | ✅ | Translation keys defined in code |
| Player Stats | ✅ | Games played, sat out, partners, opponents |
| Constraint Validation | ✅ | Conflict violations, repeat teams, sub fairness |
| Responsive Design | ✅ | Mobile-friendly grid layout |
| Backend Endpoints | ✅ | All 7 endpoints functional |

### ⚠️ Partially Implemented

| Component | Status | Notes |
|-----------|--------|-------|
| i18n Functionality | ⚠️ | Language selector exists, but UI text doesn't change (framework ready, needs wiring) |

### ❌ Not Yet Implemented

| Component | Status | Notes |
|-----------|--------|-------|
| Profiles Tab (Admin-only) | ❌ | Player addresses, dietary preferences (deprioritized) |
| Restaurants Tab | ❌ | Find restaurants near courts (deprioritized) |
| Rides Home Tab | ❌ | Map with neighbourhood circles & driver routes (deprioritized) |
| Trulioo Brand Integration | ❌ | Logo, branded colors, component styling (design review pending) |

---

## Feature Checklist

### Core Features

- ✅ Generate 10-round schedules
- ✅ Extend by 5 rounds (disabled when shared)
- ✅ 2v2 doubles + 1v1 singles overflow
- ✅ Team conflict prevention
- ✅ Fair sub rotation
- ✅ No repeated team pairings
- ✅ Player management (add/remove/bulk import)

### Sharing & Distribution

- ✅ Share with group button
- ✅ Generate QR code
- ✅ Unique schedule codes (BADM-XXXX format)
- ✅ Lock schedule when shared
- ✅ Archive schedules indefinitely
- ✅ Retrieve shared schedule by code
- ✅ Active schedule banner with timestamp

### UI/UX

- ✅ Settings modal (gear icon)
- ✅ Dark mode toggle (Light/Dark buttons)
- ✅ Language selector (5 options)
- ✅ Responsive grid (1-3 columns)
- ✅ Player stats table
- ✅ Constraint validation panel
- ✅ Court card display with team assignments

### Configuration

- ✅ Court count selector (no default)
- ✅ Team conflict rules (single group)
- ✅ Court location changeable (future: for restaurants)

---

## Architecture

```
badminton-scheduler/
├── Frontend (index.html - 657 lines)
│   ├── Setup tab: courts + players + conflict rules
│   ├── Schedule tab: round navigation + court display + sharing
│   ├── Settings modal: theme + language
│   └── Dark mode: CSS variables + toggle
│
├── Backend (server.js - 303 lines)
│   ├── POST /api/schedule → generate + archive
│   ├── POST /api/schedule/share → mark as active
│   ├── GET /api/data → current + archived schedules
│   ├── GET /api/schedule/:code → retrieve by code
│   ├── POST /api/profiles → save players/court
│   └── Health checks
│
└── Data (shared-data.json)
    ├── players: [{name, neighbourhood, vegetarian}]
    ├── courtLocation: string
    ├── currentSchedule: {...}
    └── archivedSchedules: [{...}]
```

---

## File Structure

```
badminton-scheduler/
├── index.html                  # Main UI (657 lines)
├── server.js                   # Express backend (303 lines)
├── package.json                # Dependencies
├── package-lock.json           # Dependency lock
├── shared-data.json            # Persistent data store
├── .env.example                # Environment template
├── CLAUDE.md                   # Project philosophy/patterns
├── AGENTS.md                   # Claude Code agent config
├── FRONTEND-SETTINGS-1.md      # Settings feature notes
├── .claude/settings.local.json # Claude Code settings
├── index.html.bak              # Backup
├── server.js.bak               # Backup
└── node_modules/               # Dependencies
```

---

## API Endpoints

### POST /api/schedule
**Generate a new schedule**

Request:
```json
{
  "courtLocation": "Badminton Vancouver",
  "numCourts": 3,
  "players": [{"name": "Man Sun", "neighbourhood": "Deer Lake", "vegetarian": false}, ...],
  "conflictGroup": ["David", "Vincent Chen", "Hannah Li", "Jerry Chiang"]
}
```

Response:
```json
{
  "scheduleCode": "BADM-ABC1",
  "qrDataUrl": "data:image/svg+xml;base64,...",
  "schedule": {
    "code": "BADM-ABC1",
    "generatedAt": "2026-06-25T18:45:00Z",
    "rounds": [
      {
        "subs": ["Player1"],
        "courts": [
          {"a": ["P1", "P2"], "b": ["P3", "P4"], "singles": false},
          ...
        ]
      },
      ...
    ]
  }
}
```

---

### POST /api/schedule/share
**Mark a schedule as "current active"**

Request:
```json
{
  "scheduleCode": "BADM-ABC1",
  "organizer": "Ryan Xu"
}
```

Response:
```json
{
  "ok": true,
  "sharedAt": "2026-06-25T18:50:00Z",
  "sharedBy": "Ryan Xu"
}
```

---

### GET /api/data
**Fetch current schedule + shared data**

Response:
```json
{
  "currentSchedule": { /* full schedule object */ },
  "players": [{"name": "...", "neighbourhood": "...", "vegetarian": false}, ...],
  "courtLocation": "Badminton Vancouver"
}
```

---

### GET /api/schedule/:code
**Retrieve archived schedule by code**

Response:
```json
{
  "schedule": { /* archived schedule object */ }
}
```

---

### POST /api/profiles
**Save player list and court location**

Request:
```json
{
  "players": [{"name": "...", "neighbourhood": "...", "vegetarian": false}, ...],
  "courtLocation": "Badminton Vancouver"
}
```

---

### GET /health + GET /api/health
**Service health check**

---

## Frontend Features

### Setup Tab

- **Courts input:** Number of courts (1-10, no default)
- **Player management:**
  - Add one at a time
  - Bulk import (paste list, strips emails & role suffixes)
  - Remove all button
- **Team conflict rules:** Click to toggle players in/out of conflict group
- **Generate button:** Creates 10-round schedule

### Schedule Tab

- **Round navigation:** Prev/Next buttons + round counter
- **Sub banner:** Shows who's sitting out (yellow banner)
- **Share banner:** Shows "✓ ACTIVE - Shared by X at TIME" (green banner)
- **Share with group button:** Locks schedule, marks as active
- **Generate QR button:** Shows modal with code + QR image
- **Court cards:** Team A vs Team B display, 1-3 columns responsive
- **Extend button:** Add 5 more rounds (disabled if shared)
- **Player stats table:** Games played, sat out, partners, opponents
- **Constraint validation:** Conflict violations, repeated teams, sub fairness

### Settings Modal

- **Appearance:** Light/Dark toggle buttons
- **Language:** Dropdown with 5 options (EN, ZH-Hans, ZH-Hant, Filipino, Korean)
- **Persistence:** localStorage saves theme + language

### Dark Mode

- CSS variables: `--p`, `--ph`, `--ia`, `--nav`, `--s0`, `--s1`, `--s2`, etc.
- `body.dark-mode` class toggles all colors
- Persisted to localStorage

---

## Backend Implementation

### Dependencies

```json
{
  "express": "^4.18.2",    // Web server
  "cors": "^2.8.5",        // Cross-origin requests
  "dotenv": "^16.3.1",     // Environment config
  "qrcode": "^1.5.3",      // QR code generation
  "uuid": "^9.0.0"         // ID generation (unused, can remove)
}
```

### Data Model (shared-data.json)

```json
{
  "players": [
    {"name": "Man Sun", "neighbourhood": "Deer Lake", "vegetarian": false},
    ...
  ],
  "courtLocation": "Badminton Vancouver",
  "currentSchedule": {
    "code": "BADM-ABC1",
    "generatedAt": "ISO timestamp",
    "rounds": [{ "subs": [], "courts": [...] }],
    "sharedAt": "ISO timestamp",
    "sharedBy": "organizer name"
  },
  "archivedSchedules": [
    { "code": "...", "generatedAt": "...", "rounds": [...] },
    ...
  ]
}
```

### Algorithm Details

**Schedule Generation (10 rounds + extendable):**
1. For each round: pick subs (players with fewest sit-outs, break ties randomly)
2. Remaining players assigned to courts
3. No-repeat-teams: shuffle & score 600 times, pick lowest score
4. Conflict rules: prevent paired players on same team
5. Archive after generation

**Team Assignment:**
- Split active players evenly across courts
- 2v2 doubles by default
- 1v1 singles if odd player count after accounting for court size

---

## Design System Integration

### Current Design Tokens (Trulioo 2.0)

**Primary Colors:**
- `--p` (#172D2D): Primary/Action default
- `--ph` (#004C45): Primary/Action hover

**Interactive:**
- `--ia` (#128BA6): Interactive default
- `--ia-h` (#0E687D): Interactive hover

**Surfaces:**
- `--nav` (#E5F0E8): Navigation container
- `--s0` (#FFFFFF): Surface 0
- `--s1` (#F2F2F2): Surface +1
- `--s2` (#E5E5E5): Surface +2

**Semantic:**
- `--ok` (#316E68): Success/green
- `--wa` (#F7C11B): Warning/yellow
- `--er` (#BB363C): Error/red
- `--bls` (#D9F2F7): Info/blue

**Text:**
- `--tx` (#121212): Text default
- `--txs` (#404040): Text secondary
- `--txd` (#BFBFBF): Text disabled

### Dark Mode Variants

All colors invert in `body.dark-mode` class (lines 116-125 of index.html)

---

## Design Review Prompt

Use this prompt in **Claude Design** to review current UI and propose Trulioo brand integration:

```
Mode: Design review & brand redesign
Goal: Review badminton-scheduler UI against Trulioo design system, propose full brand integration
Project: Internal badminton doubles rotation scheduler for Trulioo employees

Requirements: A) Make it look more "Trulioo corporate" (professional, brand-aligned)
              B) Add Trulioo branding/logo integration
              C) Use Trulioo design components (buttons, cards, forms)
              D) All of the above

Current app state:
  - Single-page HTML app with dark mode support
  - Uses Trulioo 2.0 color tokens (--p, --ph, --ia, --nav, etc.)
  - Features: schedule generation, QR sharing, settings modal, player management
  - Responsive grid layout
  - Settings with language support (5 languages: EN, ZH-Hans, ZH-Hant, Filipino, Korean)

Design system available: Trulioo design system (via Figma MCP in your context)

What to review & redesign:

1. BRANDING INTEGRATION (Requirement B):
   - Where should Trulioo logo appear? (header, favicon, splash screen?)
   - Company colors/palette alignment
   - Visual identity that screams "Trulioo"
   - Brand voice in microcopy (button labels, instructions)

2. COMPONENT STYLING (Requirement C):
   - Audit current buttons, cards, modals against Trulioo design components
   - Propose Trulioo button styles (primary, secondary, danger)
   - Card styling for schedule/player display
   - Modal dialog design
   - Form inputs (text, select, toggles)
   - Navigation tabs styling
   - Badge/chip components

3. PROFESSIONAL POLISH (Requirement A):
   - Typography hierarchy (headings, body, labels)
   - Spacing/layout consistency
   - Visual hierarchy improvements
   - Dark mode refinement
   - Loading states, empty states
   - Error/success messaging design

4. VISUAL IDENTITY:
   - Header design (incorporate Trulioo branding)
   - Color strategy (primary action colors, semantic colors for success/warning/error)
   - Icon usage (match Trulioo icon style if available)
   - Typography (font family alignment)
   - Elevation/shadow treatment

What to output:

1. Design audit:
   - ✅ What's already well-designed
   - 🎨 What could be stronger

2. 3-5 specific redesign proposals:
   - Visual mockup descriptions (or if possible, generate mockups)
   - Before/after comparisons
   - Specific impact (e.g., "improves brand recognition by making logo prominent")
   - Implementation complexity (easy/medium/hard)

3. High-impact changes to prioritize:
   - What to do first for maximum impact
   - Quick wins vs. deeper redesigns

4. Component library to build:
   - List of Trulioo components to implement (buttons, cards, etc.)
   - CSS/design tokens needed

5. Implementation roadmap:
   - Phase 1 (quick wins)
   - Phase 2 (branding integration)
   - Phase 3 (polish & refinement)

Focus: Make Trulioo employees instantly recognize this as a company tool. They should see the Trulioo design system reflected throughout.

Keep it practical — changes should be implementable in HTML/CSS without major refactoring.
```

**How to use:**
1. Open Claude Design
2. Paste the prompt above
3. Attach your `index.html` file (copy-paste contents)
4. Wait for design review + proposals
5. Come back with recommendations for implementation

---

## Implementation Notes

### Key Decisions

1. **10-round default, extendable by 5:** Balances clean schedules with flexibility for longer sessions
2. **Single conflict group:** Simpler UX than multiple groups
3. **No repeat teams:** 600-shuffle algorithm with conflict + repeat scoring
4. **Archived schedules:** Kept indefinitely for reference (no expiry)
5. **QR codes:** Data URL for immediate display, no server storage needed
6. **localStorage:** Persists theme + language, not player data (that's on server)

### Known Limitations

1. **i18n wired but not active:** Language selector exists, but UI doesn't translate (framework ready, needs implementation)
2. **UUID unused:** Installed but not currently used (can remove from package.json)
3. **Duplicate algorithm:** Schedule logic in both server.js + index.html (any changes need sync)
4. **No player persistence:** Player list resets on refresh (only schedules archived to server)
5. **No authentication:** Anyone can call backend endpoints (fine for internal tool)

### Testing Checklist

- [ ] Generate schedule with various court/player counts
- [ ] Share schedule → verify green banner + extend button disabled
- [ ] Generate QR → verify code displays
- [ ] Retrieve shared schedule by code (via URL param)
- [ ] Dark mode toggle → all colors invert
- [ ] Language selector → confirm dropdown works (text change pending i18n wiring)
- [ ] Conflict rules → verify paired players never on same team
- [ ] Extend schedule → add 5 more rounds, verify fairness maintained
- [ ] Player stats → verify counts match rounds
- [ ] Responsive design → test on mobile/tablet/desktop

---

## Deployment

### Backend (Render)

1. Connect GitHub repo to Render
2. Build command: `npm install`
3. Start command: `node server.js`
4. Environment variables: `PORT=3000`
5. Live URL: `https://badminton-scheduler-api.onrender.com`

### Frontend

Option A: **Netlify Drop** (30 seconds)
- Drag `index.html` to netlify.com/drop
- Get instant shareable URL

Option B: **GitHub Pages** (5 minutes)
- Push to repo, enable Pages in Settings
- URL: `https://yourusername.github.io/badminton-scheduler`

Option C: **Render Static Site** (same as backend)
- Deploy alongside backend
- Both on same Render account

### Local Development

```bash
# Terminal 1: Backend
npm start

# Terminal 2: Frontend
open index.html  # Mac
# or
start index.html  # Windows

# Access: http://localhost:3000 (if using Node server) or file:// (if direct HTML)
```

---

## Next Steps

1. **Design Review:** Use the prompt in "Design System Integration" section with Claude Design
2. **Get Design Proposals:** Review mockups + recommendations
3. **Implement Branding:** Update UI with Trulioo components (Phase 1: quick wins)
4. **Wire i18n:** Connect language selector to actual UI translation
5. **Deploy:** Push to Render + share link with Trulioo badminton group
6. **Gather Feedback:** Get employee feedback on design + usability

---

## Contact & Notes

**Project Lead:** Ryan Xu  
**Repository:** https://github.com/ryanzhxu/badminton-scheduler  
**Tech Stack:** Express.js (backend), vanilla HTML/CSS/JS (frontend)  
**Status:** Ready for design review, then deploy to production

**For questions or updates:**
- Review CLAUDE.md for development philosophy
- Check AGENTS.md for Claude Code setup
- Use Design Review Prompt for visual improvements
