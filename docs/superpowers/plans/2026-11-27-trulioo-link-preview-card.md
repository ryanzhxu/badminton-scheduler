# Trulioo Dynamic Link-Preview Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Trulioo rotation link is forwarded, the unfurled card shows a real PNG image with round 1's court matchups and the roster, instead of today's static generic card — without changing `trulioo-badminton.onrender.com` or breaking it for a moment.

**Architecture:** A new route on the Worker's own domain (`trulioo.courtly.ryanxu.dev`, already live, already Trulioo's) becomes the link people actually share. Visiting it either 302s straight to the real app (no/invalid/unrenderable schedule code) or serves a tiny server-rendered HTML page with schedule-aware `og:`/`twitter:` meta tags and a generated PNG, then bounces real browsers on to the real app via meta-refresh. The PNG itself is rendered by a new `GET /api/schedule/:code/og.png` route added to the existing shared Worker app (`worker/src/index.js`), reusing `workers-og`'s `ImageResponse`.

**Tech Stack:** Cloudflare Workers (Hono), `workers-og` (new dependency, Satori-based HTML→PNG), Node's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-11-26-trulioo-link-preview-card-design.md` — read it alongside this plan; the approved visual mockup it references (`docs/superpowers/specs/assets/2026-11-26-trulioo-link-preview-card/approved-mockup.html`) is the source of truth for every pixel value used below.

## Global Constraints

- Canvas: 1200×630 PNG (same ~1.91:1 ratio as the existing static asset).
- Court cap: show at most 3 court blocks from round 1; a 4th slot becomes a "+N courts" overflow tile. Never shrink blocks to fit more than 3.
- Roster cap: show at most 6 avatar initials; a 7th slot becomes a "+N" overflow avatar. Footer text is always `"{playerCount} playing tonight"`.
- The new shared link is `https://trulioo.courtly.ryanxu.dev/?scheduleCode=:code` — a query param on the existing custom domain, not a new path segment.
- `https://trulioo-badminton.onrender.com` and every meta tag baked into its `index.html` stay byte-for-byte unchanged. Nothing in this plan edits that static file's `<head>`.
- `?scheduleCode=current` must be treated exactly like a real `BADM-XXXX` code everywhere in the new code — it already resolves correctly through `handleGetSchedule`/`loadCurrentSchedule`, so the only thing that can break this is a regex that doesn't admit the literal string `current`.
- Courtly (`courtly.ryanxu.dev`, `courtly-entry.js`, `wrangler.courtly.toml`) is untouched by this plan. Do not edit those files.
- `APP_VERSION` (`index.html`), `package.json`, and `worker/package.json` must all match at the end (minor bump — this is a new user-facing feature, not a fix).

## Review Focus

1. **Invalid, missing, or unresolvable `scheduleCode`** (bad shape, or a well-formed code with no matching schedule in KV) — must 302 straight to `https://trulioo-badminton.onrender.com/` (or `/?scheduleCode=X` if the code was at least well-formed), never render a blank/broken card or return a 500.
2. **`?scheduleCode=current`** — must flow through every new code path (the landing route's regex, the `og.png` route's regex) exactly like a real code; it's real-world the single highest-value case (the standing link meant to be reused forever).
3. **Round 1 with more than 3 courts** — overflow tile renders correctly, no crash, no shrinking.
4. **A roster with more than 6 players** — overflow avatar + correct `{n} playing tonight` text, footer doesn't wrap.
5. **A singles court in round 1** (`{a: [name], b: [name], singles: true}`) — the team label must show the one player's name, not break on an assumption that `a`/`b` always have two entries.

---

### Task 1: Spike — prove `workers-og` renders a real PNG in this Worker

**Files:**
- Modify: `worker/package.json` (add `workers-og` dependency)
- No product code yet — this is a go/no-go gate per the project's "prove it can work before you build it" rule. Nothing from this task ships; it only unblocks Task 3.

**Interfaces:**
- Produces: confidence that `import { ImageResponse } from 'workers-og'` works under this Worker's exact `compatibility_date`/`compatibility_flags` (`worker/wrangler.toml`), before any real card logic is written on top of it.

