'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readInlineScript } = require('./helpers/load-scheduler');

const REPO_ROOT = path.join(__dirname, '..');

// Worker routes the SPA is not expected to call.
const UNCALLED_BY_SPA = [
  'GET /health',              // bare health check, used by uptime monitoring
  'GET /api/health',
  'POST /api/profiles',       // server-side profile storage; the SPA never posts to it
];

function workerRoutes() {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'worker', 'src', 'index.js'), 'utf8');
  return [...src.matchAll(/app\.(get|post)\('([^']+)'/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`);
}

// Matches `fetch(\`${API_BASE}/path\`, {...})` and `new EventSource(\`${API_BASE}/path\`)`.
// EventSource is always GET. fetch defaults to GET unless the options object -
// captured as a bounded window right after its opening brace - declares a method.
const CALL_RE = /(new\s+EventSource|fetch)\(\s*`\$\{API_BASE\}(\/[^`'"?\s]*)`(?:\s*,\s*\{([\s\S]{0,80}))?/g;

function spaCalls() {
  const script = readInlineScript(path.join(REPO_ROOT, 'index.html'));
  const calls = [];
  for (const m of script.matchAll(CALL_RE)) {
    const isEventSource = /EventSource/.test(m[1]);
    // `${code}` in a path is one path segment; normalize it to a :param marker.
    const callPath = m[2].replace(/\$\{[^}]*\}/g, ':param');
    let method = 'GET';
    if (!isEventSource && m[3]) {
      const methodMatch = /method\s*:\s*['"]([a-zA-Z]+)['"]/.exec(m[3]);
      if (methodMatch) method = methodMatch[1].toUpperCase();
    }
    calls.push(`${method} ${callPath}`);
  }
  return [...new Set(calls)];
}

// Mirrors the Worker's own matching: equal segment count, and a `:name`
// segment matches exactly one segment.
function pathMatches(routePath, callPath) {
  const r = routePath.split('/').filter(Boolean);
  const c = callPath.split('/').filter(Boolean);
  if (r.length !== c.length) return false;
  return r.every((seg, i) => seg.startsWith(':') || c[i].startsWith(':') || seg === c[i]);
}

// Both a route and a call are `METHOD /path` strings; the method must match
// exactly and the path must match under the Worker's segment rules.
function routeMatches(route, call) {
  const [routeMethod, routePath] = route.split(' ');
  const [callMethod, callPath] = call.split(' ');
  return routeMethod === callMethod && pathMatches(routePath, callPath);
}

test('every SPA call resolves to a registered Worker route', () => {
  const routes = workerRoutes();
  for (const call of spaCalls()) {
    assert.ok(
      routes.some((r) => routeMatches(r, call)),
      `index.html calls ${call} but no Worker route matches it`,
    );
  }
});

test('every Worker route has a caller in the SPA or is allowlisted', () => {
  const calls = spaCalls();
  for (const route of workerRoutes()) {
    if (UNCALLED_BY_SPA.includes(route)) continue;
    assert.ok(
      calls.some((c) => routeMatches(route, c)),
      `Worker route ${route} has no caller in index.html and is not in UNCALLED_BY_SPA`,
    );
  }
});

test('UNCALLED_BY_SPA has no stale entries', () => {
  const routes = workerRoutes();
  for (const entry of UNCALLED_BY_SPA) {
    assert.ok(routes.includes(entry), `UNCALLED_BY_SPA lists ${entry}, which is not a registered route`);
  }
});

test('the three version numbers agree', () => {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
  const appVersion = /const APP_VERSION\s*=\s*'([^']+)'/.exec(html)[1];
  const pkg = require(path.join(REPO_ROOT, 'package.json')).version;
  const workerPkg = require(path.join(REPO_ROOT, 'worker', 'package.json')).version;
  assert.strictEqual(pkg, appVersion, 'package.json does not match APP_VERSION');
  assert.strictEqual(workerPkg, appVersion, 'worker/package.json does not match APP_VERSION');
});
