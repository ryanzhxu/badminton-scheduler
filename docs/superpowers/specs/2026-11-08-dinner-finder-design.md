# Dinner Finder — Design

## Intent and why

Every Wednesday the group plays badminton 6-8pm at Badminton Vancouver (110-13100
Mitchell Rd, Richmond, BC V6V 1M8). At the entrance afterward, several people
independently search their phones for a place to eat, duplicating effort and
often re-landing on a place the group has already tried. This feature gives
the group a single shared, standing list of nearby restaurants they haven't
tried yet (or very rarely have), so "where should we eat" stops being a
scramble.

This is **Trulioo-deployment only**. Courtly is the public, multi-tenant
surface with strangers sharing links; a shared "where we eat" list doesn't
make sense there, and is explicitly out of scope.

## Goals

- One shared, persistent list of restaurants near Badminton Vancouver, each
  tagged with whether the group has already been.
- A "Dinner" tab, visible to anyone holding the schedule's shared link, that
  shows only the not-yet-tried restaurants — no button, no live query, just a
  render of stored data.
- An "add a restaurant" control on that same tab: type a name, the app
  resolves it via a Maps lookup (address, cuisine, distance, drive time from
  the venue) and stores it. A checkbox at add time marks "I've already been
  here" for back-filling memory (e.g. the group's known history); left
  unchecked, it's added as a new not-yet-tried candidate.
- A "check off" action on any not-yet-tried entry that flips it to visited;
  visited entries drop off the active list.
- Initial seed data: the 13 restaurants the group already knows about
  (Gyu-Kaku Richmond, Ai-Boiled Hot Pot, Drama Hot Pot, Cafe Gloucester, Deer
  Garden (Fraser St.), Dosa Corner, Karakoram Restaurant, Truong Thanh
  Restaurant, Kokoro Ramen, Sumi Korean Restaurant, Kinton Ramen (Marine Dr.),
  Memory Corner, Old Xian (Vancouver)), marked visited, plus a fresh batch of
  nearby not-yet-tried candidates researched during implementation.

## Non-goals / anti-goals

- No live "search now" button or on-demand querying every time the tab is
  opened. The "within a reasonable drive" check happens once, at add time
  (see "What's decided" below), not on every view.
- No automated "still open Wednesday evening" gate on the add endpoint.
  That check only happens once, manually, during the initial seed-data
  research pass (see "What's left to the builder") — the add endpoint
  itself does not call SerpApi's `open_on_day`/`open_at_hour` params. A
  restaurant added later via the add box is not re-verified for hours.
- No cuisine/keyword filter input. The tab just shows what's stored.
- No per-schedule scoping. This is one list for the whole group, independent
  of which week's schedule is currently active.
- No skill/rating overlap with the balancing feature below — unrelated.
- Not built for Courtly; no multi-tenant group scoping needed here.
- No visit-count tracking — "visited" is a plain yes/no, not a counter.
- No "undo a check-off" endpoint or visited-history view in v1. A checked-off
  entry just drops off the active list permanently; correcting a mistake
  means editing KV directly. Consistent with the overall minimalism here —
  add it later if it's actually needed, not speculatively now.

## Constraints

- The Worker (`worker/src/index.js`) is the actual live production backend
  for Trulioo (per `CLAUDE.md`'s "Deployment Targets" — the frontend's
  `API_BASE` points at the Cloudflare Worker, not `server.js`/Render). This
  feature is **Worker-only**, following the same precedent as the Leaderboard
  / Sessions / Player-detail endpoints, which were likewise never ported to
  `server.js`. `server.js` is not touched by this feature.
