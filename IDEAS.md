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

- **Auto-fill court location** from the cal.com booking's location field. The
  manual court-location UI it would have extended was removed in `99dc152`.
- **Admin UI for leaderboard alias merges.** Only the `players:aliases` KV
  structure and resolution logic exist. Adding an alias today means editing KV by
  hand.
- **Input-side duplicate-name validation**, nudging toward full names at bulk
  import so "Ryan" and "Ryan Xu" cannot diverge.
