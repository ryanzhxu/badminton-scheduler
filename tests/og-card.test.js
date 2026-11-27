'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

async function loadOgCard() {
  return import('../worker/src/og-card.js');
}

function makeSchedule({ courts, players, singles = false, sport = 'badminton' }) {
  const playerNames = Array.from({ length: players }, (_, i) => `Player${i}`);
  let roundCourts;
  if (singles) {
    roundCourts = [{ a: ['Alice'], b: ['Bob'], singles: true }];
  } else {
    roundCourts = Array.from({ length: courts }, (_, i) => ({
      a: [`A${i}-1`, `A${i}-2`],
      b: [`B${i}-1`, `B${i}-2`],
      singles: false,
    }));
  }
  return {
    players: playerNames,
    numCourts: courts,
    sport,
    generatedAt: '2026-11-28T18:00:00.000Z',
    rounds: [{ subs: [], courts: roundCourts }],
  };
}

test('buildOgCardData: caps courts at 3 with an overflow count', async () => {
  const { buildOgCardData } = await loadOgCard();
  const schedule = makeSchedule({ courts: 5, players: 20 });
  const data = buildOgCardData(schedule);
  assert.equal(data.courts.length, 3);
  assert.equal(data.overflowCourtCount, 2);
});

test('buildOgCardData: caps avatars at 6 with an overflow count and a playing-tonight count', async () => {
  const { buildOgCardData } = await loadOgCard();
  const schedule = makeSchedule({ courts: 2, players: 10 });
  const data = buildOgCardData(schedule);
  assert.equal(data.avatars.length, 6);
  assert.equal(data.overflowPlayerCount, 4);
  assert.equal(data.playingCount, 10);
});

test('buildOgCardData: a singles court in round 1 shows the one player on each side', async () => {
  const { buildOgCardData } = await loadOgCard();
  const schedule = makeSchedule({ courts: 1, players: 2, singles: true });
  const data = buildOgCardData(schedule);
  assert.equal(data.courts[0].teamA, 'Alice');
  assert.equal(data.courts[0].teamB, 'Bob');
});

test('buildOgCardData: returns null for a schedule missing round 1', async () => {
  const { buildOgCardData } = await loadOgCard();
  assert.equal(buildOgCardData({ players: [], rounds: [] }), null);
});

test('buildCardMetaText: mirrors Courtly\'s text shape with sport, headcount, courts, rounds, date', async () => {
  const { buildCardMetaText } = await loadOgCard();
  const schedule = makeSchedule({ courts: 2, players: 10, sport: 'badminton' });
  const meta = buildCardMetaText(schedule);
  assert.equal(meta.title, 'Badminton · 10 players');
  assert.match(meta.description, /^10 players · 2 courts · \d+ rounds · [A-Za-z]{3} \d{1,2}$/);
});

test('buildCardMetaText: returns null for an unrenderable schedule', async () => {
  const { buildCardMetaText } = await loadOgCard();
  assert.equal(buildCardMetaText({ players: [], rounds: [] }), null);
});

test('renderOgCardHtml: embeds every court matchup, the overflow tile, and the avatar/overflow footer', async () => {
  const { buildOgCardData, renderOgCardHtml } = await loadOgCard();
  const data = buildOgCardData(makeSchedule({ courts: 5, players: 20 }));
  const html = renderOgCardHtml(data);
  assert.match(html, /ROUND 1 OF/);
  assert.ok(html.includes(data.courts[0].teamA));
  assert.ok(html.includes(data.courts[0].teamB));
  assert.match(html, /\+2[^\d]*courts/i);
  assert.match(html, /\+14/); // overflow avatar count
  assert.match(html, /20 playing tonight/);
});
