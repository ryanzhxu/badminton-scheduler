# Dinner Finder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standing, shared list of restaurants near Badminton Vancouver that the group hasn't tried (or rarely has), surfaced on a new Trulioo-only "Dinner" tab, with an add-time Maps/Directions lookup (SerpApi) and a check-off action — no live search button.

**Architecture:** Three new Worker-only endpoints (`/api/dinner/restaurants` GET/POST, `/api/dinner/restaurants/:id/visit` POST) backed by one KV list, following the existing Leaderboard/Sessions endpoint pattern exactly. SerpApi calls happen only inside the add endpoint, never on list/view. Frontend is a new tab following the existing Leaderboard-tab pattern (`BRAND.showLeaderboard` → `BRAND.showDinnerFinder`).

**Tech Stack:** Cloudflare Worker (Hono), Cloudflare KV, SerpApi (Google Maps + Directions engines), vanilla JS/HTML/CSS (SPA) — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-08-dinner-finder-design.md`

## Global Constraints

- Worker-only — `server.js` is not touched (matches the existing Leaderboard/Sessions/Player-detail precedent).
- Trulioo-only — gated by `isPublicMode(c.env)` in the Worker (reject with 404 for the Courtly/public deployment) and by a new `BRAND.showDinnerFinder` flag in the frontend (`false` for Courtly, `true` for Trulioo).
- The SerpApi key is a Worker secret (`SERPAPI_KEY`), set via `wrangler secret put SERPAPI_KEY` — never in `wrangler.toml`, never sent to the client. The user already has a SerpApi account/key.
- Hard 20-minute drive cutoff on add — reject (400), don't store, don't show greyed out.
- No automated test suite for the new endpoints (matches the Leaderboard/Sessions precedent) — verified via `node --check` plus manual curl/UI checks.
- No open-hours gate on the add endpoint — hours are vetted once, manually, during the Task 5 seeding pass, not automated.
- Badminton Vancouver center point: lat `49.2046`, lng `-123.0795` (110-13100 Mitchell Rd, Richmond, BC V6V 1M8) — web-geocoded during design; sanity-check against SerpApi's own response the first time Task 2 is exercised with a real key, and correct the constant if it's meaningfully off.

## Review Focus

- Adding a restaurant whose name matches nothing on Maps, or that SerpApi can't resolve: must return a clear 400, not a crash or a half-written KV entry — exercised by Task 2.
- Adding a restaurant more than 20 minutes away: must be rejected before it's ever written to KV — exercised by Task 2.
- Adding a restaurant that's already in the list (same SerpApi place id), once as not-yet-visited and once marking "already been here": must update the existing entry's `visited` flag rather than creating a duplicate row — exercised by Task 2.
- A Courtly (public-mode) request hitting any of the three new endpoints directly: must get a 404, not Trulioo's data — exercised by Task 2.
- Checking off a restaurant that doesn't exist (bad `:id`): must return a clear 404, not a silent no-op or crash — exercised by Task 2.

---

### Task 1: KV storage helpers for the restaurant list

**Files:**
- Modify: `worker/src/index.js` (near the other `*_KEY` constants at the top, and near `loadScheduleIndex`/`addToScheduleIndex`)

**Interfaces:**
- Produces: `loadDinnerRestaurants(env): Promise<Restaurant[]>`, `saveDinnerRestaurants(env, list): Promise<void>`, where `Restaurant = { id, name, address, cuisine, distanceMeters, driveMinutes, visited }` — consumed by Task 2's handlers.

- [ ] **Step 1: Add the KV key constant**

  Near `worker/src/index.js:15` (`const SCHEDULE_INDEX_KEY = 'schedules:index';`), add:
  ```js
  const DINNER_RESTAURANTS_KEY = 'dinner:restaurants';
  ```

- [ ] **Step 2: Add load/save helpers**

  Near `loadScheduleIndex`/`addToScheduleIndex` (`worker/src/index.js:694-706`), add:
  ```js
  async function loadDinnerRestaurants(env) {
    return getJson(env.SCHEDULES, DINNER_RESTAURANTS_KEY, []);
  }
  async function saveDinnerRestaurants(env, list) {
    await putJson(env.SCHEDULES, DINNER_RESTAURANTS_KEY, list);
  }
  ```
  (Uses the same `env.SCHEDULES` KV binding and `getJson`/`putJson` helpers the registry/index already use — no new binding needed.)

- [ ] **Step 3: Syntax check**

  Run: `node --check worker/src/index.js`
  Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

  ```bash
  git add worker/src/index.js
  git commit -m "feat: add KV storage helpers for the dinner restaurant list"
  ```

---

### Task 2: SerpApi client + the three Worker endpoints

**Files:**
- Modify: `worker/src/index.js` (add SerpApi helpers near the top-level constants, add three handlers near `handleLeaderboard`/`handleSessions`, register routes near `worker/src/index.js:1619-1634`)

**Interfaces:**
- Consumes: `loadDinnerRestaurants`/`saveDinnerRestaurants` (Task 1), `isPublicMode(env)` (`worker/src/index.js:20`).
- Produces: `GET /api/dinner/restaurants` → `{ restaurants: Restaurant[] }` (not-yet-visited only); `POST /api/dinner/restaurants` body `{ name, alreadyBeenHere }` → `{ restaurant: Restaurant }` or `{ error }`; `POST /api/dinner/restaurants/:id/visit` → `{ restaurant: Restaurant }` or `{ error }`.

- [ ] **Step 1: Add the venue center-point constant and SerpApi fetch helpers**

  Near the other geography/constant blocks, add:
  ```js
  const BADMINTON_VANCOUVER_COORDS = { lat: 49.2046, lng: -123.0795 };
  const SERPAPI_BASE_URL = 'https://serpapi.com/search.json';
  ```
  Add two helpers:
  ```js
  async function serpApiMapsSearch(env, query) {
    const url = `${SERPAPI_BASE_URL}?engine=google_maps&type=search&q=${encodeURIComponent(query)}&ll=@${BADMINTON_VANCOUVER_COORDS.lat},${BADMINTON_VANCOUVER_COORDS.lng},14z&api_key=${env.SERPAPI_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SerpApi Maps search failed: HTTP ${res.status}`);
    return res.json();
  }
  async function serpApiDirections(env, destLat, destLng) {
    const origin = `${BADMINTON_VANCOUVER_COORDS.lat},${BADMINTON_VANCOUVER_COORDS.lng}`;
    const destination = `${destLat},${destLng}`;
    const url = `${SERPAPI_BASE_URL}?engine=google_maps_directions&start_addr=${encodeURIComponent(origin)}&end_addr=${encodeURIComponent(destination)}&travel_mode=0&api_key=${env.SERPAPI_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SerpApi Directions failed: HTTP ${res.status}`);
    return res.json();
  }
  ```
  (Exact SerpApi query parameter names/values — `type=search`, `travel_mode=0`, the directions request shape — are the design doc's "left to the builder": verify against SerpApi's actual current docs/a real key during this step, and adjust the helper if the real API shape differs from this starting point.)

- [ ] **Step 2: Add a response-parsing helper**

  Add a small helper that takes a raw `serpApiMapsSearch` JSON response and extracts `{ id, name, address, cuisine, lat, lng }` from its first result (look for `local_results[0]` or `place_results`, whichever the engine returns for a direct name query — confirm shape against a real response during this step), returning `null` if nothing usable is found. Add a second helper that takes a raw `serpApiDirections` response and extracts `{ distanceMeters, driveMinutes }` from its first route leg.

- [ ] **Step 3: `POST /api/dinner/restaurants` handler**

  ```js
  async function handleAddDinnerRestaurant(c) {
    if (isPublicMode(c.env)) return c.json({ error: 'Not available' }, 404);
    const body = await c.req.json();
    const { name, alreadyBeenHere } = body ?? {};
    if (!name || typeof name !== 'string') return c.json({ error: 'Missing name' }, 400);

    const searchResult = await serpApiMapsSearch(c.env, name);
    const place = /* parse via Step 2's helper */;
    if (!place) return c.json({ error: 'Could not find that restaurant' }, 400);

    const dirResult = await serpApiDirections(c.env, place.lat, place.lng);
    const { distanceMeters, driveMinutes } = /* parse via Step 2's helper */;
    if (driveMinutes > 20) return c.json({ error: 'Too far — over a 20-minute drive' }, 400);

    const list = await loadDinnerRestaurants(c.env);
    const existingIdx = list.findIndex((r) => r.id === place.id);
    const entry = {
      id: place.id,
      name: place.name,
      address: place.address,
      cuisine: place.cuisine,
      distanceMeters,
      driveMinutes,
      visited: !!alreadyBeenHere,
    };
    if (existingIdx >= 0) {
      list[existingIdx] = { ...list[existingIdx], visited: list[existingIdx].visited || !!alreadyBeenHere };
    } else {
      list.push(entry);
    }
    await saveDinnerRestaurants(c.env, list);
    return c.json({ restaurant: existingIdx >= 0 ? list[existingIdx] : entry });
  }
  ```

- [ ] **Step 4: `GET /api/dinner/restaurants` handler**

  ```js
  async function handleListDinnerRestaurants(c) {
    if (isPublicMode(c.env)) return c.json({ error: 'Not available' }, 404);
    const list = await loadDinnerRestaurants(c.env);
    return c.json({ restaurants: list.filter((r) => !r.visited) });
  }
  ```

- [ ] **Step 5: `POST /api/dinner/restaurants/:id/visit` handler**

  ```js
  async function handleCheckOffDinnerRestaurant(c) {
    if (isPublicMode(c.env)) return c.json({ error: 'Not available' }, 404);
    const id = c.req.param('id');
    const list = await loadDinnerRestaurants(c.env);
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return c.json({ error: 'Restaurant not found' }, 404);
    list[idx] = { ...list[idx], visited: true };
    await saveDinnerRestaurants(c.env, list);
    return c.json({ restaurant: list[idx] });
  }
  ```

- [ ] **Step 6: Register routes**

  Near `worker/src/index.js:1630-1633` (`app.get('/api/leaderboard', ...)` etc.), add:
  ```js
  app.get('/api/dinner/restaurants', handleListDinnerRestaurants);
  app.post('/api/dinner/restaurants', handleAddDinnerRestaurant);
  app.post('/api/dinner/restaurants/:id/visit', handleCheckOffDinnerRestaurant);
  ```

- [ ] **Step 7: Syntax check**

  Run: `node --check worker/src/index.js`
  Expected: no output, exit code 0.

- [ ] **Step 8: Provision the secret and verify against the real API**

  Run `cd worker && wrangler secret put SERPAPI_KEY` (the user supplies the key value interactively — never paste it into chat or a file). Run `cd worker && npm run dev` (or equivalent local Worker dev command) and exercise all three endpoints with `curl`:
  - `curl -X POST localhost:8787/api/dinner/restaurants -H 'Content-Type: application/json' -d '{"name":"Kokoro Ramen","alreadyBeenHere":true}'`
  - `curl localhost:8787/api/dinner/restaurants`
  - `curl -X POST localhost:8787/api/dinner/restaurants/<id>/visit`
  Confirm each returns the expected shape, and fix Step 1-2's SerpApi parsing against whatever the real response shape actually is.

- [ ] **Step 9: Commit**

  ```bash
  git add worker/src/index.js
  git commit -m "feat: add dinner-restaurant SerpApi lookup and KV endpoints"
  ```

---

### Task 3: "Dinner" tab — frontend list + check-off

**Files:**
- Modify: `index.html` (`BRAND` config ~line 559-561, tab bar ~line 361-366, new `<div id="pane-dinner">` markup near `pane-leaderboard` at line 489, `switchTab()` at line 1870-1882, the gating block at line 766-770, i18n blocks)

**Interfaces:**
- Consumes: `GET /api/dinner/restaurants`, `POST /api/dinner/restaurants/:id/visit` (Task 2).
- Produces: `loadDinnerList()`, `checkOffRestaurant(id)` — consumed by Task 4 (the add form lives on the same tab/pane and calls the same `loadDinnerList()` to refresh after adding).

- [ ] **Step 1: Add `showDinnerFinder` to `BRAND`**

  At `index.html:559-561`, add `showDinnerFinder:false` to the Courtly branch and `showDinnerFinder:true` to the Trulioo branch.

- [ ] **Step 2: Add the tab button and pane container**

  Near `index.html:366` (`<button class="tab" ... id="tab-leaderboard" ...>`), add:
  ```html
  <button class="tab" onclick="switchTab('dinner')" id="tab-dinner" data-i18n="dinnerTab"></button>
  ```
  Near `index.html:489` (`<div id="pane-leaderboard" style="display:none">`), add a sibling:
  ```html
  <div id="pane-dinner" style="display:none">
    <div class="card">
      <table class="stats-tbl" id="dinner-tbl"></table>
      <div id="dinner-status"></div>
    </div>
  </div>
  ```
  (Follow the existing `pane-leaderboard`/`.stats-tbl` markup immediately above/below this point for exact wrapper divs/classes — reuse, don't invent new CSS.)

- [ ] **Step 3: Wire up `switchTab` and the load-on-open gating**

  In `switchTab()` (`index.html:1870-1882`), add a `dinner` case mirroring the `leaderboard` one: show/hide `pane-dinner`/`tab-dinner`, and call `loadDinnerList()` when switching to it.

  In the gating block (`index.html:766-770`, `if(!BRAND.showLeaderboard){...}`), add an analogous block for `!BRAND.showDinnerFinder` hiding `tab-dinner`/`pane-dinner`.

- [ ] **Step 4: `loadDinnerList()` and `checkOffRestaurant(id)`**

  Near `loadLeaderboard()` (`index.html:1943-1967`), add:
  ```js
  async function loadDinnerList(){
    const statusEl=document.getElementById('dinner-status');
    const tblEl=document.getElementById('dinner-tbl');
    statusEl.textContent=t('dinnerLoading');
    try{
      const res=await fetch(`${API_BASE}/api/dinner/restaurants`);
      if(!res.ok)throw new Error(`HTTP ${res.status}`);
      const data=await res.json();
      const rows=Array.isArray(data.restaurants)?data.restaurants:[];
      if(!rows.length){statusEl.textContent=t('dinnerEmpty');tblEl.innerHTML='';return;}
      statusEl.textContent='';
      tblEl.innerHTML=`<thead><tr><th>${t('dinnerName')}</th><th>${t('dinnerCuisine')}</th><th>${t('dinnerDistance')}</th><th>${t('dinnerDriveTime')}</th><th></th></tr></thead><tbody>`+
        rows.map(r=>`<tr><td style="font-weight:600">${escapeHtml(r.name)}</td><td>${escapeHtml(r.cuisine||'')}</td><td>${(r.distanceMeters/1000).toFixed(1)} km</td><td>${r.driveMinutes} min</td><td><button class="btn-s" onclick="checkOffRestaurant('${r.id}')">${t('dinnerCheckOff')}</button></td></tr>`).join('')+
        `</tbody>`;
    }catch(err){statusEl.textContent=t('dinnerLoadError');}
  }
  async function checkOffRestaurant(id){
    try{
      const res=await fetch(`${API_BASE}/api/dinner/restaurants/${encodeURIComponent(id)}/visit`,{method:'POST'});
      if(!res.ok)throw new Error(`HTTP ${res.status}`);
      loadDinnerList();
    }catch(err){alert(t('dinnerCheckOffError'));}
  }
  ```

- [ ] **Step 5: i18n keys**

  Add to all 6 language blocks: `dinnerTab`, `dinnerLoading`, `dinnerEmpty`, `dinnerLoadError`, `dinnerName`, `dinnerCuisine`, `dinnerDistance`, `dinnerDriveTime`, `dinnerCheckOff`, `dinnerCheckOffError`. English wording: `'Dinner'`, `'Loading…'`, `'No restaurants left to try — add one below, or go research a fresh batch.'`, `'Could not load the list.'`, `'Name'`, `'Cuisine'`, `'Distance'`, `'Drive time'`, `'We went here'`, `'Could not check that off — try again.'`.

- [ ] **Step 6: Manual verification**

  Run `npm start`, open the app, confirm the Dinner tab appears (Trulioo), shows whatever Task 2's manual curl testing already added to KV, and that clicking the check-off button removes a row and persists (reload the tab to confirm).

- [ ] **Step 7: Commit**

  ```bash
  git add index.html
  git commit -m "feat: add Dinner tab (list + check-off)"
  ```

---

### Task 4: Add-restaurant form on the Dinner tab

**Files:**
- Modify: `index.html` (inside `#pane-dinner`'s `.card`, add form markup; add `addDinnerRestaurant()`)