- [ ] **Step 1: Install the dependency**

Run: `cd worker && npm install workers-og`
Expected: `workers-og` appears in `worker/package.json` dependencies and `worker/package-lock.json` (or equivalent) is created/updated.

- [ ] **Step 2: Write a throwaway probe route**

Temporarily add, anywhere reachable in `worker/src/index.js` (e.g. `app.get('/__og-probe', ...)`), a handler that returns:
```js
new ImageResponse('<div style="display:flex;width:100%;height:100%;background:#172D2D;color:#fff;font-size:48px;align-items:center;justify-content:center">hello</div>', { width: 1200, height: 630 })
```

- [ ] **Step 3: Run it under `wrangler dev` and verify**

Run: `cd worker && npx wrangler dev`, then in another shell: `curl -s -o /tmp/probe.png -D - http://localhost:8787/__og-probe` followed by `file /tmp/probe.png`
Expected: HTTP 200, `content-type: image/png`, and `file` reports a valid PNG at 1200x630. Open `/tmp/probe.png` and visually confirm the text rendered (not blank, not mojibake — this is the real risk: default font availability).

- [ ] **Step 4: Stop and report if it fails**

If Step 3 doesn't produce a real, legible PNG: stop here, do not proceed to Task 2 or beyond. Report what broke (bundle/build error, blank image, missing text, wrong dimensions) back before any further work — this is exactly the kind of dependency risk the design doc flagged an alternative for (hand-rolled SVG + a bare WASM PNG renderer), and that alternative needs real re-scoping, not a quick patch.

- [ ] **Step 5: Remove the throwaway probe route**

Delete the `/__og-probe` handler added in Step 2. Keep the `workers-og` dependency in `worker/package.json`.

---

### Task 2: `worker/src/og-card.js` — card data, text, and HTML building (pure, no Worker runtime APIs)

**Files:**
- Create: `worker/src/og-card.js`
- Test: `tests/og-card.test.js`

**Interfaces:**
- Consumes: a `schedule` object shaped exactly like the Worker's existing stored schedules — confirmed live shape: `{ players: string[], numCourts: number, sport: string, generatedAt: string (ISO), rounds: [{ subs: string[], courts: [{ a: string[], b: string[], singles: boolean }] }, ...] }`.
- Produces (used by Task 3):
  - `export const MAX_COURTS_SHOWN = 3`
  - `export const MAX_AVATARS_SHOWN = 6`
  - `export function buildOgCardData(schedule): CardData | null`
  - `export function buildCardMetaText(schedule): { title: string, description: string } | null`
  - `export function renderOgCardHtml(cardData: CardData): string`

This file must have zero imports from `workers-og` or any Workers-only global (no `HTMLRewriter`, no `ImageResponse`) — it is plain data/string logic so it can be tested directly under Node. `worker/package.json` sets `"type": "module"`, so these are real ES module exports; the test file (root-level, CommonJS) loads them with a dynamic `import()`, not `require()`. Step 6 imports one named export (`sportLabel`) from `./index.js`, which also executes that file's module-level `createWorkerApp()` call as a side effect — this is pure JS (no Workers-only globals touched at construction time, only inside handlers this module never calls), so it's expected to import cleanly under plain Node. If it doesn't (surprising import error), the fallback is to copy `sportLabel`'s small body directly into `og-card.js` instead of importing it — don't spend more than a few minutes chasing an import issue before taking that shortcut.

- [ ] **Step 1: Write the failing tests for `buildOgCardData`**

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');

async function loadOgCard() {
  return import('../worker/src/og-card.js');
}

test('buildOgCardData: caps courts at 3 with an overflow count', async () => {
  const { buildOgCardData } = await loadOgCard();
  const schedule = makeSchedule({ courts: 5, players: 20 }); // helper built in this step, see below
  const data = buildOgCardData(schedule);
  assert.equal(data.courts.length, 3);
  assert.equal(data.overflowCourtCount, 2);
});

