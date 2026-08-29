import QRCode from './qrcode-svg.js';
import playerCountryLookupRaw from '../../player-countries.json';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const SSE_PING_MS = 25000;

const SCHEDULE_PREFIX = 'schedule:';
const CURRENT_SCHEDULE_KEY = 'current_schedule';
const PROFILES_KEY = 'profiles';
const PLAYER_REGISTRY_KEY = 'players:registry';
const PLAYER_ALIASES_KEY = 'players:aliases';
const SCHEDULE_INDEX_KEY = 'schedules:index';

// Courtly's config (worker/wrangler.courtly.toml) sets SCHEDULE_TTL_SECONDS so
// public schedules self-expire; Trulioo's worker/wrangler.toml does not set it.
// Single source of truth for every public-vs-private branch in this file.
function isPublicMode(env) {
  return Number(env.SCHEDULE_TTL_SECONDS) > 0;
}

function normalizePlayerName(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function loadCountryLookup(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(raw)
      .map(([name, code]) => [
        normalizePlayerName(name),
        String(code || '').trim().toUpperCase(),
      ])
      .filter(([, code]) => /^[A-Z]{2}$/.test(code)),
  );
}

const playerCountryLookup = loadCountryLookup(playerCountryLookupRaw);

function readBooleanFlag(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function getShowCountryLabelFlag(env) {
  return readBooleanFlag(
    env?.SHOW_COUNTRY_LABELS ??
      env?.SHOW_COUNTRY_LABEL ??
      env?.COUNTRY_LABELS_ENABLED,
  );
}

function createHeaders(init = {}) {
  return new Headers(init);
}

function applyCors(response) {
  const headers = createHeaders(response.headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    headers.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function normalizePath(path) {
  if (!path || path === '/') return '/';
  const stripped = path.replace(/\/+$/, '');
  return stripped || '/';
}

function splitPath(path) {
  return normalizePath(path).split('/').filter(Boolean);
}

function matchPath(pattern, path) {
  if (pattern === '*' || pattern === '/*') {
    return { params: {} };
  }

  const patternParts = splitPath(pattern);
  const pathParts = splitPath(path);

  if (patternParts.length !== pathParts.length) {
    return null;
  }

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    const expected = patternParts[i];
    const actual = pathParts[i];
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) {
      return null;
    }
  }

  return { params };
}

function jsonResponse(data, init = {}) {
  const headers = createHeaders(init.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
  }
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

function textResponse(text, init = {}) {
  const headers = createHeaders(init.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'text/plain; charset=utf-8');
  }
  return new Response(text, {
    ...init,
    headers,
  });
}

function toResponse(value) {
  if (value instanceof Response) return value;
  if (value === undefined || value === null) {
    return new Response(null, { status: 204 });
  }
  if (typeof value === 'string') {
    return textResponse(value);
  }
  return jsonResponse(value);
}

function cors() {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }
    return next();
  };
}

function createRequestContext(request, env, params) {
  const url = new URL(request.url);
  return {
    req: {
      raw: request,
      method: request.method,
      url,
      header: (name) => request.headers.get(name),
      json: () => request.json(),
      text: () => request.text(),
      param: (name) => params[name],
      query: (name) => url.searchParams.get(name),
    },
    env,
    json: (data, init) => jsonResponse(data, init),
    text: (text, init) => textResponse(text, init),
  };
}

class Hono {
  constructor() {
    this.middlewares = [];
    this.routes = [];
  }

  use(path, handler) {
    if (typeof path === 'function') {
      handler = path;
      path = '*';
    }
    this.middlewares.push({ path, handler });
    return this;
  }

  get(path, handler) {
    this.routes.push({ method: 'GET', path, handler });
    return this;
  }

  post(path, handler) {
    this.routes.push({ method: 'POST', path, handler });
    return this;
  }

  async fetch(request, env = {}, ctx = {}) {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    const routeEntry = this.routes.find((route) => {
      if (route.method !== request.method) return false;
      return matchPath(route.path, path) !== null;
    });

    const match = routeEntry ? matchPath(routeEntry.path, path) : null;
    const c = createRequestContext(request, env, match ? match.params : {});

    const run = async (index) => {
      while (index < this.middlewares.length) {
        const middleware = this.middlewares[index];
        index += 1;
        if (!matchPath(middleware.path, path)) continue;
        return middleware.handler(c, () => run(index));
      }
      if (!routeEntry) {
        return jsonResponse({ error: 'Not found' }, { status: 404 });
      }
      return routeEntry.handler(c, ctx);
    };

    try {
      return applyCors(toResponse(await run(0)));
    } catch (error) {
      return applyCors(
        jsonResponse(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        ),
      );
    }
  }
}

function generateScheduleCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'BADM-';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function buildShareUrl(baseUrl, scheduleCode) {
  const root = (baseUrl || '').trim().replace(/\/$/, '');
  if (!root) return scheduleCode;
  return `${root}/?scheduleCode=${encodeURIComponent(scheduleCode)}`;
}

function getLayout(n, nc) {
  if (n < nc * 2) return null;
  for (let s = 0; s <= 3; s++) {
    const a = n - s;
    if (a < nc * 2) break;
    const r = a % 4;
    if (r === 0) {
      const d = a / 4;
      if (d === nc) return { doubles: nc, singles: 0, subs: s };
      if (d > nc) return { doubles: nc, singles: 0, subs: s + (d - nc) * 4 };
    }
    if (r === 2) {
      const d = Math.floor(a / 4);
      if (d + 1 <= nc) return { doubles: d, singles: 1, subs: s };
    }
  }
  if (n >= nc * 4) return { doubles: nc, singles: 0, subs: n - nc * 4 };
  for (let s = 0; s <= n - nc * 2; s++) {
    const a = n - s;
    const r = a % 4;
    if (r === 0 || r === 2) {
      return { doubles: Math.floor(a / 4), singles: r === 2 ? 1 : 0, subs: s };
    }
  }
  return { doubles: 0, singles: nc, subs: n - nc * 2 };
}

function shuffle(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function teamKey(t) {
  return [...t].sort().join('|');
}

function conflictPair(a, b, conflictGroup) {
  return conflictGroup.length >= 2 && conflictGroup.includes(a) && conflictGroup.includes(b);
}

function teamOk(t, conflictGroup) {
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 1; j < t.length; j++) {
      if (conflictPair(t[i], t[j], conflictGroup)) return false;
    }
  }
  return true;
}

