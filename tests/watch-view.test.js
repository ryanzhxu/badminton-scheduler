'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractDeclaration } = require('./helpers/load-scheduler');

const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'src', 'index.js'), 'utf8');

const context = vm.createContext({ Array, Object, Number, String, JSON });
for (const name of [
  'escapeHtml',
  'watchNameKey',
  'findPlayerInRound',
  'watchPlayerRows',
  'watchRoundRows',
  'clampRound',
  'watchPlayerText',
  'watchRoundText',
]) {
  const code = extractDeclaration(src, name);
  assert.ok(code, `${name} not found in worker/src/index.js`);
  vm.runInContext(code, context);
}

const call = (expr, args) => {
  context.__a = args;
  return vm.runInContext(`${expr}(...__a)`, context);
};

// Values built inside the vm context carry that realm's prototypes, so
// deepStrictEqual would reject them despite identical contents.
const plain = (value) => JSON.parse(JSON.stringify(value));

// Mirrors the real shape returned by /api/schedule: subs plus courts of a/b.
const SCHEDULE = {
  code: 'BADM-5GQX',
  numCourts: 2,
  players: ['Ann', 'Ben', 'Cal', 'Dee', 'Eve', 'Fay', 'Gil', 'Hal', 'Ivy', 'Jon'],
  rounds: [
    {
      subs: ['Ivy', 'Ann'],
      courts: [
        { a: ['Cal', 'Jon'], b: ['Hal', 'Gil'], singles: false },
        { a: ['Fay', 'Ben'], b: ['Eve', 'Dee'], singles: false },
      ],
    },
    {
      subs: ['Cal', 'Jon'],
      courts: [
        { a: ['Ann', 'Ivy'], b: ['Hal', 'Fay'], singles: false },
        { a: ['Ben', 'Gil'], b: ['Eve', 'Dee'], singles: false },
      ],
    },
  ],
};

test('finds a player on either side of a court', () => {
  const onA = call('findPlayerInRound', [SCHEDULE.rounds[0], 'cal']);
  assert.strictEqual(onA.court, 1);
  assert.deepStrictEqual(plain(onA.partners), ['Jon']);
  assert.deepStrictEqual(plain(onA.opponents), ['Hal', 'Gil']);

  // Side b must report the opposing team as b's opponents, not its own team.
  const onB = call('findPlayerInRound', [SCHEDULE.rounds[0], 'gil']);
  assert.strictEqual(onB.court, 1);
  assert.deepStrictEqual(plain(onB.partners), ['Hal']);
  assert.deepStrictEqual(plain(onB.opponents), ['Cal', 'Jon']);
});

test('a player sitting out is not found on any court', () => {
  assert.strictEqual(call('findPlayerInRound', [SCHEDULE.rounds[0], 'ivy']), null);
});

test('name matching ignores case and surrounding space', () => {
  assert.strictEqual(call('watchNameKey', ['  CAL ']), 'cal');
  const spot = call('findPlayerInRound', [SCHEDULE.rounds[0], call('watchNameKey', ['  Cal  '])]);
  assert.strictEqual(spot.court, 1);
});

test('player rows cover every round, marking sit-outs', () => {
  const rows = call('watchPlayerRows', [SCHEDULE, 'Ann']);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].playing, false);
  assert.strictEqual(rows[0].detail, 'sitting out');
  assert.strictEqual(rows[1].playing, true);
  assert.strictEqual(rows[1].court, 1);
  assert.strictEqual(rows[1].detail, 'with Ivy vs Hal + Fay');
});

test('round rows list both teams per court', () => {
  const rows = plain(call('watchRoundRows', [SCHEDULE.rounds[0]]));
  assert.deepStrictEqual(rows, [
    { court: 1, a: 'Cal + Jon', b: 'Hal + Gil' },
    { court: 2, a: 'Fay + Ben', b: 'Eve + Dee' },
  ]);
});

test('round number is clamped into range', () => {
  assert.strictEqual(call('clampRound', ['3', 5]), 3);
  assert.strictEqual(call('clampRound', ['0', 5]), 1);
  assert.strictEqual(call('clampRound', ['-2', 5]), 1);
  assert.strictEqual(call('clampRound', ['99', 5]), 5);
  assert.strictEqual(call('clampRound', [undefined, 5]), 1);
  assert.strictEqual(call('clampRound', ['abc', 5]), 1);
});

test('text output is plain and readable on a watch', () => {
  const txt = call('watchPlayerText', [SCHEDULE, 'Ann']);
  assert.match(txt, /^Ann — BADM-5GQX/);
  assert.match(txt, /1\/2 rounds playing/);
  assert.match(txt, /1\. sitting out/);
  assert.match(txt, /2\. Court 1 — with Ivy vs Hal \+ Fay/);
  assert.ok(!txt.includes('<'), 'text output must contain no markup');

  const round = call('watchRoundText', [SCHEDULE, 1]);
  assert.match(round, /BADM-5GQX — round 1\/2/);
  assert.match(round, /Court 1: Cal \+ Jon vs Hal \+ Gil/);
  assert.match(round, /Sitting out: Ivy, Ann/);
});

test('player names are escaped before reaching the page', () => {
  // Names are user input and the watch page renders them as markup.
  const evil = '<img src=x onerror=alert(1)>';
  const escaped = call('escapeHtml', [evil]);
  assert.ok(!escaped.includes('<'), 'must not emit a raw angle bracket');
  assert.strictEqual(escaped, '&lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(call('escapeHtml', ['A & B "q" \'s\'']), 'A &amp; B &quot;q&quot; &#39;s&#39;');
});

test('a singles court reports no partner', () => {
  const singlesRound = {
    subs: [],
    courts: [{ a: ['Ann'], b: ['Ben'], singles: true }],
  };
  const rows = call('watchPlayerRows', [{ ...SCHEDULE, rounds: [singlesRound] }, 'Ann']);
  assert.strictEqual(rows[0].detail, 'singles vs Ben');
});
