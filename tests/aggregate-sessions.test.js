'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractDeclaration } = require('./helpers/load-scheduler');

const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'src', 'index.js'), 'utf8');
const code = extractDeclaration(src, 'aggregateSessions');
assert.ok(code, 'aggregateSessions not found in worker/src/index.js');

const context = vm.createContext({ Set, Map, Object, Array, JSON });
vm.runInContext(code, context);
const aggregate = (sessions) => {
  context.__s = sessions;
  context.__c = (n) => n;
  return JSON.parse(vm.runInContext('JSON.stringify(aggregateSessions(__s, __c))', context));
};

// One round: A+B beat C+D, E sits out.
const oneRound = {
  date: '2026-08-19',
  schedule: {
    rounds: [
      { subs: ['E'], courts: [{ a: ['A', 'B'], b: ['C', 'D'] }] },
    ],
  },
};

test('counts games, sits and sessions', () => {
  const r = aggregate([oneRound]);
  assert.strictEqual(r.A.games, 1);
  assert.strictEqual(r.A.sits, 0);
  assert.strictEqual(r.E.games, 0);
  assert.strictEqual(r.E.sits, 1);
  assert.strictEqual(r.E.sessions, 1, 'a player who only sat out still attended');
});

test('counts partners and opponents pairwise, not just uniquely', () => {
  const r = aggregate([oneRound, oneRound]);
  assert.strictEqual(r.A.partners.B, 2, 'A partnered B in both sessions');
  assert.strictEqual(r.A.opponents.C, 2);
  assert.strictEqual(r.A.opponents.D, 2);
  assert.strictEqual(r.A.partners.C, undefined, 'opponents are not partners');
});

test('records the dates a player attended', () => {
  const r = aggregate([oneRound]);
  assert.deepStrictEqual(r.A.dates, ['2026-08-19']);
});

test('ignores a session with no rounds', () => {
  const r = aggregate([{ date: '2026-08-19', schedule: {} }]);
  assert.deepStrictEqual(r, {});
});
