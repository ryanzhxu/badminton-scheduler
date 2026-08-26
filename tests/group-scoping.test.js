'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractDeclaration } = require('./helpers/load-scheduler');

const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'src', 'index.js'), 'utf8');
const code = extractDeclaration(src, 'filterIndexByGroup');
assert.ok(code, 'filterIndexByGroup not found in worker/src/index.js');

const context = vm.createContext({ Array, Object });
vm.runInContext(code, context);
const filter = (index, group) => {
  context.__i = index; context.__g = group;
  return vm.runInContext('filterIndexByGroup(__i, __g)', context);
};

const INDEX = [
  { code: 'A', date: '2026-07-08' },                    // ungrouped (Trulioo-style)
  { code: 'B', date: '2026-07-15' },                    // ungrouped
  { code: 'C', date: '2026-07-22', group: 'g1' },
  { code: 'D', date: '2026-07-29', group: 'g2' },
];

test('no group returns only ungrouped entries', () => {
  // This is what preserves the Trulioo deployment: its entries have no group
  // field and its client sends no group param.
  assert.deepStrictEqual(filter(INDEX, undefined).map((e) => e.code), ['A', 'B']);
  assert.deepStrictEqual(filter(INDEX, '').map((e) => e.code), ['A', 'B']);
  assert.deepStrictEqual(filter(INDEX, null).map((e) => e.code), ['A', 'B']);
});

test('a group returns only that group', () => {
  assert.deepStrictEqual(filter(INDEX, 'g1').map((e) => e.code), ['C']);
  assert.deepStrictEqual(filter(INDEX, 'g2').map((e) => e.code), ['D']);
});

test('an unknown group returns nothing', () => {
  assert.deepStrictEqual(filter(INDEX, 'nope'), []);
});

test('a group never leaks ungrouped entries', () => {
  const out = filter(INDEX, 'g1');
  assert.ok(out.every((e) => e.group === 'g1'), 'ungrouped entry leaked into a group query');
});

test('an empty index is safe', () => {
  assert.deepStrictEqual(filter([], 'g1'), []);
  assert.deepStrictEqual(filter([], undefined), []);
});