// Repeat costs are squared in how many times a pair has already met, so the search
// keeps spreading pairings out instead of going blind once every combination has
// been used once. Back-to-back rematches cost extra because a streak is what
// players actually notice.
const REPEAT_PARTNER_WEIGHT = 1;
const REPEAT_OPPONENT_WEIGHT = 0.6;
const CONSECUTIVE_OPPONENT_WEIGHT = 3;
function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function createPairHistory() {
  return { partners: new Map(), opponents: new Map(), lastOpponents: new Set() };
}

function courtPairs(ct) {
  const partners = [];
  const opponents = [];
  [ct.a, ct.b].forEach((team) => {
    for (let i = 0; i < team.length; i++) {
      for (let j = i + 1; j < team.length; j++) {
        partners.push(pairKey(team[i], team[j]));
      }
    }
  });
  ct.a.forEach((p) => ct.b.forEach((q) => opponents.push(pairKey(p, q))));
  return { partners, opponents };
}

function recordRound(hist, courts) {
  const thisRound = new Set();
  (courts || []).forEach((ct) => {
    const { partners, opponents } = courtPairs(ct);
    partners.forEach((k) => hist.partners.set(k, (hist.partners.get(k) || 0) + 1));
    opponents.forEach((k) => {
      hist.opponents.set(k, (hist.opponents.get(k) || 0) + 1);
      thisRound.add(k);
    });
  });
  hist.lastOpponents = thisRound;
}

// Generic greedy minimum-cost perfect matching over an even-length list. Builds
// every candidate pair, shuffles first so equal-cost ties vary from run to run,
// then stable-sorts by cost and greedily accepts the cheapest pair whose two
// items are both still free. This is not a guaranteed-optimal assignment (a
// true optimum needs a full blossom algorithm), but for our small squared
// repeat costs it reliably beats random sampling once a group is bigger than a
// handful of players, and it runs in a single pass instead of hundreds of
// random restarts.
function greedyMatch(items, costFn) {
  const pool = shuffle(items);
  const remaining = new Set(pool);
  const candidates = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      candidates.push([pool[i], pool[j], costFn(pool[i], pool[j])]);
    }
  }
  candidates.sort((x, y) => x[2] - y[2]);
  const pairs = [];
  candidates.forEach(([a, b, c]) => {
    if (c === Infinity) return;
    if (remaining.has(a) && remaining.has(b)) {
      pairs.push([a, b]);
      remaining.delete(a);
      remaining.delete(b);
    }
  });
  // Anything left over means every remaining option was forbidden -- pair them
  // off by lowest cost anyway, since a schedule must still be produced. This is
  // the only path that can leave a conflict-group pair together.
  const leftover = [...remaining];
  while (leftover.length >= 2) {
    const a = leftover.shift();
    let bestIdx = 0;
    let bestCost = Infinity;
    for (let i = 0; i < leftover.length; i++) {
      const c = costFn(a, leftover[i]);
      if (c < bestCost) {
        bestCost = c;
        bestIdx = i;
      }
    }
    pairs.push([a, leftover[bestIdx]]);
    leftover.splice(bestIdx, 1);
  }
  return pairs;
}

// The single global conflict group behaves like one "no two of these may be
// teammates" clique. Matching its members first, while non-clique partners are
// still plentiful, is what actually guarantees zero conflict violations
// whenever a valid pairing exists -- a plain greedy pass over everyone can
// paint itself into a corner and force an avoidable violation just from bad
// luck in candidate order.
function matchPartnersRespectingConflicts(activePl, hist, conflictGroup) {
  const partnerCost = (a, b) => {
    const n = hist.partners.get(pairKey(a, b)) || 0;
    return n * n * REPEAT_PARTNER_WEIGHT;
  };
  const cliqueActive = activePl.filter((p) => conflictGroup.includes(p));
  if (cliqueActive.length < 2) return greedyMatch(activePl, partnerCost);
  const cliqueSet = new Set(cliqueActive);
  const nonClique = shuffle(activePl.filter((p) => !cliqueSet.has(p)));
  const clique = shuffle(cliqueActive);
  const pairs = [];
  const usedNonClique = new Set();
  clique.forEach((p) => {
    const available = nonClique.filter((q) => !usedNonClique.has(q));
    if (!available.length) return;
    let bestQ = available[0];
    let bestCost = partnerCost(p, available[0]);
    for (let i = 1; i < available.length; i++) {
      const c = partnerCost(p, available[i]);
      if (c < bestCost) {
        bestCost = c;
        bestQ = available[i];
      }
    }
    usedNonClique.add(bestQ);
    pairs.push([p, bestQ]);
  });
  const matchedClique = new Set(pairs.map((pr) => pr[0]));
  const leftoverClique = clique.filter((p) => !matchedClique.has(p));
  const leftoverNonClique = nonClique.filter((q) => !usedNonClique.has(q));
  pairs.push(...greedyMatch([...leftoverClique, ...leftoverNonClique], partnerCost));
  return pairs;
}

// Builds one round's courts: splits the active pool into the singles slots and
// the doubles pool, pairs up doubles partners with conflicts respected (above),
// then matches those partner-pairs against each other -- and matches singles
// opponents directly -- to minimize repeated opponents, with an extra penalty
// for an immediate rematch.
function buildRoundCourts(activePl, layout, hist, conflictGroup) {
  const shuffled = shuffle(activePl);
  const singlesCount = layout.singles * 2;
  const singlesPl = shuffled.slice(0, singlesCount);
  const doublesPl = shuffled.slice(singlesCount);
  const opponentCost = (a, b) => {
    const k = pairKey(a, b);
    const n = hist.opponents.get(k) || 0;
    let c = n * n * REPEAT_OPPONENT_WEIGHT;
    if (hist.lastOpponents.has(k)) c += CONSECUTIVE_OPPONENT_WEIGHT;
    return c;
  };
  const partnerPairs = matchPartnersRespectingConflicts(doublesPl, hist, conflictGroup);
  const courtPairCost = (pairA, pairB) => {
    let c = 0;
    pairA.forEach((p) => pairB.forEach((q) => { c += opponentCost(p, q); }));
    return c;
  };
  const doublesCourts = greedyMatch(partnerPairs, courtPairCost).map(([a, b]) => ({ a, b, singles: false }));
  const singlesCourts = greedyMatch(singlesPl, opponentCost).map(([a, b]) => ({ a: [a], b: [b], singles: true }));
  return [...doublesCourts, ...singlesCourts];
}

