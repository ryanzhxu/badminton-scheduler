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
const MAKE_TEAMS_ATTEMPTS = 600;

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

function repeatCost(hist, ct) {
  const { partners, opponents } = courtPairs(ct);
  let cost = 0;
  partners.forEach((k) => {
    const n = hist.partners.get(k) || 0;
    cost += n * n * REPEAT_PARTNER_WEIGHT;
  });
  opponents.forEach((k) => {
    const n = hist.opponents.get(k) || 0;
    cost += n * n * REPEAT_OPPONENT_WEIGHT;
    if (hist.lastOpponents.has(k)) cost += CONSECUTIVE_OPPONENT_WEIGHT;
  });
  return cost;
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

function assignCourts(pl, layout) {
  const courts = [];
  let idx = 0;
  for (let c = 0; c < layout.doubles; c++) {
    courts.push({
      a: [pl[idx], pl[idx + 1]],
      b: [pl[idx + 2], pl[idx + 3]],
      singles: false,
    });
    idx += 4;
  }
  for (let c = 0; c < layout.singles; c++) {
    courts.push({
      a: [pl[idx]],
      b: [pl[idx + 1]],
      singles: true,
    });
    idx += 2;
  }
  return courts;
}

function makeTeams(activePl, layout, hist, conflictGroup) {
  let best = null;
  let bestScore = Infinity;
  for (let att = 0; att < MAKE_TEAMS_ATTEMPTS; att++) {
    const s = shuffle(activePl);
    const courts = assignCourts(s, layout);
    let cv = 0;
    let pv = 0;
    courts.forEach((ct) => {
      if (!teamOk(ct.a, conflictGroup)) cv++;
      if (!teamOk(ct.b, conflictGroup)) cv++;
      pv += repeatCost(hist, ct);
    });
    const score = cv * 1000 + pv;
    if (score < bestScore) {
      bestScore = score;
      best = courts;
      if (!score) break;
    }
  }
  return best;
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
    const courts = makeTeams(activePl, layout, history, conflictGroup);
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

async function putJson(binding, key, value) {
  if (!binding?.put) {
    throw new Error('SCHEDULES KV binding is missing');
  }
  await binding.put(key, JSON.stringify(value));
}

function scheduleKey(code) {
  return `${SCHEDULE_PREFIX}${code}`;
}

async function saveSchedule(env, schedule) {
  await putJson(env.SCHEDULES, scheduleKey(schedule.code), schedule);
}

async function loadSchedule(env, code) {
  return getJson(env.SCHEDULES, scheduleKey(code), null);
}

async function saveCurrentSchedule(env, schedule) {
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

  const scheduleCode = generateScheduleCode();
  const roundData = Array.isArray(rounds)
    ? rounds
    : generateRounds(playerNames, computedLayout, conflictGroup || [], 10);
  const shareUrl = buildShareUrl(shareBaseUrl || c.req.header('origin'), scheduleCode);
  const qrDataUrl = await createQrDataUrl(shareUrl);

  const schedule = {
    code: scheduleCode,
    generatedAt: new Date().toISOString(),
    rounds: roundData,
    players: playerNames,
    numCourts,
    conflictGroup: Array.isArray(conflictGroup) ? conflictGroup : [],
    layout: computedLayout,
    shareUrl,
  };

  touchSchedule(schedule);

  await saveSchedule(c.env, schedule);
  // Every freshly generated schedule becomes the "current" one immediately, so
  // the durable ?scheduleCode=current link always reflects the latest rotation
  // without requiring a separate explicit "share" click each week.
  await saveCurrentSchedule(c.env, schedule);
  const genDateStr = schedule.generatedAt.slice(0, 10);
  await registerPlayers(c.env, playerNames, genDateStr);
  await addToScheduleIndex(c.env, {
    code: scheduleCode,
    date: genDateStr,
    playerCount: playerNames.length,
    source: 'manual',
  });

  return c.json({
    scheduleCode,
    shareUrl,
    qrDataUrl,
    schedule,
  });
}

async function handleShareSchedule(c) {
  const body = await c.req.json();
  const { scheduleCode, organizer } = body ?? {};

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
  await notifyScheduleRoom(c.env, scheduleCode, 'schedule-shared', scheduleStreamPayload(schedule));

  return c.json({ ok: true, sharedAt, sharedBy: organizer, schedule });
}

async function handleGetSchedule(c) {
  const code = c.req.param('code');
  // "current" is a stable pseudo-code (not a real schedule code) that always
  // resolves to whichever schedule is presently active — used for a durable
  // share link (?scheduleCode=current) that auto-updates week to week.
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

async function handleLeaderboard(c) {
  const registry = await loadPlayerRegistry(c.env);
  const aliases = await loadPlayerAliases(c.env);
  const seenDates = computeCanonicalSeenDates(registry, aliases);
  const index = await loadScheduleIndex(c.env);
  const stats = {};

  const ensure = (name) => {
    if (!stats[name]) {
      stats[name] = {
        name,
        games: 0,
        sits: 0,
        sessions: 0,
        partners: new Set(),
        opponents: new Set(),
        firstSeen: seenDates[name]?.firstSeen || null,
        lastSeen: seenDates[name]?.lastSeen || null,
      };
    }
    return stats[name];
  };

  for (const entry of index) {
    const schedule = await loadSchedule(c.env, entry.code);
    if (!schedule || !Array.isArray(schedule.rounds)) continue;

    const seenThisSession = new Set();
    schedule.rounds.forEach((rnd) => {
      (rnd.subs || []).forEach((p) => {
        const canon = canonicalPlayerName(registry, p, aliases);
        ensure(canon).sits += 1;
        seenThisSession.add(canon);
      });
      (rnd.courts || []).forEach((ct) => {
        [ct.a, ct.b].forEach((team, idx) => {
          const otherTeam = idx === 0 ? ct.b : ct.a;
          team.forEach((p) => {
            const canon = canonicalPlayerName(registry, p, aliases);
            const entryStats = ensure(canon);
            entryStats.games += 1;
            seenThisSession.add(canon);
            team
              .filter((q) => q !== p)
              .forEach((q) => entryStats.partners.add(canonicalPlayerName(registry, q, aliases)));
            otherTeam.forEach((q) => entryStats.opponents.add(canonicalPlayerName(registry, q, aliases)));
          });
        });
      });
    });
    seenThisSession.forEach((name) => {
      ensure(name).sessions += 1;
    });
  }

  const leaderboard = Object.values(stats)
    .map((s) => ({
      name: s.name,
      sessions: s.sessions,
      games: s.games,
      sits: s.sits,
      uniquePartners: s.partners.size,
      uniqueOpponents: s.opponents.size,
      firstSeen: s.firstSeen,
      lastSeen: s.lastSeen,
    }))
    .sort((a, b) => b.games - a.games || b.sessions - a.sessions);

  return c.json({ leaderboard, sessionCount: index.length });
}

async function handleData(c) {
  const profiles = await loadProfiles(c.env);
  return c.json({
    currentSchedule: await loadCurrentSchedule(c.env),
    players: profiles.players || [],
    showCountryLabel: getShowCountryLabelFlag(c.env),
    playerCountryLookup,
    countryLookup: playerCountryLookup,
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

const CAL_API_BASE = 'https://api.cal.com/v2';
const CAL_EVENT_TYPE_ID_KEY = 'cal:event_type_id';
const CAL_LAST_PULL_KEY = 'cal:last_pull_date';
const AUTO_IMPORT_NUM_COURTS = 3;
const AUTO_IMPORT_ROUND_COUNT = 10;
const PROD_SHARE_BASE_URL = 'https://trulioo-badminton.onrender.com';

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || '');
}

function parseAttendeeName(raw) {
  let s = (raw || '').trim();
  if (!s) return null;
  if (isEmail(s)) {
    s = s.split('@')[0].replace(/[._-]+/g, ' ');
  }
  s = s.replace(/\s*[-\u2013]\s*(organizer|admin|host|co-host|guest|player|lead|manager|owner)\s*$/i, '').trim();
  if (!s) return null;
  return s.split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// Builds a session-day window in Pacific time, expressed with the correct
// UTC offset for that date (handles PST/PDT without manual toggling).
// Pass `dateOverride` (YYYY-MM-DD) to build the window for a specific day
// (e.g. testing an upcoming Wednesday) instead of "today".
function pacificDateWindow(dateOverride) {
  const referenceDate = dateOverride ? new Date(`${dateOverride}T12:00:00Z`) : new Date();
  const dateStr = dateOverride || new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(referenceDate);

  const offsetParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'shortOffset',
  }).formatToParts(referenceDate);
  const tzName = offsetParts.find((p) => p.type === 'timeZoneName')?.value || 'GMT-8';
  const match = tzName.match(/GMT([+-]\d+)(?::?(\d{2}))?/);
  const offsetHours = match ? parseInt(match[1], 10) : -8;
  const offsetMinutes = match && match[2] ? parseInt(match[2], 10) : 0;
  const sign = offsetHours < 0 ? '-' : '+';
  const offset = `${sign}${String(Math.abs(offsetHours)).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;

  return {
    dateStr,
    afterStart: `${dateStr}T00:00:00${offset}`,
    beforeEnd: `${dateStr}T23:59:59${offset}`,
  };
}

async function calFetch(env, path, { params = {}, apiVersion } = {}) {
  if (!env.CAL_API_KEY) {
    throw new Error('CAL_API_KEY secret is not configured');
  }
  const url = new URL(`${CAL_API_BASE}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  const headers = { Authorization: `Bearer ${env.CAL_API_KEY}` };
  if (apiVersion) headers['cal-api-version'] = apiVersion;

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`cal.com API error ${res.status} for ${path}: ${body}`);
  }
  return res.json();
}

async function resolveCalEventTypeId(env) {
  const cached = await getJson(env.SCHEDULES, CAL_EVENT_TYPE_ID_KEY, null);
  if (cached?.id && cached.slug === env.CAL_EVENT_SLUG) return cached.id;

  if (!env.CAL_USERNAME || !env.CAL_EVENT_SLUG) {
    throw new Error('CAL_USERNAME/CAL_EVENT_SLUG vars are not configured');
  }

  const data = await calFetch(env, '/event-types', {
    params: { username: env.CAL_USERNAME, eventSlug: env.CAL_EVENT_SLUG },
    apiVersion: '2024-06-14',
  });

  const eventType = Array.isArray(data?.data) ? data.data[0] : data?.data;
  if (!eventType?.id) {
    throw new Error(`Could not resolve cal.com event type for ${env.CAL_USERNAME}/${env.CAL_EVENT_SLUG}`);
  }

  await putJson(env.SCHEDULES, CAL_EVENT_TYPE_ID_KEY, { id: eventType.id, slug: env.CAL_EVENT_SLUG });
  return eventType.id;
}

async function fetchCalAttendeeNames(env, eventTypeId, window) {
  const names = [];
  let skip = 0;
  const take = 100;

  for (;;) {
    const data = await calFetch(env, '/bookings', {
      params: {
        eventTypeId,
        status: 'upcoming',
        afterStart: window.afterStart,
        beforeEnd: window.beforeEnd,
        take,
        skip,
      },
      apiVersion: '2024-08-13',
    });

    const bookings = Array.isArray(data?.data) ? data.data : [];
    bookings.forEach((booking) => {
      (booking.attendees || []).forEach((attendee) => {
        const parsed = parseAttendeeName(attendee?.name || attendee?.email);
        if (parsed) names.push(parsed);
      });
    });

    if (bookings.length < take || !data?.pagination?.hasNextPage) break;
    skip += take;
  }

  const seen = new Set();
  return names.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function runCalAutoImport(env, options = {}) {
  const { dateOverride, dryRun = false } = options;
  const now = new Date();
  const window = pacificDateWindow(dateOverride);

  if (!dryRun) {
    const lastPull = await getJson(env.SCHEDULES, CAL_LAST_PULL_KEY, null);
    if (lastPull === window.dateStr) {
      return { skipped: true, reason: 'already-ran-today', date: window.dateStr };
    }
  }

  const eventTypeId = await resolveCalEventTypeId(env);
  const players = await fetchCalAttendeeNames(env, eventTypeId, window);

  const layout = getLayout(players.length, AUTO_IMPORT_NUM_COURTS);
  if (!layout) {
    if (!dryRun) await putJson(env.SCHEDULES, CAL_LAST_PULL_KEY, window.dateStr);
    return {
      skipped: true,
      reason: 'not-enough-players',
      date: window.dateStr,
      playerCount: players.length,
      players,
      dryRun,
    };
  }

  if (dryRun) {
    const roundData = generateRounds(players, layout, [], AUTO_IMPORT_ROUND_COUNT);
    return {
      skipped: false,
      dryRun: true,
      date: window.dateStr,
      playerCount: players.length,
      players,
      layout,
      roundCount: roundData.length,
      sampleFirstRound: roundData[0] || null,
    };
  }

  const scheduleCode = generateScheduleCode();
  const roundData = generateRounds(players, layout, [], AUTO_IMPORT_ROUND_COUNT);
  const shareUrl = buildShareUrl(PROD_SHARE_BASE_URL, scheduleCode);
  const qrDataUrl = await createQrDataUrl(shareUrl);

  const schedule = {
    code: scheduleCode,
    generatedAt: now.toISOString(),
    rounds: roundData,
    players,
    numCourts: AUTO_IMPORT_NUM_COURTS,
    conflictGroup: [],
    layout,
    shareUrl,
    qrDataUrl,
    source: 'cal-auto-import',
    sharedAt: now.toISOString(),
    sharedBy: 'Cal.com auto-import',
  };
  touchSchedule(schedule);

  await saveSchedule(env, schedule);
  await saveCurrentSchedule(env, schedule);
  await notifyScheduleRoom(env, scheduleCode, 'schedule-shared', scheduleStreamPayload(schedule));
  await putJson(env.SCHEDULES, CAL_LAST_PULL_KEY, window.dateStr);
  await registerPlayers(env, players, window.dateStr);
  await addToScheduleIndex(env, {
    code: scheduleCode,
    date: window.dateStr,
    playerCount: players.length,
    source: 'cal-auto-import',
  });

  return { skipped: false, date: window.dateStr, playerCount: players.length, scheduleCode, shareUrl };
}

async function scheduled(event, env, ctx) {
  try {
    const result = await runCalAutoImport(env);
    console.log('cal-auto-import', JSON.stringify(result));
  } catch (error) {
    console.error('cal-auto-import failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function handleCalImportNow(c) {
  const token = c.req.query('token');
  if (!token || token !== c.env.CAL_API_KEY) {
    return c.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const dateOverride = c.req.query('date') || undefined;
  const dryRun = c.req.query('dryRun') === 'true';
  const result = await runCalAutoImport(c.env, { dateOverride, dryRun });
  return c.json(result);
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
  app.post('/api/cal/run-import', handleCalImportNow);
  return app;
}

export {
  addToScheduleIndex,
  assignCourts,
  buildShareUrl,
  canonicalPlayerName,
  conflictPair,
  createQrDataUrl,
  createWorkerApp,
  fetchCalAttendeeNames,
  generateRounds,
  generateScheduleCode,
  getLayout,
  handleCalImportNow,
  handleData,
  handleExtendSchedule,
  handleGenerateSchedule,
  handleGetSchedule,
  handleLeaderboard,
  handleProfiles,
  handleShareSchedule,
  handleScheduleStream,
  healthPayload,
  loadPlayerAliases,
  loadPlayerRegistry,
  loadScheduleIndex,
  makeTeams,
  matchPath,
  normalizePath,
  normalizePlayerKey,
  parseAttendeeName,
  pacificDateWindow,
  registerPlayers,
  resolveCalEventTypeId,
  runCalAutoImport,
  savePlayerRegistry,
  scheduled,
  shuffle,
  ScheduleRoom,
  teamKey,
  teamOk,
};

const workerApp = createWorkerApp();

export default {
  fetch: (request, env, ctx) => workerApp.fetch(request, env, ctx),
  scheduled,
};
