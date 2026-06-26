# FRONTEND-SETTINGS-1: Settings Modal & Dark Mode

**Status:** In Progress — Awaiting Dark Mode Primary Color Decision  
**Branch:** `feature/FRONTEND-SETTINGS-1`  
**Last Updated:** 2026-06-25

---

## Ticket Overview

Implement a settings modal with theme toggle and language selector, plus dark mode support using Trulioo design system colors.

### Completed ✅

#### 1. Settings Modal in Header
- Added gear icon (⚙️) button in top-right header
- Opens overlay modal with two tabs: **Appearance** and **Language**
- Close button (X) and click overlay to dismiss
- Full CSS styling with responsive design

#### 2. Dark Mode Toggle
- Theme buttons: ☀️ Light / 🌙 Dark
- Toggles `body.dark-mode` class on document
- Persists selection to localStorage
- Loads saved theme on page init via `loadSettings()`

#### 3. Language Selector
- Dropdown with 5 languages:
  - English
  - 中文 (简体 - Simplified Chinese)
  - 繁體中文 (Traditional Chinese)
  - 한국어 (Korean)
  - हिन्दी (Hindi)
- Persists language choice to localStorage
- Note: Language i18n UI switching coming in next phase

#### 4. Schedule Sharing Flow
- After generating schedule, "Share with group" button appears
- Button calls `POST /api/schedule/share` with scheduleCode and organizer
- Shows green "ACTIVE SCHEDULE" banner with timestamp when shared
- Hides "Add 5 more rounds" button when schedule is marked as shared

#### 5. Port Migration: 3000 → 5000
- **server.js line 11:** Changed `const PORT = process.env.PORT || 3000;` to `5000`
- **index.html line 290:** Changed API_BASE from `http://localhost:3000` to `http://localhost:5000`

#### 6. Default Rounds Changed
- **index.html line 285:** Changed `const BASE_ROUNDS=10` to `const BASE_ROUNDS=15`
- Schedules now generate 15 rounds by default (instead of 10)

#### 7. Removed Redundant Button
- Deleted "Generate QR" button from share-actions
- QR auto-generates when you click "Generate schedule" anyway
- Only "Share with group" button remains in share-actions div

#### 8. Trulioo Design System Integration
- Connected to Figma: https://www.figma.com/design/FAm1kyfK6DxXokIvSudCT4/Trulioo-2.0-Design-System
- All colors mapped to official Trulioo palette
- Light mode verified ✅
- Dark mode partially applied (blocker below)

---

## Current Blocker 🔴

### Dark Mode Primary Color Contrast Issue

**Problem:** Primary color `#A4DCB4` (Light Green 100) looks "weird" and has poor text readability in dark mode.

**Current CSS:**
```css
body.dark-mode {
  --p:#A4DCB4;  /* Light Green 100 — TOO MUTED, poor contrast */
  /* ... rest of dark mode colors ... */
}
```

**Why it's a problem:**
- Light Green 100 is a medium-light, desaturated green
- Doesn't have enough visual prominence on dark backgrounds (#0F1A19)
- White text on this color is hard to read
- Doesn't feel like a "primary" action color

---

## Solution Options

Pick ONE and update `--p` and optionally `--ia` in `body.dark-mode`:

### Option A: Use Blue as Primary ⭐ RECOMMENDED
```css
body.dark-mode {
  --p:#17AED0;      /* Blue 60 — bright, high contrast, standard for dark mode */
  --ia:#62908B;     /* Light Green 60 — secondary interactive */
  /* rest stays same */
}
```
**Pros:** High contrast, reads well, standard dark mode practice, very visible  
**Cons:** Shifts from green branding to blue

### Option B: Use Saturated Green
```css
body.dark-mode {
  --p:#62908B;      /* Light Green 60 — more saturated than A4DCB4 */
  --ia:#17AED0;     /* Blue 60 — interactive */
  /* rest stays same */
}
```
**Pros:** Keeps green branding, better saturation than current  
**Cons:** Still might not be as visible as blue option

### Option C: Use Dark Green with Better Contrast
```css
body.dark-mode {
  --p:#004C45;      /* Mid Green 100 — very dark, high contrast */
  --ph:#62908B;     /* Light Green 60 — hover state */
  /* BUT: This is already used for --nav, might create confusion */
}
```
**Pros:** High contrast, strong branding  
**Cons:** Conflicts with nav color, would need to adjust nav

---

## Full Dark Mode CSS (Current)

Located in `index.html` lines 116–125:

```css
body.dark-mode {
  --p:#A4DCB4;           /* PRIMARY — NEEDS REVIEW */
  --ph:#B4E1C1;          /* Primary hover */
  --ia:#17AED0;          /* Interactive */
  --nav:#004C45;         /* Navigation background */
  --s0:#0F1A19;          /* Surface 0 (main) */
  --s1:#141F1E;          /* Surface 1 (secondary) */
  --s2:#1A2524;          /* Surface 2 (tertiary) */
  --bd:#334542;          /* Border default */
  --bdm:#5A7570;         /* Border medium */
  --tx:#FFFFFF;          /* Text default (white) */
  --txs:#E5E5E5;         /* Text secondary (light gray) */
  --txd:#999999;         /* Text disabled */
  --ok:#6BC699;          /* Success green */
  --oks:#1A3A2E;         /* Success surface */
  --wa:#FFD700;          /* Warning yellow */
  --was:#332200;         /* Warning surface */
  --er:#FF8A8F;          /* Error red */
  --ers:#4D2A2D;         /* Error surface */
  --bls:#0F3A45;         /* Blue surface */
  --blb:#4CB8D4;         /* Blue interactive */
}
```

All colors except `--p` are verified correct from Trulioo system.

---

## How to Resume

### Step 1: Setup
```bash
git checkout feature/FRONTEND-SETTINGS-1
npm install  # if needed
node server.js  # runs on port 5000
# In another terminal:
npx http-server -p 8000
# Visit: http://localhost:8000
```

### Step 2: Decide on Primary Color
Review the three options above. Test in browser by editing `body.dark-mode { --p: #XXX; }` in `index.html` line 117.

