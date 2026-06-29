import QRCode from './qrcode-svg.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SCHEDULE_PREFIX = 'schedule:';
const CURRENT_SCHEDULE_KEY = 'current_schedule';
const PROFILES_KEY = 'profiles';

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

function makeTeams(activePl, layout, used, conflictGroup) {
  let best = null;
  let bestScore = Infinity;
  for (let att = 0; att < 600; att++) {
    const s = shuffle(activePl);
    const courts = assignCourts(s, layout);
    let cv = 0;
    let rv = 0;
    courts.forEach((ct) => {
      if (!teamOk(ct.a, conflictGroup)) cv++;
      if (!teamOk(ct.b, conflictGroup)) cv++;
      if (used.has(teamKey(ct.a))) rv++;
      if (used.has(teamKey(ct.b))) rv++;
    });
    const score = cv * 1000 + rv;
    if (score < bestScore) {
      bestScore = score;
      best = courts;
      if (!score) break;
    }
  }
  return best;
}

function generateRounds(rawPlayers, layout, conflictGroup, count, sitC = null, usedTeams = null) {
  if (sitC === null) {
    sitC = {};
    rawPlayers.forEach((p) => (sitC[p] = 0));
  }
  if (usedTeams === null) {
    usedTeams = new Set();
  }
  const rounds = [];
  for (let r = 0; r < count; r++) {
    const sorted = shuffle(rawPlayers).sort((a, b) => sitC[a] - sitC[b]);
    const subs = sorted.slice(0, layout.subs);
    subs.forEach((p) => sitC[p]++);
    const activePl = rawPlayers.filter((p) => !subs.includes(p));
    const courts = makeTeams(activePl, layout, usedTeams, conflictGroup);
    courts.forEach((ct) => {
      usedTeams.add(teamKey(ct.a));
      usedTeams.add(teamKey(ct.b));
    });
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
  return getJson(env.SCHEDULES, PROFILES_KEY, { players: [], courtLocation: '' });
}

async function createQrDataUrl(text) {
  const svg = await QRCode.toString(text, { type: 'svg' });
  return `data:image/svg+xml;base64,${toBase64(svg)}`;
}

async function handleGenerateSchedule(c) {
  const body = await c.req.json();
  const {
    courtLocation,
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
    courtLocation: courtLocation || '',
    conflictGroup: Array.isArray(conflictGroup) ? conflictGroup : [],
    layout: computedLayout,
    shareUrl,
  };

  await saveSchedule(c.env, schedule);

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

  await saveSchedule(c.env, schedule);
  await saveCurrentSchedule(c.env, schedule);

  return c.json({ ok: true, sharedAt, sharedBy: organizer });
}

async function handleGetSchedule(c) {
  const code = c.req.param('code');
  const schedule = await loadSchedule(c.env, code);

  if (!schedule) {
    return c.json({ error: 'Schedule not found' }, { status: 404 });
  }

  return c.json({ schedule });
}

async function handleExtendSchedule(c) {
  const code = c.req.param('code');
  const body = await c.req.json();
  const { count = 5 } = body ?? {};

  const schedule = await loadSchedule(c.env, code);
  if (!schedule) {
    return c.json({ error: 'Schedule not found' }, { status: 404 });
  }

  const sitC = Object.fromEntries((schedule.players || []).map((p) => [p, 0]));
  const usedTeams = new Set();
  (schedule.rounds || []).forEach((rnd) => {
    (rnd.subs || []).forEach((p) => {
      if (p in sitC) sitC[p]++;
    });
    (rnd.courts || []).forEach((ct) => {
      usedTeams.add(teamKey(ct.a));
      usedTeams.add(teamKey(ct.b));
    });
  });

  const newRounds = generateRounds(
    schedule.players || [],
    schedule.layout,
    schedule.conflictGroup || [],
    count,
    sitC,
    usedTeams,
  );

  schedule.rounds = [...(schedule.rounds || []), ...newRounds];
  await saveSchedule(c.env, schedule);

  const currentSchedule = await loadCurrentSchedule(c.env);
  if (currentSchedule?.code === schedule.code) {
    await saveCurrentSchedule(c.env, schedule);
  }

  return c.json({ schedule });
}

async function handleProfiles(c) {
  const body = await c.req.json();
  const { players, courtLocation } = body ?? {};

  if (!Array.isArray(players)) {
    return c.json({ error: 'Players must be an array' }, { status: 400 });
  }

  const profiles = {
    players,
    courtLocation: courtLocation || '',
  };

  await saveProfiles(c.env, profiles);
  return c.json({ ok: true });
}

async function handleData(c) {
  const profiles = await loadProfiles(c.env);
  return c.json({
    currentSchedule: await loadCurrentSchedule(c.env),
    players: profiles.players || [],
    courtLocation: profiles.courtLocation || '',
  });
}

function createWorkerApp() {
  const app = new Hono();
  app.use('*', cors());
  app.get('/health', (c) => c.json(healthPayload()));
  app.get('/api/health', (c) => c.json(healthPayload()));
  app.post('/api/schedule', handleGenerateSchedule);
  app.get('/api/schedule/:code', handleGetSchedule);
  app.post('/api/schedule/:code/extend', handleExtendSchedule);
  app.post('/api/schedule/share', handleShareSchedule);
  app.post('/api/profiles', handleProfiles);
  app.get('/api/data', handleData);
  return app;
}

export {
  assignCourts,
  buildShareUrl,
  conflictPair,
  createQrDataUrl,
  createWorkerApp,
  generateRounds,
  generateScheduleCode,
  getLayout,
  handleData,
  handleExtendSchedule,
  handleGenerateSchedule,
  handleGetSchedule,
  handleProfiles,
  handleShareSchedule,
  healthPayload,
  makeTeams,
  matchPath,
  normalizePath,
  shuffle,
  teamKey,
  teamOk,
};

export default createWorkerApp();
