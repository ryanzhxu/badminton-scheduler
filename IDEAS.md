# Ideas backlog

Directions explored on 2026-08-25 and deliberately deferred. Recorded so they do
not have to be re-derived.

## Match-day tools

**Live round timer.** A shared countdown so rounds rotate on time, synced across
every phone through the SSE stream and Durable Object room that already exist.
No new infrastructure. The open question is who controls start and pause.

**Player self-check-in.** Let players tap their own name on the shared link
instead of one organizer working through the list. The Check-in tab and the
"+ Add player" row already support edits from a shared link, so this is mostly a
permissions and UX question, not new plumbing.

## Match results and rankings

**Record who won each game.** This is the largest available feature and the one
that unlocks W/L records, head-to-head, and ranking. Three reasons it was
deferred:

1. It adds friction at the court, where the app is currently zero-input.
2. The app has deliberately avoided competition — skill tiers were built and then
   removed on purpose.
3. The Schedule page must stay clean, so scores would need to live in Check-in or
   behind a toggle.

If it is ever built, the natural shape is a tap on the winning side of a court
card while a round is in edit mode, stored per round in the schedule JSON.

## Still open from earlier sessions

- **Admin UI for leaderboard alias merges.** Only the `players:aliases` KV
  structure and resolution logic exist. Adding an alias today means editing KV by
  hand.
- **Input-side duplicate-name validation**, nudging toward full names at bulk
  import so "Ryan" and "Ryan Xu" cannot diverge.

## Discoverability (carried over from the Courtly design doc, 2026-08-26)

**Per-sport landing pages.** Recommended, then deferred. Worth recording because
it recurs: the app's UI text is injected at runtime through `data-i18n`, so a
crawler fetching the raw HTML still sees empty elements. A `<meta name="description">`
and Open Graph tags were added on 2026-08-29, but there is still no indexable
prose, no `robots.txt` and no sitemap. Landing pages are a 6-12 month lever for
discoverability, **not** a fast user-acquisition channel.

**Community seeding is the fast path** to weekly strangers — posting where
organisers already complain about this problem (r/badminton, r/pickleball, local
Facebook groups, the Vancouver Badminton Meetup). Weeks, not months. Not a code
task.

**Undecided:** whether Ryan's own group moves to Courtly or stays on the Trulioo
deployment. Both are supported by the architecture.