**Recommended:** Option A (Blue #17AED0)

### Step 3: Update CSS
Once decided, update `index.html` lines 117–118:
```css
body.dark-mode {
  --p:#17AED0;      /* Your chosen color */
  --ph:#B4E1C1;     /* or adjust hover if needed */
  /* ... rest ... */
}
```

### Step 4: Test Locally
- Toggle dark mode in settings
- Check all buttons, text, contrast
- Verify no visual regressions

### Step 5: Commit & Push
```bash
git add index.html
git commit -m "Fix dark mode primary color contrast (use #17AED0 or chosen color)"
git push origin feature/FRONTEND-SETTINGS-1
```

### Step 6: Create PR
Once merged and tested, create PR to main:
- Title: "Implement settings modal and dark mode (FRONTEND-SETTINGS-1)"
- Reference this ticket
- Note: Will trigger Render deployment when merged to main

---

## Files Modified

| File | Changes |
|------|---------|
| `server.js` | Port 3000 → 5000 (line 11) |
| `index.html` | Settings modal CSS (lines 98–125), HTML (lines 137, 248–282), JS functions (lines 290–340, 637) |

## Testing Checklist

### Settings Modal & Appearance
- [ ] Gear icon visible in header
- [ ] Click gear icon opens modal
- [ ] Click X button closes modal
- [ ] Click overlay background closes modal
- [ ] Tab switching works (Appearance ↔ Language)
- [ ] Theme buttons: Light/Dark toggle correctly
- [ ] Theme preference persists after page reload
- [ ] Appearance tab shows correct active state

### Dark Mode
- [ ] Dark mode toggle applies `body.dark-mode` class
- [ ] All CSS variables update correctly
- [ ] **PRIMARY COLOR (#A4DCB4) CONTRAST ACCEPTABLE** ⚠️
- [ ] Text readable on all backgrounds
- [ ] Buttons visible and clickable in dark mode
- [ ] Borders visible but subtle
- [ ] Modal looks good in dark mode
- [ ] Cards and surfaces have proper hierarchy

### Language Settings
- [ ] Language dropdown has all 5 options (en, zh-s, zh-t, ko, hi)
- [ ] Language selection persists to localStorage
- [ ] Language value saved in browser dev tools
- [ ] No console errors when switching languages
- [ ] UI doesn't break on language select

### Schedule Sharing Flow
- [ ] Add players, set courts, generate schedule
- [ ] QR code appears immediately after generation
- [ ] QR code displays and is readable
- [ ] Share code displays (e.g., "Code: BADM-XXXX")
- [ ] "Share with group" button appears after QR generation
- [ ] Click "Share with group" sends POST to `/api/schedule/share`
- [ ] Green "ACTIVE SCHEDULE" banner appears with timestamp
- [ ] "Add 5 more rounds" button is hidden when schedule is shared
- [ ] Banner persists while on Schedule tab
- [ ] Banner disappears if you navigate to Setup and back

### Schedule Generation
- [ ] 15 rounds generate by default (not 10)
- [ ] Court assignments are valid (no player in multiple courts same round)
- [ ] Sit-out rotation is fair
- [ ] Team pairings don't repeat across rounds
- [ ] Player stats calculate correctly
- [ ] Constraint validation shows no unexpected errors

### Port & API Connectivity
- [ ] Backend runs on port 5000 (not 3000)
- [ ] Frontend at localhost:8000 calls localhost:5000 for API
- [ ] GET /api/health succeeds
- [ ] POST /api/schedule succeeds (returns QR)
- [ ] POST /api/schedule/share succeeds
- [ ] No CORS errors in browser console
- [ ] No "Cannot reach API" errors

### UI/UX & Responsiveness
- [ ] Modal responsive on mobile (narrows to 95% width)
- [ ] Settings modal doesn't break on small screens
- [ ] All buttons clickable (not overlapping or cut off)
- [ ] Text doesn't overflow in settings pane
- [ ] Language dropdown accessible and usable
- [ ] No layout shifts when toggling dark mode

### Browser & Console
- [ ] No JavaScript errors in console
- [ ] No warnings about deprecated APIs
- [ ] localStorage accessible and saving data
- [ ] Page loads without warnings
- [ ] No network errors (check Network tab)

---

## Trulioo Design System Reference

**Figma File:** Trulioo-2.0-Design-System  
**URL:** https://www.figma.com/design/FAm1kyfK6DxXokIvSudCT4/Trulioo-2.0-Design-System

All CSS color variables mapped to official Trulioo palette (as of 2026-06-25).

---

## Known Issues & Edge Cases

### Things to Watch For

**1. Dark Mode Primary Color Contrast**
- Current color #A4DCB4 may not have sufficient contrast
- Check white text readability on buttons
- Test with different monitors/brightness levels
- This is the blocker — must resolve before merge

**2. localStorage Behavior**
- Theme and language stored in localStorage
- Clearing site data will reset settings
- Test: Open DevTools → Application → Storage → localStorage → Clear
- Verify defaults return (light mode, English)

**3. Modal Stacking with Other Modals**
- If other modals added later, z-index: 1000 may conflict
- Currently highest z-index in app
- Watch if future features add overlays

**4. Theme Transition**
- No CSS transition on color change (instant flip)
- If colors feel jarring, consider adding `transition: all 0.2s` to root elements
- Not required but could improve UX

**5. Language Switching Not Implemented Yet**
- Dropdown UI works but doesn't actually translate content
- Shows placeholder text: "Language switching coming in next phase"
- Don't add actual i18n yet — that's future work

**6. Schedule Share State Persistence**
- Active schedule banner only shows during current session
- Refreshing page loses shared state (expected, not a bug)
- Shared schedule code persists if you load via URL parameter

### Testing Edge Cases

- [ ] **Fresh browser:** No localStorage — verify defaults work
- [ ] **Settings modal:** Open modal, toggle dark mode, close modal — theme persists
- [ ] **Generate → Share → Switch theme:** Verify active banner stays visible in dark mode
- [ ] **Multiple tabs:** Open app in 2 tabs, toggle dark mode in one — does other tab update? (No, localStorage doesn't sync cross-tab auto)
- [ ] **Schedule generation edge case:** 13 players, 3 courts → verify valid layout
- [ ] **QR generation fails:** API unreachable → verify error message shows gracefully
- [ ] **Mobile landscape:** Verify modal fits on 5-inch phone in landscape

### Potential Regressions to Check

Since we modified core CSS, check that existing features still work:
- [ ] Player list rendering (bulk import, demo players)
- [ ] Court assignment display (court grid layout)
- [ ] Player stats table formatting
- [ ] Constraint validation panel
- [ ] All existing buttons and forms
- [ ] Header and tab navigation
- [ ] Schedule round navigation (prev/next buttons)

---

## Merge Checklist

Before creating PR to main:

- [ ] All testing checklist items pass
- [ ] Dark mode primary color decided and tested
- [ ] No console errors or warnings
- [ ] Code follows no-formatting, no-unrelated-changes rule
- [ ] Commit message is clear and includes ticket reference
- [ ] Changes only to: index.html, server.js (not package.json, not unnecessary files)
- [ ] Tested on at least Chrome (or your primary browser)
- [ ] QR code generation works (requires backend running)
- [ ] Schedule sharing works (requires backend running)

---

## Notes

- Language i18n implementation deferred to next phase
- All color values from official Trulioo design system
- Dark mode colors complete except primary (awaiting decision)
- Ready to merge once primary color decision is made and all tests pass
- **Do NOT merge to main until color blocker is resolved** (triggers Render deployment)
