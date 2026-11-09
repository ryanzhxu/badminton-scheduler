# Skill-Based Game Balancing — Design

## Intent and why

Doubles/singles matches sometimes end up lopsided — e.g. two strong players
teamed against two weaker ones, or a mismatched 1v1. The group wants the
scheduler to *try* to make games closer by taking player skill into account,
on top of the existing conflict-avoidance and partner/opponent-variety logic.

This is a **reinstatement with changes**, not a new concept: a skill-tier
feature existed before (commit `2fe6ed3`, "Add skill-tier balancing to team
generation") and was deliberately removed (commit `99dc152`, "Improve
pairing fairness, remove skill tiers, add regression tests") in favor of
relying solely on team conflicts for fairness. `CLAUDE.md` explicitly warns
not to reintroduce a skill field without re-adding the removed UI, i18n
keys, and `playerSkills` plumbing across all three copies — this document is
that re-addition, with one new mechanic layered on top (see below) and one
change in how the rating is scoped (see "Non-goals" — it reverts to
per-session, not the global-by-identity idea considered and rejected during
design).

## Goals

- Reinstate the old mechanic: a 3-tier rating per player (1=Beginner,
  2=Intermediate, 3=Advanced, defaulting unset players to 2/neutral), set
  via a cycle-button on each player chip — same UI spot as before. Threaded
  through `generateRounds`/`handleGenerateSchedule`/`handleExtendSchedule`
  exactly as before so extended rounds keep using the same ratings.
- **New** (this is the actual ask, beyond the old feature): when forming
  doubles partnerships, add a soft preference for pairing dissimilar-skill
  players together (strong+weak), on top of the existing repeat-partner
  cost — "the algorithm should at least try to do that," per the user, i.e.
  a weighted cost term, not a hard rule.
- Reinstate the old doubles mechanic too: when deciding which two
  partner-pairs face each other on a court, minimize the skill-sum
  difference between the two teams — "this can also be added as part of
  consideration," i.e. a second weighted cost term alongside the first, not
  a replacement for it.
- **New**: for singles (1v1 overflow) courts — which the old feature never
  touched — add a soft preference for matching *similarly*-skilled
  opponents (the opposite direction from doubles, since there's no partner
  to offset a skill gap in a 1v1).
- All of the above are soft/squared costs fed into the existing
  `greedyMatch`/`matchPartnersRespectingConflicts` machinery, at the same
  weight scale as the old feature (well below the conflict penalty's 1000x,
  and not so large that it swamps the existing repeat-pairing variety
  costs) — same spirit as `REPEAT_PARTNER_WEIGHT`/`REPEAT_OPPONENT_WEIGHT`.
  Conflicts remain an absolute, never-violated restriction, same as today.
- Reinstated across all three implementations (`index.html`,
  `worker/src/index.js`, `server.js`), since this touches
  `buildRoundCourts`/`matchPartnersRespectingConflicts`/`greedyMatch`, which
  `tests/scheduling.test.js` already requires to stay aligned across all
  three.
- New test coverage in `tests/scheduling.test.js` for: complementary
  (strong+weak) partner pairing when skill variety exists in the roster;
  closer team-sum balance between the two teams on a court than an
  unweighted baseline; closer singles-opponent skill matching; and, most
  importantly, that conflict-avoidance is never violated for a skill reason
  (conflicts outrank skill, same as they already outrank repeat-pairing).

## Non-goals / anti-goals

- **Trulioo only.** Courtly's UI never shows the skill-rating control. On
  the server side, this is not left as pure data-presence gating ("Courtly
  just never sends it") — `worker/src/index.js` already has an
  `isPublicMode(env)` check used elsewhere specifically to stop Courtly from
  getting Trulioo-only data/behavior (see the group-scoping section of
  `CLAUDE.md`). This feature reuses that same pattern: the skill cost terms
  are skipped whenever `isPublicMode(env)` is true, regardless of what a
  direct API call sends, not just when the field happens to be absent. So
  Courtly's scheduling output stays byte-identical to today's even against
  a hand-crafted request.
- **Not a global, persist-by-identity setting.** This was explicitly
  considered (tying skill to the same canonical-player-name registry the
  Leaderboard uses, so a returning player's tier would carry over
  automatically) and rejected: the group decided it should be a per-session
  setting, re-entered (or left at default) each time a roster is built, same
  as the original removed feature. No new registry/KV entity for skill.
- No validation-panel UI for skill balance (e.g. no new "✓ teams balanced"
  row). Not asked for; keep the change minimal.
- No skill-based singles-vs-doubles court assignment changes — this only
  affects *who plays whom* within the courts the existing layout algorithm
  already decided on, not `getLayout()` itself.
- No re-tuning of the existing repeat-partner/repeat-opponent weights —
  those stay as they are; skill cost terms are additive alongside them.

## Constraints

- Must not regress any existing invariant `tests/scheduling.test.js`
  already checks (sit-out fairness, conflict avoidance, pairing variety,
  cross-implementation parity, identical seeds producing identical
  schedules). Per `CLAUDE.md`'s testing guidance, expect to re-measure
  weight thresholds against seed noise once this lands — thresholds are
  observed-behavior-with-margin, not derived analytically.
- `npm test` must pass, and the same fix must land in all three copies, or
  the suite fails by design.

## What's decided (the how)

- **Rating storage & UI**: a `playerSkills` map (player name → 1/2/3) in
  SPA/worker/server state, same shape as the removed feature. Cycle button
  on each player chip (`cycleSkill`, `getSkill`, rendered in
  `renderPlayers`), sent as `players[].skill` in `syncShareQr`, restored from
  schedule snapshots in `applyScheduleSnapshot` — this is a straight
  re-add of the removed plumbing from commit `2fe6ed3`, scoped to the
  Trulioo branch (`!IS_COURTLY`) for the UI control itself.
- **i18n**: re-add `skillTierLabel`/`skillBeginner`/`skillIntermediate`/
  `skillAdvanced` keys to all **6** currently-active language blocks (not 7
  — Thai was removed separately and stays removed per `CLAUDE.md`).
- **Extend-schedule persistence**: `POST /api/schedule/:code/extend` only
  takes `{ count }` per its documented contract — it does not receive a
  fresh player/skill payload from the client. So `playerSkills` must be
  persisted as a field on the stored schedule record itself (alongside
  existing fields like `sport`), in both storage backends (`shared-data.json`
  for Node, KV for the Worker) at generate time, and `handleExtendSchedule`
  reads it from there rather than expecting it resent. A schedule generated
  before this field existed has no stored `playerSkills` — same fallback
  pattern as the `sport` field's "no sport → Rotation": extend simply skips
  the skill cost terms for that schedule rather than erroring.
- **Cost function additions** in `matchPartnersRespectingConflicts` /
  `buildRoundCourts` (doubles pool):
  - Partner-matching pass: add a term that *rewards* skill dissimilarity
    between candidate partners (e.g. `-W1 * (tierA - tierB)^2`, or
    equivalently frame existing cost as preferring the pairing that
    minimizes a "both similar" penalty — implementer's call on sign/framing
    as long as the net effect is a preference for complementary pairs),
    alongside the existing repeat-partner cost.
  - Court-assignment pass (the `greedyMatch` over partner-pairs): add the
    reinstated team-sum-difference-squared term
    (`W2 * (teamASkillSum - teamBSkillSum)^2`) alongside the existing
    cross-pair opponent-repeat cost.
- **Cost function addition** for singles pool: add a term that *penalizes*
  skill dissimilarity between candidate opponents
  (`W3 * (tierA - tierB)^2`), alongside the existing opponent-repeat cost.
- Weights `W1`/`W2`/`W3` start at the old feature's scale (it used `0.1` for
  the team-sum term) and get tuned against the new regression tests during
  implementation — exact values are an implementation detail, not fixed
  here.

## What's left to the builder

- Exact weight constants (`W1`, `W2`, `W3`) — tune against test thresholds,
  starting from the old `0.1` precedent, per the constraint above.
- Exact sign/framing of the partner-dissimilarity reward term — net
  behavior (prefer complementary partners) is fixed, the implementation
  detail of how it's expressed in the cost function is not.
- New regression test cases in `tests/scheduling.test.js` — scenarios,
  seeds, and thresholds, following the existing style (reproducible
  failures carrying seed + offending numbers).
- Whether `cycleSkill`/`getSkill` are literally restored byte-for-byte from
  `2fe6ed3` or re-written cleanly — either is fine as long as behavior
  matches this doc; the removed commit is there for reference, not as a
  mandatory diff to replay.