function generateRounds(rawPlayers, layout, conflictGroup, count, sitC = null, history = null) {
  if (sitC === null) {
    sitC = {};
    rawPlayers.forEach((p) => (sitC[p] = 0));
  }
  if (history === null) {
    history = createPairHistory();
  }
  const rounds = [];
  for (let r = 0; r < count; r++) {
    const sorted = shuffle(rawPlayers).sort((a, b) => sitC[a] - sitC[b]);
    const subs = sorted.slice(0, layout.subs);
    subs.forEach((p) => sitC[p]++);
    const activePl = rawPlayers.filter((p) => !subs.includes(p));
    const courts = buildRoundCourts(activePl, layout, history, conflictGroup);
    recordRound(history, courts);
    rounds.push({ subs, courts });
  }
  return rounds;
}

function healthPayload() {
  return {
    ok: true,
    service: 'badminton-scheduler-api',
    timestamp: new Date().toISOString(),
  };
}

function getScheduleRevision(schedule) {
  const revision = Number(schedule?.revision);
  return Number.isFinite(revision) && revision >= 0 ? revision : 0;
}

function touchSchedule(schedule) {
  const now = new Date().toISOString();
  schedule.revision = getScheduleRevision(schedule) + 1;
  schedule.updatedAt = now;
  if (!schedule.generatedAt) {
    schedule.generatedAt = now;
  }
  return schedule;
}

function formatSseMessage({ event, data, id }) {
  const lines = [];
  if (id !== undefined && id !== null) {
    lines.push(`id: ${id}`);
  }
  if (event) {
    lines.push(`event: ${event}`);
  }
  if (data !== undefined) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    payload.split(/\r?\n/).forEach((line) => lines.push(`data: ${line}`));
  }
  return `${lines.join('\n')}\n\n`;
}