**Interfaces:**
- Consumes: `POST /api/dinner/restaurants` (Task 2), `loadDinnerList()` (Task 3).

- [ ] **Step 1: Add the form markup**

  Inside `#pane-dinner`'s `.card` (`index.html`, from Task 3 Step 2), above the `#dinner-tbl` table, add:
  ```html
  <div class="add-row">
    <input type="text" id="dinner-add-name" data-i18n-type="placeholder" data-i18n="dinnerAddPlaceholder">
    <label><input type="checkbox" id="dinner-add-visited"> <span data-i18n="dinnerAlreadyBeenHere"></span></label>
    <button class="btn-p" onclick="addDinnerRestaurant()" data-i18n="dinnerAddBtn"></button>
  </div>
  <div id="dinner-add-status"></div>
  ```
  (Match `.add-row` markup/classes to the existing bulk-import `.add-row` used elsewhere in the Setup pane.)

- [ ] **Step 2: `addDinnerRestaurant()`**

  ```js
  async function addDinnerRestaurant(){
    const nameEl=document.getElementById('dinner-add-name');
    const visitedEl=document.getElementById('dinner-add-visited');
    const statusEl=document.getElementById('dinner-add-status');
    const name=nameEl.value.trim();
    if(!name)return;
    statusEl.textContent=t('dinnerAdding');
    try{
      const res=await fetch(`${API_BASE}/api/dinner/restaurants`,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name,alreadyBeenHere:visitedEl.checked}),
      });
      const data=await res.json();
      if(!res.ok)throw new Error(data?.error||`HTTP ${res.status}`);
      nameEl.value='';visitedEl.checked=false;statusEl.textContent='';
      loadDinnerList();
    }catch(err){statusEl.textContent=err.message;}
  }
  ```