test('buildOgCardData: caps avatars at 6 with an overflow count and a playing-tonight count', async () => {
  const { buildOgCardData } = await loadOgCard();
  const schedule = makeSchedule({ courts: 2, players: 10 });
  const data = buildOgCardData(schedule);
  assert.equal(data.avatars.length, 6);
  assert.equal(data.overflowPlayerCount, 4);
  assert.equal(data.playingCount, 10);
});

test('buildOgCardData: a singles court in round 1 shows the one player on each side', async () => {
  const { buildOgCardData } = await loadOgCard();
  const schedule = makeSchedule({ courts: 1, players: 2, singles: true });
  const data = buildOgCardData(schedule);
  assert.equal(data.courts[0].teamA, 'Alice');
  assert.equal(data.courts[0].teamB, 'Bob');
});

test('buildOgCardData: returns null for a schedule missing round 1', async () => {
  const { buildOgCardData } = await loadOgCard();
  assert.equal(buildOgCardData({ players: [], rounds: [] }), null);
});
```

Write a small local `makeSchedule({ courts, players, singles })` test helper in this file that builds a minimal valid schedule object matching the live shape above (round 1 only needs to be realistic — later rounds can be omitted). For the singles case, build exactly one court: `{ a: ['Alice'], b: ['Bob'], singles: true }`.

`CardData` shape these tests pin: `{ roundLabel: string, dateLabel: string, courts: [{ teamA: string, teamB: string }], overflowCourtCount: number, avatars: [{ initial: string, color: 'green'|'blue' }], overflowPlayerCount: number, playingCount: number }`. `teamA`/`teamB` are the display strings for each side — join a team's player names with `' & '` (this already produces the correct single-name string for a 1-length array with no special-casing needed).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/og-card.test.js`
Expected: FAIL — `worker/src/og-card.js` does not exist yet.

- [ ] **Step 3: Implement `buildOgCardData(schedule)`**

