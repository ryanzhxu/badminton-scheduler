# Refactor plan

Status of refactor work on the badminton scheduler, and the constraints any
refactor has to respect. Written 2026-08-23.

Read [AGENTS.md](AGENTS.md) first. This file only covers refactor scope and
sequencing.

## Why this file exists

The app ships from one repo through **two independent deploy pipelines**. That
makes some otherwise routine refactors breaking changes, and the reasons are not
visible anywhere in the source. This file records them.

## Deployment shape

Every push to `main` deploys both halves automatically. Neither pipeline is
configured in this repo, so neither is visible from the source tree.

| Half | Host | Trigger | URL |
| --- | --- | --- | --- |
| Frontend (`index.html`) | Render static site `trulioo-badminton` | push to `main` | `https://trulioo-badminton.onrender.com` |
| API (`worker/src/index.js`) | Cloudflare Workers Builds | push to `main` | `https://badminton-scheduler-api.rxlab.workers.dev` |

Two consequences:

1. **`.github/workflows/ci.yml` gates nothing.** It runs the tests in parallel
   with both deploys, not before them. A failing `npm test` still ships.
2. **The two halves land at different times.** On commit `d7bd745`, Render went
   live at `20:54:12` and the Cloudflare build finished at `20:54:34`. For those
   22 seconds the new frontend talked to the old Worker. A commit that changes
   the API contract on both sides at once is a brief outage.

## Frozen: the production URL

`https://trulioo-badminton.onrender.com` must stay live. Any change to it is a
breaking change. That freezes, transitively:

- the Render service config, `buildCommand: "true"` and `publishPath: "./"`,
- `index.html` as a single self-contained file at the repo root, no build step,
- the share-link shape `/?scheduleCode=X`,
- `PROD_SHARE_BASE_URL` (`worker/src/index.js`) and `getShareBaseUrl()`
  (`index.html`), which point the two halves at each other.

Do not propose splitting `index.html` into modules or adding a frontend build
step while this holds.

## The bridge: five hardcoded contracts

A refactor breaks the two halves apart only if it touches one of these.

1. **Render publish path.** The repo root is served verbatim. `index.html` must
   stay at the root, as one file, in a bare `<script>` tag.
2. **Frontend to backend URL.** `API_BASE` in `index.html` hardcodes the Worker
   URL. Renaming `name` in `worker/wrangler.toml` changes the `workers.dev`
   subdomain and breaks every call.
3. **Backend to frontend URL.** `PROD_SHARE_BASE_URL` in `worker/src/index.js`
   hardcodes the Render URL. Only the Wednesday cal.com cron uses it, because a
   cron has no browser origin to read. If it goes stale, the generated QR codes
   point at a dead host, nothing errors, and it surfaces a week later at the
   court.
4. **The API surface.** Eleven routes, registered at `worker/src/index.js`
   lines 1320-1330, called from eight sites in `index.html`. There is no build
   step and no type checker, so a rename fails only at runtime.
5. **Version alignment.** `APP_VERSION`, `package.json` and
   `worker/package.json` must be bumped together and always match.

What a refactor **cannot** break: CORS is `Access-Control-Allow-Origin: *` on
every response including the preflight, so the frontend origin is free to move.
Share links use a query parameter rather than a path, so Render needs no SPA
rewrite rules and there is no `_redirects` file to keep in sync.

## Prototyped, then reverted

Both items below were built and verified on 2026-08-23, then reverted so the
tree could go back to a clean baseline. They are ready to re-land as-is.

### 1. Cross-half API contract test

`npm test` covers the scheduling algorithm across all three implementations. It
covers **none** of the SPA-to-Worker wire contract, which is the one bridge
point that fails only in production.

A `tests/api-contract.test.js` reading both sources statically, with no network
calls, asserting:

- every `${API_BASE}` call in `index.html` resolves to a registered Worker
  route, mirroring the Worker's own `matchPath` rules (equal segment count,
  `:name` matches one segment),
- every Worker route has a caller in the SPA or sits on an explicit
  `UNCALLED_BY_SPA` allowlist,