- [ ] **Step 3: i18n keys**

  Add to all 6 language blocks: `dinnerAddPlaceholder`, `dinnerAlreadyBeenHere`, `dinnerAddBtn`, `dinnerAdding`. English wording: `'Restaurant name…'`, `"I've already been here"`, `'Add'`, `'Adding…'`.

- [ ] **Step 4: Manual verification**

  In the running app, add a new restaurant by name (one not yet in the list), confirm it appears on the list unless checked "already been here" (in which case it should NOT appear, since the list only shows not-yet-visited). Try a deliberately too-far or nonsense name and confirm the error message surfaces inline rather than silently failing.

- [ ] **Step 5: Commit**

  ```bash
  git add index.html
  git commit -m "feat: add restaurant add-form to the Dinner tab"
  ```

---

### Task 5: Seed data

**Files:**
- None (data-only — exercises Task 2's live `POST /api/dinner/restaurants` endpoint against the real SerpApi key)

- [ ] **Step 1: Add the 13 known restaurants, marked visited**

  Using the now-working add form (or direct `curl` against the deployed/local Worker), add each of: Gyu-Kaku (Richmond), Ai-Boiled Hot Pot, Drama Hot Pot, Cafe Gloucester, Deer Garden (Fraser St.), Dosa Corner, Karakoram Restaurant, Truong Thanh Restaurant, Kokoro Ramen, Sumi Korean Restaurant, Kinton Ramen (Marine Dr.), Memory Corner, Old Xian (Vancouver) — each with `alreadyBeenHere: true`. If the 20-minute drive cutoff rejects one of these known spots, that's a real signal the cutoff or the venue coordinates need a second look — don't silently skip it.

- [ ] **Step 2: Research and add a fresh not-yet-tried batch**

  Research nearby restaurants (within the 20-minute drive radius) not already on the list, manually confirm each is realistically open Wednesday evenings past 8pm (per the design doc's manual-vetting decision — the add endpoint itself does not check this), and add each with `alreadyBeenHere: false`. Aim for a reasonable starting batch (e.g. 10-15) so the Dinner tab isn't empty on day one.

- [ ] **Step 3: Verify the live list**

  `curl` or load the Dinner tab and confirm the not-yet-visited batch shows up correctly with cuisine/distance/drive-time populated, and the 13 known spots do not appear (since they're marked visited).