- The data lookup provider is SerpApi's Google Maps engine (place search —
  address, cuisine/category, GPS coordinates, hours) plus its Directions
  engine (driving distance/duration from the fixed venue point). Verified
  during design:
  - Google Maps engine supports an `open_on_day` + `open_at_hour` combination
    to check "open on Wednesday at 8pm" directly, and returns a day-by-day
    hours breakdown, address, category, and `gps_coordinates` per place.
  - There's no radius parameter on the Maps engine; it scopes by a center
    point (`ll`: lat/long/zoom) rather than a radius in km/miles. A fixed
    center point (Badminton Vancouver's coordinates) is good enough here
    since the venue never changes.
  - The Directions engine returns driving distance and duration between two
    points, one call per restaurant (no batch mode).
  - Pricing: $25/mo for 1,000 searches, with a free tier of 250/month. Since
    lookups only happen when someone adds a restaurant (not on every tab
    view), expected volume is a handful of calls per month — well within the
    free tier.
- The SerpApi key is a secret, stored as a Worker secret (`wrangler secret
  put`), never in `wrangler.toml`'s plain vars and never shipped to the
  client. All SerpApi calls happen server-side in the Worker. The user
  already has a SerpApi account/key from another project; implementation
  just needs it supplied and set via `wrangler secret put`, not provisioned
  from scratch.
- "20-minute drive" is a hard cutoff, not a sort-and-let-them-judge list:
  restaurants beyond that are excluded entirely, not shown greyed out.

## What's decided (the how)

- **Data shape** (new KV entity, analogous to `PLAYER_REGISTRY_KEY` /
  `SCHEDULE_INDEX_KEY`): a `DINNER_RESTAURANTS_KEY` holding an array of
  `{ id, name, address, cuisine, distanceMeters, driveMinutes, visited }`.
  `id` can be the SerpApi `data_id`/`data_cid` for the place, used to dedupe
  re-adds of the same restaurant.
- **Add flow** (`POST /api/dinner/restaurants`, Worker-only, body
  `{ name, alreadyBeenHere }`):
  1. Query SerpApi Maps engine centered on Badminton Vancouver's coordinates
     for `name`.
  2. Take the top match; reject (400, surfaced in the UI) if nothing
     plausible comes back.
  3. Call the Directions engine for drive time/distance from the venue to
     that place.
  4. If driveMinutes > 20, reject (400) — this is a hard cutoff per the
     goals above, not a soft "it's far" note.
  5. Otherwise store `{ id, name, address, cuisine, distanceMeters,
     driveMinutes, visited: alreadyBeenHere }` in the KV list (skip if `id`
     already present — update `visited` instead if the incoming add marks it
     visited and it wasn't before).
- **List endpoint** (`GET /api/dinner/restaurants`, Worker-only): returns the
  stored array as-is. No query params, no live search — the client filters to
  `visited === false` for the tab's display list (or the server can
  pre-filter; either is fine, implementer's call).
- **Check-off endpoint** (`POST /api/dinner/restaurants/:id/visit`,
  Worker-only): flips that entry's `visited` to `true`.
- **Frontend** (`index.html`, Trulioo-only via the existing `IS_COURTLY`
  branch, same pattern as `showLeaderboard`): a new "Dinner" tab alongside
  Setup/Schedule/Check-in/Leaderboard. Renders the not-yet-visited list
  (name, cuisine, distance, drive time) with a check-off button per row, plus
  an add form (name input + "I've already been here" checkbox) wired to the
  two endpoints above. All new UI strings go through the existing i18n system
  (`t()`/`data-i18n`), added to all 6 active language blocks.
- **Access control**: identical to the rest of the Trulioo app today — no new
  auth. Anyone who can load the app (and therefore the shared schedule link)
  can see and use the Dinner tab, matching how Setup/Schedule/Check-in are
  already unauthenticated.

## What's left to the builder

- Exact SerpApi query parameters/request shape (the Maps engine's search
  query string format, the Directions engine's origin/destination encoding)
  — implement against SerpApi's actual API, verified against a real key
  during implementation rather than guessed here.
- Error handling detail for SerpApi failures (timeout, no results, quota
  exceeded) — surface a clear error in the add form; exact wording is an
  implementation/i18n detail.
- Test coverage for the new `/api/dinner/*` Worker endpoints: follow the
  existing precedent set by Leaderboard/Sessions/Player-detail (no dedicated
  automated tests for those; verified via `node --check worker/src/index.js`
  plus manual curl/UI checks) rather than adding a new mocked-SerpApi test
  suite. `CLAUDE.md`'s `npm test` requirement is specifically about the
  scheduling algorithm and doesn't apply to these endpoints.
- The actual seed data: entering the 13 known restaurants and researching +
  adding the fresh not-yet-tried batch happens during implementation (using
  the newly built add endpoint itself, once a real SerpApi key is
  provisioned), not invented in this design doc.
- Whether the list/add/check-off endpoints pre-filter server-side or the
  client filters — either is fine, pick whichever is less code against the
  existing Worker route patterns.
- CSS/layout details for the new tab — follow the existing `.card`/table
  patterns already used by the Leaderboard tab.
