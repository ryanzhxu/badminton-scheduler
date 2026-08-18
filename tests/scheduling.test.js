'use strict';

// Regression suite for the rotation scheduler.
//
// Run with `npm test`. Every test runs against all three implementations of the
// algorithm (the SPA's inline script, the Cloudflare Worker, and the Express
// server) so the three cannot drift apart unnoticed.
//
// Schedules are generated from a seeded PRNG, so a failure is reproducible: the
// assertion messages include the seed that produced the bad schedule.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { loadImplementations } = require('./helpers/load-scheduler.js');
const {
  analyze,
  everyRoundIsWellFormed,
  conflictViolations,
} = require('./helpers/analyze.js');

const implementations = loadImplementations();

// Bounds are set from measured behavior with room for seed variation, while
// still failing decisively on the bug they guard. For the 12-player scenario
// below, the pre-fix algorithm produced streaks of 5-11 and 9-13 meetings for
// the same pair; the fixed algorithm produces streaks of 1 and 2-4 meetings.
const MAX_OPPONENT_STREAK = 4;
const MAX_OPPONENT_MEETINGS = 6;
const MAX_PARTNER_REPEATS = 5;
// The pre-fix algorithm violated the opponent bounds on every seed, so a dozen
// seeds is ample for the regression guard. Secondary invariants sweep more
// scenarios instead of more seeds, to keep the suite quick enough to run often.
const seeds = Array.from({ length: 12 }, (_, i) => i + 1);
const quickSeeds = seeds.slice(0, 6);

const filler = (n, prefix = 'P') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

// Mirrors the reported session: 12 players, 3 courts, nobody sits out.
const REPORTED_SESSION = {
  players: ['Vincent', 'Jerry', ...filler(10)],
  numCourts: 3,
  rounds: 15,
};

