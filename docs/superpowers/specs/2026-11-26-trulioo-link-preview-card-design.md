# Dynamic link-preview card for Trulioo rotation links

Status: approved 2026-11-27. Written 2026-11-26.

## Intent and why

Today, forwarding a Trulioo rotation link (`https://trulioo-badminton.onrender.com/?scheduleCode=BADM-XXXX`) in iMessage/Slack/etc. shows the same static, generic card for every schedule — a fixed title ("Courtly"), fixed description, and a fixed logo image (`og-trulioo.png`). The link-preview carries zero information about the actual rotation being shared.

The user wants the card to actually be useful at a glance: show who's playing (the roster) and the first round's court matchups, without needing to open the link.

## What's already decided (via mockup review in chat, 2026-11-26)

Three visual directions were mocked up (lineup ticket / scoreboard split / program sheet), stress-tested against both a small roster (10 players, 2 courts) and a full-gym night (20 players, 5 courts). The user picked **Option B, "Scoreboard split," with the date added top-right**:

- **Canvas**: ~1.91:1 aspect ratio (same ballpark as the current static asset's 1512×794; exact pixel size is the builder's call — 1200×630 is the conventional OG size and fits the same ratio).
- **Header**: left side keeps the existing logo-dot + "Courtly" wordmark; right side stacks the round label (bold amber, e.g. "ROUND 1 OF 8") above the date (smaller, muted) — same corner the "lineup ticket" option used.
- **Body**: up to **3 court blocks** side by side, each rendered as `Team A` / `VS` / `Team B`, bold white text on a dark translucent panel. If there are more than 3 courts, the 4th slot becomes a dashed "+N courts" tile instead of shrinking all the blocks to fit — tested at 5 courts and confirmed legible at both full size and ~iMessage-thumbnail size (280px wide).
- **Footer**: a darker strip with overlapping initial-avatars (alternating the app's real team-badge colors — green/`#EEF7F1`+`#004C45` and blue/`#D3EDF6`+`#00598C`) for the first few roster players, an overflow avatar ("+N") for the rest, and right-aligned "`<count>` playing tonight" text.
- Fallback for an invalid/missing schedule code: the existing static generic card, unchanged.

The full visual spec (colors, spacing, type sizes) lives in the approved mockup HTML, committed alongside this document:
- `docs/superpowers/specs/assets/2026-11-26-trulioo-link-preview-card/approved-mockup.html` — the final Option B + date design, at both the 2-court baseline and the 5-court capped layout.
- `docs/superpowers/specs/assets/2026-11-26-trulioo-link-preview-card/many-courts-stress-test.html` — the full three-option comparison that led to picking Option B, kept for the reasoning behind the capping rules.

Open either in a browser; see "What's left to the builder" for what to do with them.

## Goals

1. A real PNG image, generated per schedule, used as `og:image`/`twitter:image` for Trulioo rotation links, matching the approved mockup.
2. `og:title`/`og:description` also become schedule-aware (round/date, headcount), mirroring what Courtly's `courtly-entry.js` already does with text today.
3. Behavior stays correct for schedules with any number of courts/players, using the capping rules above (3 courts + overflow tile; N avatars + overflow).
4. The durable `?scheduleCode=current` link (see `CLAUDE.md`'s "Durable 'current' share link") gets the same dynamic treatment as a regular per-schedule code — it's the one link meant to be pasted once and reused forever, so it's the highest-value place for this, not an afterthought. SSE's existing "no single target" refusal for the literal `current` pseudo-code doesn't apply here, since this is a one-shot render per request, not a stream.

## Non-goals (this pass)

- **Courtly is out of scope.** Courtly already has a dynamic *text* card; giving it this same visual court/roster treatment is a reasonable follow-up but is a separate piece of work, not bundled here. (This default went unchallenged through several rounds of review, so treating it as confirmed rather than re-asking.)
- **No live-updating card.** Once a platform (iMessage, Slack, Twitter...) scrapes and caches a link's preview, we have no way to push a refresh to that platform's cache — this is a universal limitation of link unfurling, not something this project can solve. If round 1 changes after the card was first scraped (e.g. a pre-game check-in reshuffle), the cached preview may go stale. Out of scope to fix.
- **No support for the legacy watch-view or `/w/:code` surfaces.** This is only about the link-preview card.

## Constraints

- `REFACTOR.md`'s frozen contracts: `https://trulioo-badminton.onrender.com` must stay live and unchanged, and the share-link shape (`/?scheduleCode=X`) is frozen. Whatever we build must not require Render to run server logic (it's a static site: `buildCommand: "true"`, serves the repo root verbatim) and must not change what a normal browser visit to that URL does.
- The Worker today only emits images as SVG (the QR code, via `./qrcode-svg.js`) — there is no PNG rasterization capability yet. Most link-preview consumers (Twitter/X in particular) do not reliably render SVG as `og:image`; this needs a real raster PNG.
- `index.html`'s `<meta>` tags are static, baked into the one committed file Render serves as-is. There is no server-side templating on that path today.

## Decided: how Trulioo serves a dynamic card at all

This was the crux of the project. Courtly can do this today because `courtly.ryanxu.dev` *is* the Worker — the Worker intercepts `GET /`, rewrites the meta tags server-side, and serves the resulting HTML to both crawlers and real browsers. Trulioo's frontend is a plain static file on Render; there is no request-time logic in front of it to rewrite anything.

Two options were rejected before landing on the one that ships:

- **Keep sharing the Render URL, with some proxy/edge rewriting its HTML in front of it.** Turns out to not even be possible, not just risky: `trulioo-badminton.onrender.com` is Render's domain, not ours in Cloudflare — there is no DNS/zone control available to insert a Worker route or Transform Rule in front of it. Whatever URL actually gets pasted into a chat is the exact same URL the crawler fetches, verbatim, and Render serves one static file to everyone with no per-request branching (not even by User-Agent). So there is no version of "the human-facing link stays on onrender.com" where crawlers somehow still see dynamic content — that was floated as an option mid-review and turned out to be a dead end once checked, not a smaller-scope variant of the feature.
- **Move Trulioo's frontend to be served by the Worker too**, same pattern as Courtly, retiring the Render static site. Would give full parity with Courtly's mechanism, but breaks the explicitly frozen `trulioo-badminton.onrender.com` contract and is a much bigger, riskier change than this project needs. Set aside, but on the table if a future need makes it worth revisiting.

**Decided approach**: change the URL that actually gets *shared*, not the URL the app runs at. A new route on the Worker's own domain, at the *same path shape as today's share link* — `https://trulioo.courtly.ryanxu.dev/?scheduleCode=:code` (query param, not a path segment — there's no reason to diverge from the one URL shape users already recognize, and `trulioo.courtly.ryanxu.dev` has no route registered at `/` today, so nothing collides). Its only job: serve a tiny server-rendered HTML page with the correct `og:`/`twitter:` tags and the generated PNG, and `<meta http-equiv="refresh">` (or a tiny inline redirect) real browsers straight through to the existing `https://trulioo-badminton.onrender.com/?scheduleCode=:code` app. Crawlers/unfurl bots stop at the Worker page and read the rich tags; humans land on the real app within a moment, never noticing.

This is additive — `trulioo-badminton.onrender.com` and its meta tags don't change at all, and `getShareBaseUrl()`'s behavior for the live app is untouched. What changes: `syncShareQr()`, the QR code, and the "copy link" text all now hand out the `trulioo.courtly.ryanxu.dev` link instead of the `trulioo-badminton.onrender.com` one — confirmed acceptable in review (2026-11-27) after seeing a side-by-side mockup of the actual share popover with both URLs, and after the onrender-only alternative was confirmed infeasible.

## Decided: Courtly too, or Trulioo only?

**Trulioo only** for this pass (see non-goals). This default was proposed early and went unchallenged through several rounds of review, so it's being treated as confirmed rather than re-asked.

## Decided: rendering approach (my call, flagged for your awareness, not blocking)

To rasterize the approved layout into a real PNG inside a Cloudflare Worker, I plan to use [`workers-og`](https://github.com/fredkiss3/workers-og) — a small package built specifically for this (Satori for layout + a WASM SVG renderer for the actual PNG), already used elsewhere for exactly "generate an OG image inside a Cloudflare Worker." This avoids hand-rolling WASM image rendering ourselves. Alternative considered and set aside: hand-written SVG template + a bare WASM PNG renderer — more control, but text truncation/measurement (e.g. long player names) becomes code we'd have to write ourselves instead of getting from a layout engine. Can revisit if `workers-og`'s bundle size or cold-start cost turns out to be a problem in practice.

## What's left to the builder

- Exact pixel values (padding, font sizes, corner radii, colors) — lift directly from the approved mockup HTML/CSS rather than re-deriving them.
- Exact truncation thresholds: 3 courts before the overflow tile, and how many avatars show before "+N" (mockups used ~5-6; pick a number that keeps the footer from wrapping at the smallest realistic roster-count text, e.g. "20 playing tonight").
- The redirect mechanism for the new route (meta-refresh vs. a tiny JS redirect vs. a 302 — a 302 is simplest but means crawlers that *do* follow redirects before reading tags, if any, would miss the rich tags; meta-refresh/JS keeps crawlers on the page while sending humans onward instantly).
- The new route must special-case the literal `current` the same way `handleGetSchedule` already does (goal 4) — resolve it via `loadCurrentSchedule()` instead of a real per-schedule KV key, same as the existing pseudo-code handling.
- Cache-Control on the new PNG route: short-lived (we don't control downstream caching by the platforms that matter anyway, so this is mostly about not hammering KV on duplicate crawler hits in a burst).
- Test coverage: extend `tests/api-contract.test.js`'s static checks and `tests/smoke/production.test.js`'s live checks to cover the new route, following the existing patterns in both files.
- `APP_VERSION`/`package.json`/`worker/package.json` bump together, per existing versioning rules.
