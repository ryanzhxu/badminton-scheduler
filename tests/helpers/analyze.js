'use strict';

// Derives the fairness/variety facts the tests assert on from a generated schedule.

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function courtPairs(ct) {
  const partners = [];
  const opponents = [];
  [ct.a, ct.b].forEach((team) => {
    for (let i = 0; i < team.length; i++) {
      for (let j = i + 1; j < team.length; j++) partners.push(pairKey(team[i], team[j]));
    }
  });
  ct.a.forEach((p) => ct.b.forEach((q) => opponents.push(pairKey(p, q))));
  return { partners, opponents };
}

function analyze(rounds, players) {
  const opponentCounts = new Map();
  const partnerCounts = new Map();
  const sitCounts = Object.fromEntries(players.map((p) => [p, 0]));
  const gameCounts = Object.fromEntries(players.map((p) => [p, 0]));

  // Longest run of consecutive rounds in which a given pair faced each other.
  const currentStreak = new Map();
  const longestStreak = new Map();

  rounds.forEach((rnd) => {
    (rnd.subs || []).forEach((p) => {
      if (p in sitCounts) sitCounts[p]++;
    });

    const facedThisRound = new Set();
    (rnd.courts || []).forEach((ct) => {
      [...ct.a, ...ct.b].forEach((p) => {
        if (p in gameCounts) gameCounts[p]++;
      });
      const { partners, opponents } = courtPairs(ct);
      partners.forEach((k) => partnerCounts.set(k, (partnerCounts.get(k) || 0) + 1));
      opponents.forEach((k) => {
        opponentCounts.set(k, (opponentCounts.get(k) || 0) + 1);
        facedThisRound.add(k);
      });
    });

    facedThisRound.forEach((k) => {
      const next = (currentStreak.get(k) || 0) + 1;
      currentStreak.set(k, next);
      if (next > (longestStreak.get(k) || 0)) longestStreak.set(k, next);
    });
    [...currentStreak.keys()].forEach((k) => {
      if (!facedThisRound.has(k)) currentStreak.set(k, 0);
    });
  });

  const max = (map) => (map.size ? Math.max(...map.values()) : 0);
  const vals = Object.values(sitCounts);

  return {
    opponentCounts,
    partnerCounts,
    sitCounts,
    gameCounts,
    maxOpponentMeetings: max(opponentCounts),
    maxPartnerRepeats: max(partnerCounts),
    maxConsecutiveOpponentStreak: max(longestStreak),
    longestStreak,
    sitSpread: vals.length ? Math.max(...vals) - Math.min(...vals) : 0,
  };
}

function opponentMeetings(analysis, a, b) {
  return analysis.opponentCounts.get(pairKey(a, b)) || 0;
}

function opponentStreak(analysis, a, b) {
  return analysis.longestStreak.get(pairKey(a, b)) || 0;
}

function everyRoundIsWellFormed(rounds, players, layout) {
  for (const rnd of rounds) {
    const onCourt = [];
    for (const ct of rnd.courts) onCourt.push(...ct.a, ...ct.b);
    const all = [...onCourt, ...rnd.subs];
    if (new Set(all).size !== all.length) return { ok: false, reason: 'a player appears twice in one round' };
    if (all.length !== players.length) return { ok: false, reason: `round covers ${all.length} of ${players.length} players` };
    if (all.some((p) => !players.includes(p))) return { ok: false, reason: 'round contains an unknown player' };
    if (rnd.subs.length !== layout.subs) return { ok: false, reason: 'wrong number of sit-outs' };
  }
  return { ok: true };
}

function conflictViolations(rounds, conflicts) {
  const violations = [];
  rounds.forEach((rnd, ri) => {
    rnd.courts.forEach((ct) => {
      [ct.a, ct.b].forEach((team) => {
        const conflicted = team.filter((p) => conflicts.includes(p));
        if (conflicted.length >= 2) violations.push(`R${ri + 1}: ${conflicted.join(' & ')}`);
      });
    });
  });
  return violations;
}

module.exports = {
  analyze,
  opponentMeetings,
  opponentStreak,
  everyRoundIsWellFormed,
  conflictViolations,
  pairKey,
};