for (const impl of implementations) {
  describe(impl.name, () => {
    test('no pair faces each other for a long consecutive streak', () => {
      const scenarios = [
        REPORTED_SESSION,
        { players: filler(12), numCourts: 3, rounds: 15 },
        { players: filler(14), numCourts: 3, rounds: 15 },
      ];
      for (const scenario of scenarios) {
        for (const seed of quickSeeds) {
          const { rounds } = impl.generate({ ...scenario, seed });
          const a = analyze(rounds, scenario.players);
          assert.ok(
            a.maxConsecutiveOpponentStreak <= MAX_OPPONENT_STREAK,
            `${scenario.players.length} players, seed ${seed}: some pair faced each other for ` +
              `${a.maxConsecutiveOpponentStreak} consecutive rounds (limit ${MAX_OPPONENT_STREAK})`,
          );
        }
      }
    });

    test('spreads opponents and partners across the roster', () => {
      for (const seed of seeds) {
        const { rounds } = impl.generate({ ...REPORTED_SESSION, seed });
        const a = analyze(rounds, REPORTED_SESSION.players);
        assert.ok(
          a.maxOpponentMeetings <= MAX_OPPONENT_MEETINGS,
          `seed ${seed}: a pair met ${a.maxOpponentMeetings} times (limit ${MAX_OPPONENT_MEETINGS})`,
        );
        assert.ok(
          a.maxPartnerRepeats <= MAX_PARTNER_REPEATS,
          `seed ${seed}: a pair partnered ${a.maxPartnerRepeats} times (limit ${MAX_PARTNER_REPEATS})`,
        );
      }
    });

    test('keeps sit-outs within one round of each other', () => {
      for (const players of [filler(13), filler(14), filler(17)]) {
        for (const seed of quickSeeds) {
          const { rounds } = impl.generate({ players, numCourts: 3, rounds: 12, seed });
          const a = analyze(rounds, players);
          assert.ok(
            a.sitSpread <= 1,
            `${players.length} players, seed ${seed}: sit-out counts range by ${a.sitSpread} ` +
              `(${JSON.stringify(a.sitCounts)})`,
          );
        }
      }
    });

    test('never puts conflict-group players on the same team', () => {
      const players = filler(12);
      const conflicts = ['P1', 'P2', 'P3'];
      for (const seed of seeds) {
        const { rounds } = impl.generate({ players, numCourts: 3, rounds: 15, conflicts, seed });
        const violations = conflictViolations(rounds, conflicts);
        assert.deepEqual(violations, [], `seed ${seed}: conflicted players ended up as teammates`);
      }
    });

    test('every round covers every player exactly once', () => {
      const scenarios = [
        { players: filler(10), numCourts: 3, rounds: 10 }, // forces a 1v1 singles court
        { players: filler(12), numCourts: 3, rounds: 10 },
        { players: filler(13), numCourts: 3, rounds: 10 },
        { players: filler(20), numCourts: 5, rounds: 10 },
      ];
      for (const scenario of scenarios) {
        for (const seed of quickSeeds) {
          const { rounds, layout } = impl.generate({ ...scenario, seed });
          const result = everyRoundIsWellFormed(rounds, scenario.players, layout);
          assert.ok(
            result.ok,
            `${scenario.players.length} players on ${scenario.numCourts} courts, seed ${seed}: ${result.reason}`,
          );
        }
      }
    });

    // Extending a shared schedule rebuilds pair history by replaying the rounds
    // already played. If that replay is dropped, added rounds go back to
    // repeating matchups the group has already had.
    test('carries pair history across schedule extension', () => {
      for (const seed of seeds) {
        const first = impl.generate({ ...REPORTED_SESSION, rounds: 10, seed });

        const history = impl.createPairHistory();
        const sitCounts = Object.fromEntries(REPORTED_SESSION.players.map((p) => [p, 0]));
        first.rounds.forEach((rnd) => {
          rnd.subs.forEach((p) => {
            sitCounts[p] += 1;
          });
          impl.recordRound(history, rnd.courts);
        });
        assert.ok(history.opponents.size > 0, 'replaying played rounds produced no opponent history');

        const extra = impl.generate({
          ...REPORTED_SESSION,
          rounds: 5,
          seed: seed + 1000,
          history,
          sitCounts,
        });

        const a = analyze([...first.rounds, ...extra.rounds], REPORTED_SESSION.players);
        assert.ok(
          a.maxConsecutiveOpponentStreak <= MAX_OPPONENT_STREAK,
          `seed ${seed}: after extending, some pair faced each other for ` +
            `${a.maxConsecutiveOpponentStreak} consecutive rounds (limit ${MAX_OPPONENT_STREAK})`,
        );
        assert.ok(
          a.maxOpponentMeetings <= MAX_OPPONENT_MEETINGS,
          `seed ${seed}: after extending, a pair met ${a.maxOpponentMeetings} times ` +
            `(limit ${MAX_OPPONENT_MEETINGS})`,
        );
      }
    });
  });
}

// AGENTS.md requires the Node and Worker paths to stay behaviorally aligned, and
// the SPA generates rounds locally too. Identical seeds must give identical
// schedules, otherwise a fix applied to one copy silently missed the others.
describe('implementations stay aligned', () => {
  test('all implementations generate identical schedules for the same seed', () => {
    const [reference, ...others] = implementations;
    for (const seed of seeds) {
      const expected = reference.generate({ ...REPORTED_SESSION, seed }).rounds;
      for (const impl of others) {
        assert.deepEqual(
          impl.generate({ ...REPORTED_SESSION, seed }).rounds,
          expected,
          `${impl.name} diverged from ${reference.name} on seed ${seed}`,
        );
      }
    }
  });

  test('all implementations agree on court layouts', () => {
    const [reference, ...others] = implementations;
    for (let n = 4; n <= 30; n++) {
      for (let nc = 1; nc <= 6; nc++) {
        const expected = reference.getLayout(n, nc);
        for (const impl of others) {
          assert.deepEqual(
            impl.getLayout(n, nc),
            expected,
            `${impl.name} disagreed on the layout for ${n} players / ${nc} courts`,
          );
        }
      }
    }
  });
});