function createSseHeaders() {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

function scheduleStreamPayload(schedule) {
  return {
    code: schedule.code,
    revision: getScheduleRevision(schedule),
    updatedAt: schedule.updatedAt || schedule.generatedAt || null,
  };
}

function getScheduleRoomStub(env, code) {
  if (!env?.SCHEDULE_ROOMS) {
    return null;
  }
  const id = env.SCHEDULE_ROOMS.idFromName(code);
  return env.SCHEDULE_ROOMS.get(id);
}

async function notifyScheduleRoom(env, code, event, data) {
  const room = getScheduleRoomStub(env, code);
  if (!room) {
    return false;
  }

  try {
    await room.fetch(
      new Request('https://schedule-room.local/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, data }),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function toBase64(text) {
  if (typeof btoa === 'function') return btoa(text);
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64');
  throw new Error('No base64 encoder available');
}

async function getJson(binding, key, fallback = null) {
  if (!binding?.get) return fallback;
  try {
    const value = await binding.get(key, { type: 'json' });
    return value === undefined || value === null ? fallback : value;
  } catch {
    const raw = await binding.get(key);
    if (raw === undefined || raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
}

async function putJson(binding, key, value, options) {
  if (!binding?.put) {
    throw new Error('SCHEDULES KV binding is missing');
  }
  await binding.put(key, JSON.stringify(value), options);
}

function scheduleKey(code) {
  return `${SCHEDULE_PREFIX}${code}`;
}

async function saveSchedule(env, schedule) {
  // Courtly sets SCHEDULE_TTL_SECONDS so public schedules self-expire after a
  // week. Trulioo does not set it, so its schedules are kept indefinitely.
  const ttl = Number(env.SCHEDULE_TTL_SECONDS) || 0;
  const options = ttl > 0 ? { expirationTtl: ttl } : undefined;
  await putJson(env.SCHEDULES, scheduleKey(schedule.code), schedule, options);
}

async function loadSchedule(env, code) {
  return getJson(env.SCHEDULES, scheduleKey(code), null);
}

async function saveCurrentSchedule(env, schedule) {
  // A single namespace-wide "current" pointer cannot be shared safely between
  // unrelated public groups -- whichever group last wrote it would leak into
  // every other group's ?scheduleCode=current link. Courtly users share
  // explicit ?scheduleCode=BADM-XXXX links instead, so skip this key entirely
  // in public mode. Trulioo sets no TTL, so it keeps writing this key as before.
  if (isPublicMode(env)) return;
  await putJson(env.SCHEDULES, CURRENT_SCHEDULE_KEY, schedule);
}

async function loadCurrentSchedule(env) {
  return getJson(env.SCHEDULES, CURRENT_SCHEDULE_KEY, null);
}

async function saveProfiles(env, profiles) {
  await putJson(env.SCHEDULES, PROFILES_KEY, profiles);
}

async function loadProfiles(env) {
  return getJson(env.SCHEDULES, PROFILES_KEY, { players: [] });
}

// Canonical join-key so "Ryan", " ryan ", "RYAN" all resolve to one identity
// across weeks, regardless of casing/whitespace differences between imports.
function normalizePlayerKey(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function loadPlayerRegistry(env) {
  return getJson(env.SCHEDULES, PLAYER_REGISTRY_KEY, {});
}

async function savePlayerRegistry(env, registry) {
  await putJson(env.SCHEDULES, PLAYER_REGISTRY_KEY, registry);
}

// Records/updates canonical display names so later aggregation (leaderboard)
// can match the same person across schedules even if casing/spacing drifts.
// The first-seen spelling of a name wins as the canonical display form.
async function registerPlayers(env, names, dateStr) {
  const registry = await loadPlayerRegistry(env);
  let changed = false;

  (names || []).forEach((name) => {
    const key = normalizePlayerKey(name);
    if (!key) return;
    if (!registry[key]) {
      registry[key] = { name, firstSeen: dateStr, lastSeen: dateStr };
      changed = true;
    } else if (registry[key].lastSeen !== dateStr) {
      registry[key].lastSeen = dateStr;
      changed = true;
    }
  });

  if (changed) await savePlayerRegistry(env, registry);
  return registry;
}

// Manual overrides for name variants normalizePlayerKey() cannot merge on its
// own (different name forms for the same person, e.g. "Ryan" vs "Ryan Xu",
// rather than just casing/whitespace drift). Maps a normalized key straight to
// the display name to use, so both variants converge on one leaderboard row
// regardless of which spelling a given week's import used.
async function loadPlayerAliases(env) {
  return getJson(env.SCHEDULES, PLAYER_ALIASES_KEY, {});
}

function canonicalPlayerName(registry, name, aliases = {}) {
  const key = normalizePlayerKey(name);
  if (aliases[key]) return aliases[key];
  return registry?.[key]?.name || name;
}

async function loadScheduleIndex(env) {
  return getJson(env.SCHEDULES, SCHEDULE_INDEX_KEY, []);
}

// Appends a lightweight pointer to every generated schedule so the
// leaderboard can walk history without scanning the whole KV namespace.
async function addToScheduleIndex(env, entry) {
  const index = await loadScheduleIndex(env);
  const deduped = index.filter((e) => e.code !== entry.code);
  deduped.push(entry);
  deduped.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  await putJson(env.SCHEDULES, SCHEDULE_INDEX_KEY, deduped);
}

async function createQrDataUrl(text) {
  const svg = await QRCode.toString(text, { type: 'svg' });
  return `data:image/svg+xml;base64,${toBase64(svg)}`;
}

async function handleGenerateSchedule(c) {
  const body = await c.req.json();
  const {
    numCourts,
    players,
    conflictGroup,
    layout,
    rounds,
    shareBaseUrl,
    isDemo,
    scheduleCode: requestedCode,
  } = body ?? {};

  if (!numCourts || !players || !Array.isArray(players)) {
    return c.json({ error: 'Invalid input' }, { status: 400 });
  }

  const playerNames = players
    .map((p) => (typeof p === 'string' ? p : p.name))
    .filter(Boolean);
  const computedLayout = layout || getLayout(playerNames.length, numCourts);

  if (!computedLayout) {
    return c.json({ error: 'Cannot create valid layout' }, { status: 400 });
  }

  // Reusing the code keeps one session to one record. Minting a new code on
  // every edit is what produced 46 schedules for a single Wednesday, and it
  // also silently stales any link already shared with the group.
  const validCode = typeof requestedCode === 'string' && /^BADM-[A-Z0-9]{4}$/.test(requestedCode);
  const candidate = validCode ? await loadSchedule(c.env, requestedCode) : null;
  // A demo-flag flip must not reuse: the code may already sit in schedules:index
  // from a real session, and the leaderboard never re-checks isDemo.
  const existing = candidate && !!candidate.isDemo === !!isDemo ? candidate : null;
  const scheduleCode = existing ? existing.code : generateScheduleCode();
  const roundData = Array.isArray(rounds)
    ? rounds
    : generateRounds(playerNames, computedLayout, conflictGroup || [], 15);
  const shareUrl = buildShareUrl(shareBaseUrl || c.req.header('origin'), scheduleCode);
  const qrDataUrl = await createQrDataUrl(shareUrl);

  const schedule = {
    code: scheduleCode,
    generatedAt: existing?.generatedAt || new Date().toISOString(),
    rounds: roundData,
    players: playerNames,
    numCourts,
    conflictGroup: Array.isArray(conflictGroup) ? conflictGroup : [],
    layout: computedLayout,
    shareUrl,
    isDemo: !!isDemo,
  };

  if (existing) {
    schedule.revision = getScheduleRevision(existing);
    if (existing.sharedAt) {
      schedule.sharedAt = existing.sharedAt;
      schedule.sharedBy = existing.sharedBy;
    }
  }

  touchSchedule(schedule);

  await saveSchedule(c.env, schedule);
  // Every freshly generated schedule becomes the "current" one immediately, so
  // the durable ?scheduleCode=current link always reflects the latest rotation
  // without requiring a separate explicit "share" click each week.
  await saveCurrentSchedule(c.env, schedule);
  if (existing) {
    // Only a reused code has a Durable Object room with viewers in it.
    await notifyScheduleRoom(c.env, scheduleCode, 'schedule-updated', scheduleStreamPayload(schedule));
  }
  return c.json({
    scheduleCode,
    shareUrl,
    qrDataUrl,
    schedule,
  });
}

async function handleShareSchedule(c) {
  const body = await c.req.json();
  const { scheduleCode, organizer, group } = body ?? {};

  if (!scheduleCode || !organizer) {
    return c.json({ error: 'Missing scheduleCode or organizer' }, { status: 400 });
  }

  const schedule = await loadSchedule(c.env, scheduleCode);
  if (!schedule) {
    return c.json({ error: 'Schedule not found' }, { status: 404 });
  }

  const sharedAt = new Date().toISOString();
  schedule.sharedAt = sharedAt;
  schedule.sharedBy = organizer;
  touchSchedule(schedule);

  await saveSchedule(c.env, schedule);
  await saveCurrentSchedule(c.env, schedule);
  // A real session is always shared with the group; a smoke test never is.
  // Indexing here — rather than on every generate — is what keeps one session
  // to one leaderboard record. Because the code is now reused across edits
  // (see handleGenerateSchedule), this entry keeps pointing at the final roster.
  if (!schedule.isDemo) {
    const sessionDate = pacificDateStr(new Date(schedule.generatedAt));
    // The player registry is namespace-global with no TTL (see handleProfiles);
    // writing to it in public mode would leak one group's names into every
    // other group's leaderboard, permanently. Skip it in public mode --
    // leaderboard stats still work from the schedules themselves, falling
    // back to the raw name via canonicalPlayerName when the registry has none.
    if (!isPublicMode(c.env)) {
      await registerPlayers(c.env, schedule.players || [], sessionDate);
    }
    // addToScheduleIndex dedupes by replacing, so a re-share would otherwise
    // overwrite an entry's original provenance. Preserve whatever source it had.
    const priorIndex = await loadScheduleIndex(c.env);
    const priorSource = priorIndex.find((e) => e.code === schedule.code)?.source;
    const indexEntry = {
      code: schedule.code,
      date: sessionDate,
      playerCount: (schedule.players || []).length,
      source: priorSource || 'manual',
    };
    // Only public (Courtly) clients send a group. Omitting the key entirely
    // keeps Trulioo's entries exactly as they were.
    if (typeof group === 'string' && group) indexEntry.group = group;
    await addToScheduleIndex(c.env, indexEntry);
  }
  await notifyScheduleRoom(c.env, scheduleCode, 'schedule-shared', scheduleStreamPayload(schedule));

  return c.json({ ok: true, sharedAt, sharedBy: organizer, schedule });
}

async function handleGetSchedule(c) {
  const code = c.req.param('code');
  // "current" is a stable pseudo-code (not a real schedule code) that always
  // resolves to whichever schedule is presently active — used for a durable
  // share link (?scheduleCode=current) that auto-updates week to week. In
  // public mode saveCurrentSchedule never writes this key (see above), so
  // resolving it would only ever return stale or cross-group data; 404 instead.
  if (code === 'current' && isPublicMode(c.env)) {
    return c.json({ error: 'Not found' }, { status: 404 });
  }
  const schedule = code === 'current' ? await loadCurrentSchedule(c.env) : await loadSchedule(c.env, code);

  if (!schedule) {
    return c.json({ error: 'Schedule not found' }, { status: 404 });
  }

  return c.json({ schedule });
}

async function handleScheduleStream(c) {
  const code = c.req.param('code');
  if (code === 'current') {
    // "current" has no single Durable Object room (the underlying schedule
    // code changes week to week); clients polling /api/schedule/current
    // handle picking up changes instead of subscribing to a live stream.
    return c.json({ error: 'Live stream is not available for the current pseudo-code' }, { status: 400 });
  }
  const schedule = await loadSchedule(c.env, code);

  if (!schedule) {
    return c.json({ error: 'Schedule not found' }, { status: 404 });
  }

  const room = getScheduleRoomStub(c.env, code);
  if (!room) {
    return c.json({ error: 'Schedule room binding is missing' }, { status: 503 });
  }

  return room.fetch(c.req.raw);
}

async function handleExtendSchedule(c) {
  const code = c.req.param('code');
  const body = await c.req.json();
  const { count = 5, baseRoundCount } = body ?? {};

  const schedule = await loadSchedule(c.env, code);
  if (!schedule) {
    return c.json({ error: 'Schedule not found' }, { status: 404 });
  }

  const existingRounds = Array.isArray(schedule.rounds) ? schedule.rounds : [];
  const currentRoundCount = existingRounds.length;
  const requestedBaseRoundCount = Number(baseRoundCount);
  if (!Number.isInteger(requestedBaseRoundCount) || requestedBaseRoundCount !== currentRoundCount) {
    return c.json({ schedule, extended: false });
  }

  const sitC = Object.fromEntries((schedule.players || []).map((p) => [p, 0]));
  const history = createPairHistory();
  existingRounds.forEach((rnd) => {
    (rnd.subs || []).forEach((p) => {
      if (p in sitC) sitC[p]++;
    });
    recordRound(history, rnd.courts);
  });

  const newRounds = generateRounds(
    schedule.players || [],
    schedule.layout,
    schedule.conflictGroup || [],
    count,
    sitC,
    history,
  );

  schedule.rounds = [...existingRounds, ...newRounds];
  touchSchedule(schedule);
  await saveSchedule(c.env, schedule);

  const currentSchedule = await loadCurrentSchedule(c.env);
  if (currentSchedule?.code === schedule.code) {
    await saveCurrentSchedule(c.env, schedule);
  }

  await notifyScheduleRoom(c.env, code, 'schedule-updated', scheduleStreamPayload(schedule));

  return c.json({ schedule, extended: true });
}

async function handleProfiles(c) {
  const body = await c.req.json();
  const { players } = body ?? {};

  if (!Array.isArray(players)) {
    return c.json({ error: 'Players must be an array' }, { status: 400 });
  }

  // Profiles are a namespace-global key with no TTL; writing them in public
  // mode would leak one group's roster to every other group, permanently.
  // The SPA calls this opportunistically, so no-op rather than error.
  if (isPublicMode(c.env)) {
    return c.json({ ok: true, skipped: true });
  }

  const profiles = {
    players,
  };

  await saveProfiles(c.env, profiles);
  return c.json({ ok: true });
}

// When several registry keys alias to the same canonical name (e.g. "ryan"
// and "ryan xu"), firstSeen/lastSeen must span all of them, not just whichever
// key happens to match the canonical name's own normalized form.
function computeCanonicalSeenDates(registry, aliases) {
  const result = {};
  Object.entries(registry).forEach(([key, info]) => {
    const canonName = aliases[key] || info.name;
    const cur = result[canonName];
    if (!cur) {
      result[canonName] = { firstSeen: info.firstSeen, lastSeen: info.lastSeen };
    } else {
      if (info.firstSeen && (!cur.firstSeen || info.firstSeen < cur.firstSeen)) cur.firstSeen = info.firstSeen;
      if (info.lastSeen && (!cur.lastSeen || info.lastSeen > cur.lastSeen)) cur.lastSeen = info.lastSeen;
    }
  });
  return result;
}

// Pure so it can be unit-tested without KV. `canon` maps a raw roster name to
// its canonical spelling; the caller owns the registry and alias lookups.
function aggregateSessions(sessions, canon) {
  const stats = {};
  const ensure = (name) => {
    if (!stats[name]) {
      stats[name] = { name, games: 0, sits: 0, sessions: 0, partners: {}, opponents: {}, dates: [] };
    }
    return stats[name];
  };

  for (const { date, schedule } of sessions) {
    if (!schedule || !Array.isArray(schedule.rounds)) continue;
    const seenThisSession = new Set();

    schedule.rounds.forEach((rnd) => {
      (rnd.subs || []).forEach((p) => {
        const name = canon(p);
        ensure(name).sits += 1;
        seenThisSession.add(name);
      });
      (rnd.courts || []).forEach((ct) => {
        [ct.a, ct.b].forEach((team, idx) => {
          const otherTeam = idx === 0 ? ct.b : ct.a;
          (team || []).forEach((p) => {
            const name = canon(p);
            const entry = ensure(name);
            entry.games += 1;
            seenThisSession.add(name);
            team.filter((q) => q !== p).forEach((q) => {
              const k = canon(q);
              entry.partners[k] = (entry.partners[k] || 0) + 1;
            });
            (otherTeam || []).forEach((q) => {
              const k = canon(q);
              entry.opponents[k] = (entry.opponents[k] || 0) + 1;
            });
          });
        });
      });
    });

    seenThisSession.forEach((name) => {
      const entry = ensure(name);
      entry.sessions += 1;
      if (date) entry.dates.push(date);
    });
  }

  return stats;
}

async function handleLeaderboard(c) {
  const registry = await loadPlayerRegistry(c.env);
  const aliases = await loadPlayerAliases(c.env);
  const seenDates = computeCanonicalSeenDates(registry, aliases);
  const index = filterIndexByGroup(
    filterIndexByAge(await loadScheduleIndex(c.env), c.env.SCHEDULE_TTL_SECONDS, Date.now()),
    c.req.query('group'),
  );

  const canon = (name) => canonicalPlayerName(registry, name, aliases);
  const sessions = [];
  for (const entry of index) {
    const schedule = await loadSchedule(c.env, entry.code);
    if (schedule) sessions.push({ date: entry.date, schedule });
  }
  const stats = aggregateSessions(sessions, canon);

  const leaderboard = Object.values(stats)
    .map((s) => ({
      name: s.name,
      sessions: s.sessions,
      games: s.games,
      sits: s.sits,
      uniquePartners: Object.keys(s.partners).length,
      uniqueOpponents: Object.keys(s.opponents).length,
      firstSeen: seenDates[s.name]?.firstSeen || null,
      lastSeen: seenDates[s.name]?.lastSeen || null,
    }))
    .sort((a, b) => b.games - a.games || b.sessions - a.sessions);

  return c.json({ leaderboard, sessionCount: index.length });
}

// Scopes the schedule index to one group. A falsy group means "ungrouped only",
// which is what keeps the single-tenant Trulioo deployment behaving exactly as
// before: its entries carry no group field and its client sends no group param.
function filterIndexByGroup(index, group) {
  if (!group) return index.filter((e) => !e.group);
  return index.filter((e) => e.group === group);
}

// Index entries outlive the schedules they point at once SCHEDULE_TTL_SECONDS
// is set, so drop entries older than that window at read time. Trulioo sets no
// TTL, so nothing is ever dropped there.
function filterIndexByAge(index, ttlSeconds, now) {
  const ttl = Number(ttlSeconds) || 0;
  if (ttl <= 0) return index;
  const cutoffMs = now - ttl * 1000;
  return index.filter((e) => {
    const t = Date.parse(`${e.date}T23:59:59Z`);
    return Number.isNaN(t) ? true : t >= cutoffMs;
  });
}

// Reads only the index key — no schedule loads — so this stays fast regardless
// of how much history accumulates.
async function handleSessions(c) {
  const index = filterIndexByGroup(
    filterIndexByAge(await loadScheduleIndex(c.env), c.env.SCHEDULE_TTL_SECONDS, Date.now()),
    c.req.query('group'),
  );
  const sessions = [...index].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return c.json({ sessions });
}

async function handleData(c) {
  const publicMode = isPublicMode(c.env);
  // profiles.players is a namespace-global registry; never return it in
  // public mode, or one group's names would leak into every other group's.
  const profiles = publicMode ? { players: [] } : await loadProfiles(c.env);
  // player-countries.json is imported at the top of this file, so it is BUNDLED
  // into every deployment of this source regardless of which KV namespace is
  // bound. It maps real people's names to their nationalities and must never be
  // served from the public product.
  const countries = publicMode ? {} : playerCountryLookup;
  return c.json({
    currentSchedule: await loadCurrentSchedule(c.env),
    players: profiles.players || [],
    showCountryLabel: getShowCountryLabelFlag(c.env),
    playerCountryLookup: countries,
    countryLookup: countries,
  });
}

class ScheduleRoom {
  constructor(state) {
    this.state = state;
    this.encoder = new TextEncoder();
    this.connections = new Set();
    this.heartbeat = null;
  }

  async fetch(request) {
    if (request.method === 'GET') {
      return this.handleStream();
    }

    if (request.method === 'POST') {
      return this.handlePublish(request);
    }

    return new Response('Method Not Allowed', { status: 405 });
  }

  handleStream() {
    const connection = { controller: null };

    const cleanup = () => {
      if (!connection.controller) {
        return;
      }

      this.connections.delete(connection);
      connection.controller = null;

      if (!this.connections.size && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    };

    const stream = new ReadableStream({
      start: (controller) => {
        connection.controller = controller;
        this.connections.add(connection);

        if (!this.heartbeat) {
          this.heartbeat = setInterval(() => {
            this.broadcastRaw(': ping\n\n');
          }, SSE_PING_MS);
        }

        controller.enqueue(this.encoder.encode(': connected\n\n'));
      },
      cancel: cleanup,
    });

    return new Response(stream, { headers: createSseHeaders() });
  }

  async handlePublish(request) {
    const body = await request.json();
    const event = body?.event || 'schedule-updated';
    const data = body?.data ?? null;
    const message = formatSseMessage({
      event,
      data,
      id: data && data.revision,
    });

    this.broadcastRaw(message);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  broadcastRaw(message) {
    for (const connection of [...this.connections]) {
      try {
        connection.controller.enqueue(this.encoder.encode(message));
      } catch {
        this.removeConnection(connection);
      }
    }
  }

  removeConnection(connection) {
    this.connections.delete(connection);
    if (!this.connections.size && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}

// Builds a session-day window in Pacific time, expressed with the correct
// UTC offset for that date (handles PST/PDT without manual toggling).
// Pass `dateOverride` (YYYY-MM-DD) to build the window for a specific day
// (e.g. testing an upcoming Wednesday) instead of "today".
function pacificDateStr(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

async function handlePlayer(c) {
  const requested = c.req.param('name') || '';
  if (!requested) return c.json({ error: 'Missing player name' }, { status: 400 });

  const registry = await loadPlayerRegistry(c.env);
  const aliases = await loadPlayerAliases(c.env);
  const canon = (name) => canonicalPlayerName(registry, name, aliases);
  const target = canon(requested);

  const index = filterIndexByGroup(
    filterIndexByAge(await loadScheduleIndex(c.env), c.env.SCHEDULE_TTL_SECONDS, Date.now()),
    c.req.query('group'),
  );
  const sessions = [];
  for (const entry of index) {
    const schedule = await loadSchedule(c.env, entry.code);
    if (schedule) sessions.push({ date: entry.date, schedule });
  }

  const stats = aggregateSessions(sessions, canon);
  const me = stats[target];
  if (!me) return c.json({ error: 'Player not found' }, { status: 404 });

  const rank = (counts) => Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));

  // The point of the feature: variety is what this app optimizes for, so show
  // who it has not yet paired you with.
  const neverPartnered = Object.keys(stats)
    .filter((n) => n !== target && !me.partners[n])
    .sort();

  return c.json({
    player: {
      name: me.name,
      sessions: me.sessions,
      games: me.games,
      sits: me.sits,
      partners: rank(me.partners),
      opponents: rank(me.opponents),
      neverPartnered,
      dates: [...me.dates].sort().reverse(),
    },
  });
}

// --- Watch view --------------------------------------------------------------
// Apple Watch has no Safari; its hidden WebKit view runs scripts unreliably and
// the main SPA builds its whole UI in JS, so it cannot be used there. These
// routes render finished markup/text on the server instead: no JS, no fetch, no
// framework. Round state lives in the URL so prev/next are plain links, and
// ?fmt=txt returns the same data as text for the watch Shortcuts app, which can
// display a URL's contents without a browser at all.

const WATCH_CODE_RE = /^BADM-[A-Z0-9]{4}$/;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function watchNameKey(name) {
  return String(name || '').trim().toLowerCase();
}

// Where one player sits in a round: which court, who with, who against.
function findPlayerInRound(round, key) {
  const courts = Array.isArray(round && round.courts) ? round.courts : [];
  for (let i = 0; i < courts.length; i += 1) {
    const court = courts[i] || {};
    for (const [side, other] of [['a', 'b'], ['b', 'a']]) {
      const team = Array.isArray(court[side]) ? court[side] : [];
      if (team.some((n) => watchNameKey(n) === key)) {
        return {
          court: i + 1,
          partners: team.filter((n) => watchNameKey(n) !== key),
          opponents: Array.isArray(court[other]) ? court[other] : [],
        };
      }
    }
  }
  return null;
}

// One line per round for a single player -- the whole night at a glance, which
// is what a watch is actually good for. Needs no notion of "current round".
function watchPlayerRows(schedule, name) {
  const key = watchNameKey(name);
  const rounds = Array.isArray(schedule.rounds) ? schedule.rounds : [];
  return rounds.map((round, i) => {
    const spot = findPlayerInRound(round, key);
    if (!spot) return { round: i + 1, playing: false, detail: 'sitting out' };
    const partner = spot.partners.length ? `with ${spot.partners.join(' + ')}` : 'singles';
    const versus = spot.opponents.length ? ` vs ${spot.opponents.join(' + ')}` : '';
    return { round: i + 1, playing: true, court: spot.court, detail: `${partner}${versus}` };
  });
}

function watchRoundRows(round) {
  const courts = Array.isArray(round && round.courts) ? round.courts : [];
  return courts.map((court, i) => ({
    court: i + 1,
    a: (Array.isArray(court.a) ? court.a : []).join(' + '),
    b: (Array.isArray(court.b) ? court.b : []).join(' + '),
  }));
}

function clampRound(raw, total) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n > total ? total : n;
}

function watchPlayerText(schedule, player) {
  const rows = watchPlayerRows(schedule, player);
  const played = rows.filter((r) => r.playing).length;
  const head = `${player} — ${schedule.code}\n${played}/${rows.length} rounds playing`;
  const body = rows
    .map((r) => (r.playing ? `${r.round}. Court ${r.court} — ${r.detail}` : `${r.round}. sitting out`))
    .join('\n');
  return `${head}\n\n${body}\n`;
}

// Plain text has no prev/next links, so a nameless text request would otherwise
// be stuck on one round. This returns the whole night's courts, which is what
// makes a watch Shortcut work without naming anyone.
function watchAllRoundsText(schedule) {
  const rounds = Array.isArray(schedule.rounds) ? schedule.rounds : [];
  const body = rounds.map((round, i) => {
    const courts = watchRoundRows(round)
      .map((r) => `  C${r.court}  ${r.a} v ${r.b}`)
      .join('\n');
    const subs = Array.isArray(round.subs) ? round.subs : [];
    const sitting = subs.length ? `\n  sit: ${subs.join(', ')}` : '';
    return `R${i + 1}\n${courts}${sitting}`;
  }).join('\n\n');
  return `${schedule.code} — ${rounds.length} rounds\n\n${body}\n`;
}

function watchRoundText(schedule, roundNo) {
  const round = schedule.rounds[roundNo - 1];
  const rows = watchRoundRows(round);
  const subs = Array.isArray(round.subs) ? round.subs : [];
  const body = rows.map((r) => `Court ${r.court}: ${r.a} vs ${r.b}`).join('\n');
  const sitting = subs.length ? `\nSitting out: ${subs.join(', ')}` : '';
  return `${schedule.code} — round ${roundNo}/${schedule.rounds.length}\n\n${body}${sitting}\n`;
}

// Sized for a ~184px watch screen: one column, large type, dark ground (OLED),
// and tap targets big enough for a fingertip.
function watchPage(title, inner) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;color:#fff;font:16px/1.35 -apple-system,system-ui,sans-serif;padding:10px 9px 22px}
h1{font-size:15px;font-weight:600;color:#F0A81E;letter-spacing:.02em}
.sub{font-size:12px;color:#8b949e;margin-bottom:10px}
ol{list-style:none}
li{border-top:1px solid #23262b;padding:8px 0}
li:first-child{border-top:0}
.n{font-size:12px;color:#8b949e}
.court{font-size:12px;color:#F0A81E;font-weight:600}
.who{font-size:16px;font-weight:600;word-wrap:break-word}
.vs{font-size:12px;color:#8b949e;margin:1px 0}
.sit{color:#8b949e;font-size:14px}
nav{display:flex;gap:8px;margin-top:14px}
nav a,.alt{flex:1;display:block;text-align:center;padding:11px 6px;background:#1b1f23;color:#fff;
  border-radius:9px;text-decoration:none;font-size:14px;font-weight:600}
nav a.off{color:#4b5158}
.alt{margin-top:8px;background:#23262b}
</style></head><body>${inner}</body></html>`;
}

async function handleWatchView(c) {
  const raw = String(c.req.param('code') || '').toUpperCase();
  // "current" lets a watch Shortcut be set up once and keep working every week
  // instead of being re-edited whenever a new rotation is generated. It follows
  // handleGetSchedule's rule exactly: in public mode saveCurrentSchedule never
  // writes the key, so resolving it would only return another group's data.
  const isCurrent = raw === 'CURRENT';
  if (isCurrent && isPublicMode(c.env)) return c.text('Schedule not found\n', { status: 404 });
  if (!isCurrent && !WATCH_CODE_RE.test(raw)) return c.text('Bad schedule code\n', { status: 400 });

  const schedule = isCurrent ? await loadCurrentSchedule(c.env) : await loadSchedule(c.env, raw);
  if (!schedule || !Array.isArray(schedule.rounds) || !schedule.rounds.length) {
    return c.text('Schedule not found\n', { status: 404 });
  }
  // Links must keep the pseudo-code so prev/next stay set-and-forget, but the
  // page shows the real code it resolved to.
  const code = isCurrent ? 'current' : raw;
  const displayCode = schedule.code || raw;

  const player = (c.req.query('p') || '').trim();
  const asText = c.req.query('fmt') === 'txt';
  const total = schedule.rounds.length;

  // A named player gets their whole night; otherwise show one round at a time.
  const playerIsOnRoster = player
    && (schedule.players || []).some((n) => watchNameKey(n) === watchNameKey(player));

  if (asText) {
    let body;
    if (playerIsOnRoster) body = watchPlayerText(schedule, player);
    else if (c.req.query('r')) body = watchRoundText(schedule, clampRound(c.req.query('r'), total));
    else body = watchAllRoundsText(schedule);
    return c.text(body);
  }

  const qp = (extra) => {
    const parts = [];
    if (player) parts.push(`p=${encodeURIComponent(player)}`);
    if (extra) parts.push(extra);
    return parts.length ? `?${parts.join('&')}` : '';
  };

  let inner;
  if (playerIsOnRoster) {
    const rows = watchPlayerRows(schedule, player);
    const played = rows.filter((r) => r.playing).length;
    inner = `<h1>${escapeHtml(player)}</h1>`
      + `<div class="sub">${played} of ${total} rounds · ${escapeHtml(displayCode)}</div><ol>`
      + rows.map((r) => (r.playing
        ? `<li><span class="n">${r.round}</span> <span class="court">Court ${r.court}</span>`
          + `<div class="who">${escapeHtml(r.detail)}</div></li>`
        : `<li><span class="n">${r.round}</span> <span class="sit">sitting out</span></li>`)).join('')
      + `</ol><a class="alt" href="/w/${encodeURIComponent(code)}">All courts</a>`;
  } else {
    const roundNo = clampRound(c.req.query('r'), total);
    const round = schedule.rounds[roundNo - 1];
    const subs = Array.isArray(round.subs) ? round.subs : [];
    const prev = roundNo > 1
      ? `<a href="/w/${encodeURIComponent(code)}${qp(`r=${roundNo - 1}`)}">‹ Prev</a>`
      : '<a class="off">‹ Prev</a>';
    const next = roundNo < total
      ? `<a href="/w/${encodeURIComponent(code)}${qp(`r=${roundNo + 1}`)}">Next ›</a>`
      : '<a class="off">Next ›</a>';
    inner = `<h1>Round ${roundNo} / ${total}</h1>`
      + `<div class="sub">${escapeHtml(displayCode)}</div><ol>`
      + watchRoundRows(round).map((r) => `<li><span class="court">Court ${r.court}</span>`
        + `<div class="who">${escapeHtml(r.a)}</div>`
        + `<div class="vs">vs</div>`
        + `<div class="who">${escapeHtml(r.b)}</div></li>`).join('')
      + (subs.length ? `<li><span class="n">Sitting out</span><div class="sit">${escapeHtml(subs.join(', '))}</div></li>` : '')
      + `</ol><nav>${prev}${next}</nav>`;
  }

  return new Response(watchPage(`${displayCode} · watch`, inner), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function createWorkerApp() {
  const app = new Hono();
  app.use('*', cors());
  app.get('/health', (c) => c.json(healthPayload()));
  app.get('/api/health', (c) => c.json(healthPayload()));
  app.post('/api/schedule', handleGenerateSchedule);
  app.get('/api/schedule/:code', handleGetSchedule);
  app.get('/api/schedule/:code/stream', handleScheduleStream);
  app.post('/api/schedule/:code/extend', handleExtendSchedule);
  app.post('/api/schedule/share', handleShareSchedule);
  app.post('/api/profiles', handleProfiles);
  app.get('/api/data', handleData);
  app.get('/api/leaderboard', handleLeaderboard);
  app.get('/api/sessions', handleSessions);
  app.get('/api/player/:name', handlePlayer);
  app.get('/w/:code', handleWatchView);
  return app;
}

export {
  addToScheduleIndex,
  buildRoundCourts,
  buildShareUrl,
  canonicalPlayerName,
  conflictPair,
  createQrDataUrl,
  createWorkerApp,
  generateRounds,
  generateScheduleCode,
  getLayout,
  greedyMatch,
  handleData,
  handleExtendSchedule,
  handleGenerateSchedule,
  handleGetSchedule,
  handleLeaderboard,
  handlePlayer,
  handleProfiles,
  handleSessions,
  handleShareSchedule,
  handleScheduleStream,
  healthPayload,
  loadPlayerAliases,
  loadPlayerRegistry,
  loadScheduleIndex,
  matchPartnersRespectingConflicts,
  matchPath,
  normalizePath,
  normalizePlayerKey,
  registerPlayers,
  savePlayerRegistry,
  shuffle,
  ScheduleRoom,
  teamKey,
  teamOk,
};

const workerApp = createWorkerApp();

export default {
  fetch: (request, env, ctx) => workerApp.fetch(request, env, ctx),
};
