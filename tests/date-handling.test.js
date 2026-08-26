'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractDeclaration } = require('./helpers/load-scheduler');

const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'src', 'index.js'), 'utf8');
const code = extractDeclaration(src, 'pacificDateStr');
assert.ok(code, 'pacificDateStr not found in worker/src/index.js');

const context = vm.createContext({ Intl, Date });
vm.runInContext(code, context);
const pacificDateStr = (d) => {
  context.__d = d;
  return vm.runInContext('pacificDateStr(__d)', context);
};

test('a Wednesday-evening Pacific session is dated Wednesday, not Thursday', () => {
  // 2026-08-19 17:58 PDT is 2026-08-20 00:58 UTC. The old code sliced the UTC
  // string and filed a real Wednesday session under Thursday.
  assert.strictEqual(pacificDateStr(new Date('2026-08-20T00:58:55.414Z')), '2026-08-19');
});

test('a Wednesday-morning Pacific session is dated the same day', () => {
  assert.strictEqual(pacificDateStr(new Date('2026-08-05T15:23:00.000Z')), '2026-08-05');
});

test('it honours standard time as well as daylight time', () => {
  // 2026-01-14 18:00 PST is 2026-01-15 02:00 UTC.
  assert.strictEqual(pacificDateStr(new Date('2026-01-15T02:00:00.000Z')), '2026-01-14');
});
