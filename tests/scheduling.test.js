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
  doublesPartnerSkillDiffs,
  doublesTeamSkillSumDiffs,
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

// A roster split evenly into Beginners (1) and Advanced (3), with nobody at
// the neutral default (2), so every doubles/singles cost term below has a
// skill gap to actually respond to.
const SKILL_ROSTER_12 = filler(12, 'S');
const SKEWED_SKILLS_12 = Object.fromEntries(SKILL_ROSTER_12.map((p, i) => [p, i < 6 ? 1 : 3]));
// Thresholds below are measured against SKILL_COMPLEMENT_WEIGHT /
// SKILL_TEAM_BALANCE_WEIGHT / SKILL_SINGLES_WEIGHT. A weight of 0.1 (this
// feature's first-draft value, matching the old removed feature's precedent)
// measured only ~63% crossing against this roster -- too weak to reliably
// beat the REPEAT_PARTNER_WEIGHT=1/REPEAT_OPPONENT_WEIGHT=0.6 costs it
// competes against, so all three skill weights were raised to 1 (same scale
// as REPEAT_PARTNER_WEIGHT). At weight 1, this 6-Beginner/6-Advanced roster
// measures ~92.2% doubles-partner crossing and ~0.24 average team-skill-sum
// diff across all 12 seeds -- both with comfortable margin below.
const MIN_COMPLEMENTARY_PARTNER_FRACTION = 0.85;
const MAX_AVG_TEAM_SKILL_SUM_DIFF = 0.6;

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

    describe('skill balancing', () => {
      test('pairs complementary-skill partners more than chance', () => {
        let crossing = 0;
        let total = 0;
        for (const seed of seeds) {
          const { rounds } = impl.generate({
            players: SKILL_ROSTER_12,
            numCourts: 3,
            rounds: 15,
            seed,
            playerSkills: SKEWED_SKILLS_12,
          });
          const diffs = doublesPartnerSkillDiffs(rounds, SKEWED_SKILLS_12);
          crossing += diffs.filter((d) => d > 0).length;
          total += diffs.length;
        }
        const fraction = crossing / total;
        assert.ok(
          fraction >= MIN_COMPLEMENTARY_PARTNER_FRACTION,
          `only ${(fraction * 100).toFixed(1)}% of doubles partnerships crossed the skill split ` +
            `(limit ${MIN_COMPLEMENTARY_PARTNER_FRACTION * 100}%)`,
        );
      });

      test('keeps doubles teams closer in combined skill than unweighted', () => {
        const diffs = [];
        for (const seed of seeds) {
          const { rounds } = impl.generate({
            players: SKILL_ROSTER_12,
            numCourts: 3,
            rounds: 15,
            seed,
            playerSkills: SKEWED_SKILLS_12,
          });
          diffs.push(...doublesTeamSkillSumDiffs(rounds, SKEWED_SKILLS_12));
        }
        const avg = diffs.reduce((s, d) => s + d, 0) / diffs.length;
        assert.ok(
          avg <= MAX_AVG_TEAM_SKILL_SUM_DIFF,
          `average doubles team skill-sum diff was ${avg.toFixed(2)} (limit ${MAX_AVG_TEAM_SKILL_SUM_DIFF})`,
        );
      });

      // No test asserts a measurable effect from SKILL_SINGLES_WEIGHT: getLayout
      // never produces more than one singles court per round (confirmed by
      // scanning every n from 2-30 against nc from 1-6), so the singles pool
      // handed to greedyMatch is always exactly 2 players. With only one
      // possible pairing, there is no choice for the cost term to influence --
      // singlesOpponentSkillDiffs (tests/helpers/analyze.js) measures ~1.14
      // average diff regardless of the weight, which is just this 5-Beginner/
      // 5-Advanced roster's random baseline. The cost term is still correct
      // and harmless to keep (it would bind if getLayout ever allowed a larger
      // singles overflow), but there is nothing here to regression-test today.

      test('variety invariants still hold on a skill-skewed roster', () => {
        // The skill-complementary reward can be more negative than the
        // repeat-partner cost for a same-skill pair's first couple of
        // meetings (reward up to -1*2^2=-4 vs. a first/second repeat's
        // +1*1=1 or +1*4=4), so a skill-skewed roster is exactly the case
        // where raising the skill weights could erode partner/opponent
        // variety without any other test noticing -- this pins the same
        // MAX_OPPONENT_STREAK/MAX_PARTNER_REPEATS bounds used above to that
        // scenario.
        for (const seed of seeds) {
          const { rounds } = impl.generate({
            players: SKILL_ROSTER_12,
            numCourts: 3,
            rounds: 15,
            seed,
            playerSkills: SKEWED_SKILLS_12,
          });
          const a = analyze(rounds, SKILL_ROSTER_12);
          assert.ok(
            a.maxConsecutiveOpponentStreak <= MAX_OPPONENT_STREAK,
            `seed ${seed}: skill-skewed roster hit a ${a.maxConsecutiveOpponentStreak}-round ` +
              `consecutive opponent streak (limit ${MAX_OPPONENT_STREAK})`,
          );
          assert.ok(
            a.maxPartnerRepeats <= MAX_PARTNER_REPEATS,
            `seed ${seed}: skill-skewed roster partnered a pair ${a.maxPartnerRepeats} times ` +
              `(limit ${MAX_PARTNER_REPEATS})`,
          );
        }
      });

      test('conflicts still outrank skill complementarity', () => {
        // S1 and S7 are each other's only maximally-complementary match (skill
        // 1 vs 3) in this roster, which is exactly the pairing the new partner
        // cost rewards most -- so this is the case most likely to tempt a
        // conflict violation if skill ever outweighs the conflict guarantee.
        const conflicts = ['S1', 'S7'];
        for (const seed of seeds) {
          const { rounds } = impl.generate({
            players: SKILL_ROSTER_12,
            numCourts: 3,
            rounds: 15,
            seed,
            conflicts,
            playerSkills: SKEWED_SKILLS_12,
          });
          const violations = conflictViolations(rounds, conflicts);
          assert.deepEqual(violations, [], `seed ${seed}: conflicted players ended up as teammates`);
        }
      });
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