- that allowlist has no stale entries,
- the three version numbers agree.

Verified by mutation: renaming `/api/data` to `/api/data-v2` turned two tests
red and named the offending route in both directions. Desyncing `package.json`
to `1.7.3` turned the version test red.

Two supporting changes it needs: export `readInlineScript` from
`tests/helpers/load-scheduler.js`, and widen the `test` script in
`package.json` from `tests/scheduling.test.js` to `tests/*.test.js`.

**It found a real gap.** The Worker registers **eleven** routes, not the ten a
manual scan of `/api` paths turns up. There is a bare `GET /health` at line 1320
alongside `GET /api/health`, and it is live in production.

### 2. Untrack the handoff doc

`HANDOFF-2026-07-08.md` is listed in `.gitignore` but was committed before that
rule existed, so the ignore never applied. It is served publicly today.
`git rm --cached` drops it from the published root and keeps the local copy.

Note the general rule this exposes: **every committed file at the repo root is
publicly readable** at the Render URL. `server.js`, `AGENTS.md`, `.env.example`,
`package.json` and `player-countries.json` all return 200. Nothing secret is
exposed today, but any config file added to the root gets published.

## Planned

Ordered into waves by what actually collides.

| # | Item | Writes to | Deploys | Conflicts |
| --- | --- | --- | --- | --- |
| 3 | Clean untracked junk | untracked files only | no commit | nothing |
| 4 | Refactor `index.html` internals | `index.html` | frontend | 5, via version bump |
| 5 | Refactor Worker internals | `worker/src/index.js` | API | 4, via version bump |
| 6 | Gate deploys on CI | pipeline config | n/a | nothing |

### Wave 0 — item 3

Deleting ignored files touches no commit and triggers no deploy. The files are
untracked, so deletion is **unrecoverable**: `index.html.bak`, `server.js.bak`,
the brand-redesign `.zip`, `design_handoff_badminton_scheduler/`, and
`COUNTRY_TEAM_INDICATOR.md`. None is published, so there is no production reason
to remove any of them.

### Wave 1 — the two reverted items above

Land item 1 first. The contract test is the guardrail that lets Wave 2 run
unsupervised.

### Wave 2 — items 4 and 5, in parallel

Separate worktrees, separate branches off `main`. They never touch the same
file, so the merge is clean. Both still need a defined target before they are
real tasks.

Invariants both lanes must hold, taken from the test harness and stricter than
they look:

- Do not rename anything in `REQUIRED_NAMES`
  (`tests/helpers/load-scheduler.js`). Those 16 declarations are extracted by
  name from all three implementations.
- Keep each of them in the form `function X(` or `const ... X =`.
  `extractDeclaration` matches only those two. Converting one to a `let` arrow,
  a class method, or an object property breaks extraction in all three copies at
  once.
- **Lane 4 only:** the app script stays in a single bare `<script>` tag and
  stays the largest inline block. `readInlineScript` matches `/<script>/` with
  no attributes and sorts by length, so `type="module"` makes it invisible.
- **Lane 5 only:** route paths and response field names stay fixed.
- Neither lane touches `API_BASE`, `PROD_SHARE_BASE_URL`, or the share-link
  shape.
- **Neither lane bumps the version.** See below.

Gate per lane before merge: `npm test && npm run check`.

### Wave 3 — one version bump

The version bump is the sharpest conflict in the plan. If both Wave 2 lanes bump
it they collide on `package.json`, and worse, they can merge cleanly into a
state where the three numbers disagree. One serialized commit bumps all three
after both lanes land. The version test from item 1 catches it if that is
forgotten.

## Not safe while the URL is frozen

- Splitting `index.html` into modules, or adding a frontend build step.
- Renaming the Worker in `worker/wrangler.toml`.
- Deleting `server.js`. It is dead in production, since Render serves it as text
  and never executes it, but `tests/helpers/load-scheduler.js` reads it as the
  third algorithm copy. Deleting it breaks the suite.
- Moving `PROD_SHARE_BASE_URL` into `[vars]`. Still safe to do, but its value was
  making the frontend URL easy to change, and the URL is now frozen. Low
  priority.