Return `null` if `schedule?.rounds?.[0]` or `Array.isArray(schedule?.players)` is falsy (mirror `courtly-entry.js`'s `buildScheduleMeta` defensive style — a broken card must never throw).
- `roundLabel`: `` `ROUND 1 OF ${schedule.rounds.length}` ``
- `dateLabel`: format `schedule.generatedAt` with `new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric' })` — produces `"Sat Nov 28"`, matching the approved mockup's header exactly (note this includes `weekday`, which Courtly's existing `buildScheduleMeta` text format does not — the mockup does, so this does).
- `courts`: `schedule.rounds[0].courts`, sliced to `MAX_COURTS_SHOWN`, each mapped to `{ teamA: court.a.join(' & '), teamB: court.b.join(' & ') }`.
- `overflowCourtCount`: `Math.max(0, schedule.rounds[0].courts.length - MAX_COURTS_SHOWN)`.
- `avatars`: `schedule.players`, sliced to `MAX_AVATARS_SHOWN`, each mapped to `{ initial: name.trim()[0].toUpperCase(), color: index % 2 === 0 ? 'green' : 'blue' }` (alternating, matching the mockup's striped look).
- `overflowPlayerCount`: `Math.max(0, schedule.players.length - MAX_AVATARS_SHOWN)`.
- `playingCount`: `schedule.players.length`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/og-card.test.js`
Expected: PASS for all `buildOgCardData` tests.

- [ ] **Step 5: Write the failing tests for `buildCardMetaText`**

```js
test('buildCardMetaText: mirrors Courtly\'s text shape with sport, headcount, courts, rounds, date', async () => {
  const { buildCardMetaText } = await loadOgCard();
  const schedule = makeSchedule({ courts: 2, players: 10, sport: 'badminton' });
  const meta = buildCardMetaText(schedule);
  assert.equal(meta.title, 'Badminton · 10 players');
  assert.match(meta.description, /^10 players · 2 courts · \d+ rounds · [A-Za-z]{3} \d{1,2}$/);
});

test('buildCardMetaText: returns null for an unrenderable schedule', async () => {
  const { buildCardMetaText } = await loadOgCard();
  assert.equal(buildCardMetaText({ players: [], rounds: [] }), null);
});
```

- [ ] **Step 6: Run tests to verify they fail, then implement `buildCardMetaText(schedule)`**

Same null-guard as `buildOgCardData`. `title`: `` `${sportLabel(schedule.sport)} · ${schedule.players.length} players` `` — import `sportLabel` from `./index.js`. `description`: `` `${schedule.players.length} players · ${schedule.numCourts} courts · ${schedule.rounds.length} rounds · ${dateStr}` `` where `dateStr` uses Courtly's existing shorter format (`{ timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' }`, no weekday) — deliberately different from `roundLabel`'s date format in Step 3, which matches the rendered image, not the text meta tag.

Run: `node --test tests/og-card.test.js` — expect FAIL then PASS.

- [ ] **Step 7: Write the failing test for `renderOgCardHtml`**

```js
test('renderOgCardHtml: embeds every court matchup, the overflow tile, and the avatar/overflow footer', async () => {
  const { buildOgCardData, renderOgCardHtml } = await loadOgCard();
  const data = buildOgCardData(makeSchedule({ courts: 5, players: 20 }));
  const html = renderOgCardHtml(data);
  assert.match(html, /ROUND 1 OF/);
  assert.ok(html.includes(data.courts[0].teamA));
  assert.ok(html.includes(data.courts[0].teamB));
  assert.match(html, /\+2[^\d]*courts/i);
  assert.match(html, /\+14/); // overflow avatar count
  assert.match(html, /20 playing tonight/);
});
```

- [ ] **Step 8: Run test to verify it fails, then implement `renderOgCardHtml(cardData)`**

Build the HTML string using **inline `style="..."` attributes only** — `workers-og`'s Satori-based renderer parses per-element inline styles, not a `<style>` block with class selectors, so the approved mockup's CSS classes (`.B-head`, `.B-court`, etc.) must be flattened to inline styles on each element. Lift every color/spacing/font-size value from `docs/superpowers/specs/assets/2026-11-26-trulioo-link-preview-card/approved-mockup.html`'s `.B` rules verbatim — do not invent new values. Render: header (logo dot + "Courtly" wordmark, left; `roundLabel` + `dateLabel` stacked, right), up to 3 court blocks from `cardData.courts` (team/VS/team), the overflow tile only if `cardData.overflowCourtCount > 0` (text: `` `+${n} courts` ``), footer with one circle per `cardData.avatars` entry (green/blue per its `color`) in overlapping-circle style, one more circle for `` `+${overflowPlayerCount}` `` only if `cardData.overflowPlayerCount > 0`, and right-aligned `` `${playingCount} playing tonight` ``.

Run: `node --test tests/og-card.test.js` — expect FAIL then PASS.

- [ ] **Step 9: Run the full new test file once more and commit**

Run: `node --test tests/og-card.test.js`
Expected: all tests PASS.

```bash
git add worker/src/og-card.js tests/og-card.test.js worker/package.json
git commit -m "feat: add Trulioo OG card data/text/HTML building"
```

---

### Task 3: Wire `GET /api/schedule/:code/og.png` into the shared Worker app

**Files:**
- Modify: `worker/src/index.js`

**Interfaces:**
- Consumes: `loadSchedule`, `loadCurrentSchedule`, `isPublicMode` (all already defined in this file); `buildOgCardData`, `renderOgCardHtml` from `./og-card.js` (Task 2); `ImageResponse` from `workers-og` (Task 1).
- Produces: a registered Hono route other code (Task 4) links to by URL. No new exports needed — this route is reached only by URL, never called from JS elsewhere in this codebase.

- [ ] **Step 1: Add the imports and the route**

At the top of the file, alongside the existing `import QRCode from './qrcode-svg.js';`, add:
```js
import { ImageResponse } from 'workers-og';
import { buildOgCardData, renderOgCardHtml } from './og-card.js';
```
In `createWorkerApp()`, alongside the existing `/api/schedule/:code` family, register:
```js
app.get('/api/schedule/:code/og.png', handleScheduleOgImage);
```

- [ ] **Step 2: Implement `async function handleScheduleOgImage(c)`**

- `code = c.req.param('code')`.
- Resolve the schedule exactly like `handleGetSchedule` does: `code === 'current' ? await loadCurrentSchedule(c.env) : await loadSchedule(c.env, code)` — reuse this exact ternary, don't call `handleGetSchedule` itself (it returns JSON, not what this route needs). Note `isPublicMode` is irrelevant here: this route only ever runs on Trulioo's deployment (Courtly never links to it), but leave Courtly's own `current`-in-public-mode 404 behavior in `handleGetSchedule` untouched regardless.
- If no schedule, or `buildOgCardData(schedule)` returns `null`: respond with a 302 redirect to `https://trulioo-badminton.onrender.com/og-trulioo.png` (the existing static asset, unchanged). This hand-rolled `Hono` class (defined earlier in this same file — it is not the real `hono` npm package) has no `c.redirect()` helper; `toResponse()` passes a real `Response` instance through unchanged, so just `return Response.redirect('https://trulioo-badminton.onrender.com/og-trulioo.png', 302);` directly.
- Otherwise: `return new ImageResponse(renderOgCardHtml(buildOgCardData(schedule)), { width: 1200, height: 630 })`, then set `Cache-Control: public, max-age=300` on the response before returning it (short-lived — per the design doc, we don't control downstream platform caching anyway, this just avoids re-rendering on a burst of near-simultaneous crawler hits).
- Wrap the whole body in try/catch; on any thrown error, fall back to the same 302-to-static-asset response as the "no schedule" case — a broken render must never surface as a 500.

- [ ] **Step 3: Verify manually under `wrangler dev`**

Run: `cd worker && npx wrangler dev`. Generate a real schedule first (`curl -X POST http://localhost:8787/api/schedule -d '{"players":[...8 names...],"numCourts":2,"sport":"badminton"}' -H 'Content-Type: application/json'`), note the returned `scheduleCode`, then:
`curl -s -o /tmp/card.png -D - "http://localhost:8787/api/schedule/<code>/og.png"` and `file /tmp/card.png`.
Expected: HTTP 200, `content-type: image/png`, `file` reports 1200x630, and opening `/tmp/card.png` visually matches the approved mockup's layout with this schedule's real data.
Also verify the 302 fallback: `curl -s -D - "http://localhost:8787/api/schedule/BADM-ZZZZ/og.png"` (a code that doesn't exist) returns a 302 to the static asset URL.

- [ ] **Step 4: Run the full existing test suite to confirm nothing broke**

Run: `npm test`
Expected: all existing tests still PASS (this task only adds a route; it doesn't touch any function another test exercises).

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.js
git commit -m "feat: add GET /api/schedule/:code/og.png route"
```

---

### Task 4: `worker/src/trulioo-entry.js` — the landing/redirect page

**Files:**
- Create: `worker/src/trulioo-entry.js`
- Modify: `worker/wrangler.toml:2` (`main = "src/index.js"` → `main = "src/trulioo-entry.js"`)
- Modify: `worker/src/index.js` (export block near the bottom of the file — add `loadSchedule`, `loadCurrentSchedule`)

**Interfaces:**
- Consumes: `worker` (default export) and `ScheduleRoom` from `./index.js`; `loadSchedule`, `loadCurrentSchedule` from `./index.js`; `buildOgCardData`, `buildCardMetaText` from `./og-card.js` (Task 2).
- Produces: the actual `fetch` handler Cloudflare runs for `trulioo.courtly.ryanxu.dev` (this becomes `main` in `worker/wrangler.toml`), mirroring `courtly-entry.js`'s existing wrap-and-fall-through shape exactly.

This file follows `worker/src/courtly-entry.js`'s established pattern closely — read that file before writing this one.

- [ ] **Step 1: Export `loadSchedule` and `loadCurrentSchedule` from `index.js`**

Neither is in the existing `export { ... }` block near the bottom of `worker/src/index.js` today (checked — only `handleGetSchedule`, which wraps them, is exported). Add both names to that block; this is the one change this task makes to `index.js`.

- [ ] **Step 2: Create `trulioo-entry.js` with its imports and re-export of `ScheduleRoom`**

```js
import worker, { loadSchedule, loadCurrentSchedule } from './index.js';
import { buildOgCardData, buildCardMetaText } from './og-card.js';

export { ScheduleRoom } from './index.js';
```
(The `ScheduleRoom` re-export is required for the same reason `courtly-entry.js` does it: the Durable Object class must be exported from whatever file `main` points at.)

- [ ] **Step 3: Implement the schedule-code regex**

`const SCHEDULE_CODE_RE = /^(current|BADM-[A-Z0-9]{4})$/;` — note this explicitly admits the literal `current`, unlike `courtly-entry.js`'s copy of this same pattern (which doesn't need to, since Courtly 404s `current` anyway).

- [ ] **Step 4: Implement `buildRedirectUrl(code)`**

`` `https://trulioo-badminton.onrender.com/?scheduleCode=${encodeURIComponent(code)}` ``

- [ ] **Step 5: Implement `async function renderLandingPage(request, env, code)`**

- Load the schedule the same way Task 3's route does (`code === 'current' ? loadCurrentSchedule(env) : loadSchedule(env, code)`).
- Call `buildOgCardData(schedule)` and `buildCardMetaText(schedule)`. If either is `null`, return `null` from this function (caller falls back to a plain redirect — see Step 6).
- Otherwise return an HTML string containing: `<meta charset>`, `<title>` and `og:site_name`/`og:title`/`twitter:title` set to `meta.title`, `og:description`/`twitter:description` set to `meta.description`, `og:url` set to the page's own URL (`https://trulioo.courtly.ryanxu.dev/?scheduleCode=${code}`), `og:image`/`twitter:image` set to `` `https://trulioo.courtly.ryanxu.dev/api/schedule/${code}/og.png` ``, `og:image:width`/`og:image:height` set to `1200`/`630`, `twitter:card` set to `summary_large_image`, a `<meta http-equiv="refresh" content="0;url=${buildRedirectUrl(code)}">`, and a visible fallback link (`<a href="${buildRedirectUrl(code)}">`) in the body for the rare case a refresh is blocked.
- Wrap in try/catch; any thrown error returns `null` (same fallback as the "meta text came back null" case).

- [ ] **Step 6: Implement the `fetch` handler**

```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isPageRequest = request.method === 'GET' || request.method === 'HEAD';
    if (isPageRequest && (url.pathname === '/' || url.pathname === '/index.html')) {
      const code = url.searchParams.get('scheduleCode');
      if (code && SCHEDULE_CODE_RE.test(code)) {
        const html = await renderLandingPage(request, env, code);
        if (html) {
          return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate' } });
        }
        return Response.redirect(buildRedirectUrl(code), 302);
      }
      return Response.redirect('https://trulioo-badminton.onrender.com/', 302);
    }
    return worker.fetch(request, env, ctx);
  },
};
```

- [ ] **Step 7: Point `worker/wrangler.toml` at the new entry**

Change line 2 from `main = "src/index.js"` to `main = "src/trulioo-entry.js"`.

- [ ] **Step 8: Verify manually under `wrangler dev`**

Run: `cd worker && npx wrangler dev`. Using a real generated code from Task 3's verification:
- `curl -s -D - "http://localhost:8787/?scheduleCode=<code>"` → expect 200, `text/html`, body contains the `og:image` tag pointing at `.../api/schedule/<code>/og.png` and the meta-refresh tag.
- `curl -s -D - "http://localhost:8787/?scheduleCode=current"` → same shape (prove the `current` pseudo-code works end-to-end through this new file, not just through `handleGetSchedule` in isolation).
- `curl -s -D - "http://localhost:8787/?scheduleCode=BADM-ZZZZ"` (nonexistent) → expect a 302 to `buildRedirectUrl('BADM-ZZZZ')`.
- `curl -s -D - "http://localhost:8787/"` (no code at all) → expect a 302 straight to `https://trulioo-badminton.onrender.com/`.
- `curl -s -D - "http://localhost:8787/api/health"` → expect this still falls through to the shared app unchanged (200, JSON health payload) — confirms the fallthrough to `worker.fetch` still works for every non-`/` path.

- [ ] **Step 9: Run the full existing test suite**

Run: `npm test`
Expected: all PASS — Step 1's export addition doesn't change any existing function's behavior, only what's visible outside the module, so no existing test should be affected.

- [ ] **Step 10: Commit**

```bash
git add worker/src/index.js worker/src/trulioo-entry.js worker/wrangler.toml
git commit -m "feat: serve Trulioo's dynamic link-preview landing page from trulioo.courtly.ryanxu.dev"
```

---

### Task 5: `index.html` — point the share link at the new domain

**Files:**
- Modify: `index.html` (the `getShareBaseUrl()` function, currently one line)

**Interfaces:**
- Consumes: `IS_COURTLY` (already defined above it in the file).
- Produces: the value every share-link/QR/copy-link call in the file already reads via `getShareBaseUrl()` — no caller changes.

- [ ] **Step 1: Replace `getShareBaseUrl()`**

Find:
```js
function getShareBaseUrl(){return location.protocol==='file:'?'https://trulioo-badminton.onrender.com':location.origin;}
```
Replace with:
```js
function getShareBaseUrl(){
  if(location.protocol==='file:') return 'https://trulioo.courtly.ryanxu.dev';
  if(location.hostname==='localhost'||location.hostname==='127.0.0.1') return location.origin;
  return IS_COURTLY?location.origin:'https://trulioo.courtly.ryanxu.dev';
}
```
Courtly's behavior (`location.origin`, same-origin Worker+frontend) is completely unchanged for both the `file:` case (which it never hits — Courtly is never opened via `file://` since it's a public, hosted-only product) and the real-host case. Local dev (`localhost`/`127.0.0.1`) is unchanged for both brands, so local share-link testing still points at whatever's actually running locally.

- [ ] **Step 2: Manual browser check**

Serve the app locally per `CLAUDE.md`'s "How It Runs" (`npm start`, then open `index.html` via `python3 -m http.server 8000` or similar), generate a schedule, open the "Share QR" popover, and confirm the displayed/copyable link still reads `http://localhost:8000/?scheduleCode=...` (unaffected — this exercises the `localhost` branch, not the new one).

Then temporarily hardcode `IS_COURTLY=false` and comment out the `localhost` check to confirm the function returns `https://trulioo.courtly.ryanxu.dev/?scheduleCode=...` for the production branch — revert this temporary edit immediately after confirming (it's a throwaway check, not a code change to keep).

- [ ] **Step 3: Run the existing test suite**

Run: `npm test`
Expected: PASS (no existing test references `getShareBaseUrl`, confirmed earlier — this change is net-new surface for Task 6 to cover).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: point Trulioo's share link at trulioo.courtly.ryanxu.dev"
```

---

### Task 6: Test coverage — `tests/api-contract.test.js` and `tests/smoke/production.test.js`

**Files:**
- Modify: `tests/api-contract.test.js`
- Modify: `tests/smoke/production.test.js`

**Interfaces:**
- Consumes: `workerRoutes()`, `UNCALLED_BY_SPA` (existing, in `api-contract.test.js`).

- [ ] **Step 1: Allowlist the new route in `api-contract.test.js`**

Add `'GET /api/schedule/:code/og.png'` to `UNCALLED_BY_SPA`, with a one-line comment matching the existing entries' style (e.g. `// dynamic OG image, linked from trulioo-entry.js's landing page meta tags, never fetched by the SPA's own JS`).

- [ ] **Step 2: Run `npm test` to confirm the allowlist addition is accepted**

Run: `npm test`
Expected: `UNCALLED_BY_SPA has no stale entries` and `every Worker route has a caller in the SPA or is allowlisted` both PASS.

- [ ] **Step 3: Add live checks to `tests/smoke/production.test.js`**

Add two new tests, after the existing per-brand `/health` checks, that generate a throwaway real schedule first (so the test doesn't depend on a fixed code existing forever):

```js
test('trulioo.courtly.ryanxu.dev serves a dynamic landing page for a real schedule code', async () => {
  const genRes = await fetchWithTimeout('https://trulioo.courtly.ryanxu.dev/api/schedule', TIMEOUT_MS /* but POST, so build the request options for method/body/headers accordingly */);
  // POST { players: [8 names], numCourts: 2, sport: 'badminton' }, assert genRes.ok, read scheduleCode from the JSON body
  const pageRes = await fetchWithTimeout(`https://trulioo.courtly.ryanxu.dev/?scheduleCode=${scheduleCode}`, TIMEOUT_MS);
  assert.strictEqual(pageRes.status, 200);
  const html = await pageRes.text();
  assert.match(html, /og:image/);
  assert.match(html, new RegExp(`/api/schedule/${scheduleCode}/og\\.png`));
});

test('the generated og.png is a real PNG at 1200x630', async () => {
  // reuse the scheduleCode from the previous test (or generate a fresh one — either is fine, this is a smoke test, not asserting shared state)
  const imgRes = await fetchWithTimeout(`https://trulioo.courtly.ryanxu.dev/api/schedule/${scheduleCode}/og.png`, TIMEOUT_MS);
  assert.strictEqual(imgRes.status, 200);
  assert.strictEqual(imgRes.headers.get('content-type'), 'image/png');
  const bytes = new Uint8Array(await imgRes.arrayBuffer());
  assert.deepStrictEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic bytes
});
```

Use `fetchWithTimeout` exactly as already defined in this file; add a `TIMEOUT_MS`-respecting POST variant inline (pass `{ method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(...) }` as a second-argument options object, extending `fetchWithTimeout`'s signature to accept and forward `init` options — check its current signature in this file before assuming it already supports this).

- [ ] **Step 4: Run the smoke suite**

Run: `npm run test:smoke`
Expected: all PASS, including the two new tests, against live production (this only works correctly once Tasks 3 and 4 are actually deployed — see Task 7's deploy step; if run before that, these two new tests will legitimately fail, which is expected and fine).

- [ ] **Step 5: Commit**

```bash
git add tests/api-contract.test.js tests/smoke/production.test.js
git commit -m "test: cover the new Trulioo OG card route and landing page"
```

---

### Task 7: Version bump, final verification, deploy

**Files:**
- Modify: `index.html` (`APP_VERSION`)
- Modify: `package.json` (`version`)
- Modify: `worker/package.json` (`version`)

**Interfaces:** none — this task only touches version strings and runs verification.

- [ ] **Step 1: Bump all three version strings together**

Pick the next minor version (new user-facing feature, not a fix) — read the current `APP_VERSION` in `index.html` first and increment the minor component, setting patch to `0`. Set the same value in `package.json`'s `version` and `worker/package.json`'s `version`.

- [ ] **Step 2: Run the full check + test suite**

Run: `npm run check && npm test`
Expected: all PASS, including the `the three version numbers agree` test in `tests/api-contract.test.js`.

- [ ] **Step 3: Deploy the Worker**

Run: `cd worker && npm run deploy` (deploys `worker/wrangler.toml`'s `main`, now `src/trulioo-entry.js`, to `badminton-scheduler-api` / `trulioo.courtly.ryanxu.dev`).
This is the one step in this plan with real production blast radius — it's Trulioo's live, currently-working API Worker. Confirm with your human partner before running this step if executing autonomously.

- [ ] **Step 4: Run the smoke suite against the now-live deploy**

Run: `npm run test:smoke`
Expected: all PASS, including Task 6's two new live tests, now that the real route exists in production.

- [ ] **Step 5: Push `index.html`'s version/share-link change so Render redeploys**

The Worker deploy in Step 3 is independent of Render's auto-deploy of `index.html` (per `REFACTOR.md`'s deployment-shape notes) — pushing to `main` (or merging a PR into it) triggers Render separately. Confirm with your human partner before pushing/merging to `main`.

- [ ] **Step 6: Manual end-to-end check**

Generate a real schedule in the live app, open the "Share QR" popover, confirm the link now reads `trulioo.courtly.ryanxu.dev/?scheduleCode=...`, paste that URL into a browser tab and confirm it lands on the real app within about a second. Then paste the same URL into any link-preview debugger/unfurl tool you have on hand and confirm the card shows round 1's matchups and the roster, matching the approved mockup.

- [ ] **Step 7: Final commit**

```bash
git add index.html package.json worker/package.json
git commit -m "chore: bump version for the Trulioo dynamic link-preview card"
```
