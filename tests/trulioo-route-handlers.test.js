'use strict';

// Covers Review Focus #1 and #2 from docs/superpowers/plans/2026-11-27-trulioo-link-preview-card.md,
// which previously had only manual `wrangler dev` verification: an
// unresolvable scheduleCode must fall back to a redirect rather than a broken
// card, and the literal "current" pseudo-code must be admitted by every new
// code path. The plan itself names a regex regression as the one thing that
// can break #2 -- this pins that regex directly.
//
// Extracts declarations from the real sources (same approach as
// tests/watch-view.test.js), rather than importing them, for the reasons
// documented in tests/helpers/load-scheduler.js: no express/hono/listener,
// and no workers-og/Cloudflare-runtime dependency for this logic, which is
// plain data/control flow once the KV read is mocked out.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractDeclaration } = require('./helpers/load-scheduler');

const REPO_ROOT = path.join(__dirname, '..');
const entrySrc = fs.readFileSync(path.join(REPO_ROOT, 'worker', 'src', 'trulioo-entry.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(REPO_ROOT, 'worker', 'src', 'index.js'), 'utf8');

function buildContext() {
  const context = vm.createContext({
    Array, Object, String, Number, JSON, Response, URL,
    // handleScheduleOgImage's free variables, normally imported at the top of
    // index.js -- stubbed to throw if ever invoked, so a test that expects
    // the 302-fallback branch also proves the happy-path branch was never
    // reached (the schedule-not-found short-circuit happens before any of
    // these would be called).
    ImageResponse: class { constructor() { throw new Error('ImageResponse should not be constructed when the schedule is unresolvable'); } },
    buildOgCardData: () => { throw new Error('buildOgCardData should not be called when the schedule is unresolvable'); },
    renderOgCardHtml: () => { throw new Error('renderOgCardHtml should not be called when the schedule is unresolvable'); },
  });
  for (const name of ['SCHEDULE_PREFIX', 'CURRENT_SCHEDULE_KEY', 'OG_FALLBACK_IMAGE_URL', 'getJson', 'scheduleKey', 'loadSchedule', 'loadCurrentSchedule', 'handleScheduleOgImage']) {
    const code = extractDeclaration(indexSrc, name);
    assert.ok(code, `${name} not found in worker/src/index.js`);
    vm.runInContext(code, context);
  }
  return context;
}

function fakeKvContext(code, kvGet) {
  const context = buildContext();
  context.__c = {
    req: { param: (key) => (key === 'code' ? code : undefined) },
    env: { SCHEDULES: { get: kvGet } },
  };
  return context;
}

test('handleScheduleOgImage falls back to a redirect when the schedule code does not resolve in KV', async () => {
  const context = fakeKvContext('BADM-ZZZZ', async () => null);
  const response = await vm.runInContext('handleScheduleOgImage(__c)', context);
  assert.strictEqual(response.status, 302);
  assert.match(response.headers.get('Location'), /og-trulioo\.png$/);
});

test('handleScheduleOgImage falls back to a redirect for the "current" pseudo-code when nothing is set yet', async () => {
  const context = fakeKvContext('current', async () => null);
  const response = await vm.runInContext('handleScheduleOgImage(__c)', context);
  assert.strictEqual(response.status, 302);
});

test('handleScheduleOgImage falls back to a redirect when buildOgCardData rejects the stored schedule', async () => {
  // A schedule exists in KV but is missing what buildOgCardData needs (e.g. no
  // rounds yet) -- exercises the "schedule found but cardData is null" branch,
  // distinct from the "schedule not found at all" branch above.
  const context = fakeKvContext('BADM-ABCD', async () => ({ players: [] }));
  context.buildOgCardData = () => null;
  const response = await vm.runInContext('handleScheduleOgImage(__c)', context);
  assert.strictEqual(response.status, 302);
});

const context = vm.createContext({ Array, Object, String, Number, encodeURIComponent });
for (const name of ['RENDER_APP_URL', 'SCHEDULE_CODE_RE', 'buildRedirectUrl']) {
  const code = extractDeclaration(entrySrc, name);
  assert.ok(code, `${name} not found in worker/src/trulioo-entry.js`);
  vm.runInContext(code, context);
}

test('SCHEDULE_CODE_RE admits the literal "current" pseudo-code', () => {
  assert.ok(vm.runInContext("SCHEDULE_CODE_RE.test('current')", context));
});

test('SCHEDULE_CODE_RE admits a well-formed real schedule code', () => {
  assert.ok(vm.runInContext("SCHEDULE_CODE_RE.test('BADM-7F2K')", context));
});

test('SCHEDULE_CODE_RE rejects garbage, wrong case, and malformed codes', () => {
  for (const bad of ['badm-7f2k', 'BADM-7F2', 'BADM-7F2K5', 'current ', ' current', '', 'current2']) {
    assert.ok(!vm.runInContext(`SCHEDULE_CODE_RE.test(${JSON.stringify(bad)})`, context), `expected "${bad}" to be rejected`);
  }
});

test('buildRedirectUrl points at the real Render app with the code preserved', () => {
  assert.strictEqual(
    vm.runInContext("buildRedirectUrl('BADM-7F2K')", context),
    'https://trulioo-badminton.onrender.com/?scheduleCode=BADM-7F2K',
  );
});
