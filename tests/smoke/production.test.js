'use strict';

// Live network check that the hosts hardcoded into index.html's API_BASE are
// actually serving the Worker, not Cloudflare's own 404 page. Separate from
// `npm test`: the rest of the suite is deliberately network-free (see
// tests/helpers/load-scheduler.js), so this lives under tests/smoke/ and runs
// via `npm run test:smoke` instead of being swept up by `tests/*.test.js`.
//
// Written after a real outage (2026-11-26): a custom domain route retired
// Trulioo's workers.dev subdomain, but index.html kept the dead URL, and
// nothing caught it until a user reported every API call failing. The static
// check in tests/api-contract.test.js now catches that specific drift
// mechanically; this test is the backstop for any other way the hardcoded
// host could go dark (DNS, cert expiry, the Worker itself erroring).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const TIMEOUT_MS = 10000;

function productionApiHosts() {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
  const m = /IS_COURTLY\?\s*'([^']+)'\s*:\s*'([^']+)'/.exec(html);
  assert.ok(m, 'could not find the `IS_COURTLY ? <courtly-url> : <trulioo-url>` API_BASE ternary in index.html');
  return { courtly: m[1], trulioo: m[2] };
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const hosts = productionApiHosts();

for (const [brand, base] of Object.entries(hosts)) {
  test(`${brand} production API_BASE (${base}) is live`, async () => {
    const res = await fetchWithTimeout(`${base}/health`, TIMEOUT_MS);
    assert.strictEqual(res.status, 200, `${base}/health returned HTTP ${res.status}`);
    const body = await res.json();
    assert.strictEqual(body.ok, true, `${base}/health body was not {ok: true}: ${JSON.stringify(body)}`);
  });
}
