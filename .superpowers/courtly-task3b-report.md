# Task 3b: Expire stale index entries alongside schedules

## Status
Complete. Implemented per `COURTLY-PLAN.md` Task 3b (lines 607-670), plus the
coordinator's extra no-TTL invariance test.

## Changes
- `worker/src/index.js`: added `function filterIndexByAge(index, ttlSeconds, now)`
  next to `filterIndexByGroup` (unchanged). Wired it into `handleSessions`,
  `handleLeaderboard`, and `handlePlayer` as
  `filterIndexByGroup(filterIndexByAge(await loadScheduleIndex(c.env), c.env.SCHEDULE_TTL_SECONDS, Date.now()), c.req.query('group'))`.
- `tests/group-scoping.test.js`: added 4 tests extracting `filterIndexByAge` via
  `extractDeclaration` the same way `filterIndexByGroup` is extracted:
  1. no TTL keeps every entry
  2. a TTL drops entries older than the window
  3. a malformed date is kept, not silently dropped
  4. a Trulioo-shaped index is returned untouched when no TTL is set (extra test)

## Verification
- `npm test`: 40/40 passing (was 36, +4 new tests: 3 from the plan + 1 extra
  no-TTL invariance test).
- `npm run check`: clean (`node --check server.js && node --check worker/src/index.js`).
- No-TTL invariance: `filterAge([{code:'BADM-WUJ7',date:'2026-07-08'},{code:'BADM-ARSJ',date:'2026-08-19'}], undefined, Date.parse('2027-01-01T00:00:00Z'))`
  returns the array unchanged (`deepStrictEqual` to input) — confirms the live
  Trulioo deployment (no `SCHEDULE_TTL_SECONDS` set) never loses an entry,
  however old.
- Composed behaviour (`filterIndexByGroup(filterIndexByAge(...))`) with a TTL
  set: an old entry in `groupA` (2026-08-01, dropped by an 604800s/7-day TTL
  against a 2026-08-26 `now`) does not leak into a `groupB` query — output is
  exactly the surviving `groupB` entry. Verified both that age-filtering drops
  it and that group-scoping would also exclude it even if it had survived.

## Scope check
- Only `worker/src/index.js` and `tests/group-scoping.test.js` modified.
- `worker/wrangler.toml`, `server.js`, `index.html` untouched.
- `REQUIRED_NAMES` (tests/helpers/load-scheduler.js) untouched;
  `filterIndexByGroup`/`filterIndexByAge` are not exported or in that list,
  consistent with existing pattern (extracted from source text, not required).
- No `wrangler kv` commands run, no deploys, no version bump, no new npm
  packages.

## Concerns
None. Behaviour matches the plan exactly.
