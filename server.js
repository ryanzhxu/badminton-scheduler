const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const DATA_FILE = path.join(__dirname, 'shared-data.json');
const SSE_PING_MS = 25000;
const scheduleSubscribers = new Map();
const normalizePlayerName = name =>
  String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

function readBooleanFlag(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

const playerCountryLookup = {};
const showCountryLabel = readBooleanFlag(
  process.env.SHOW_COUNTRY_LABELS ??
    process.env.SHOW_COUNTRY_LABEL ??
    process.env.COUNTRY_LABELS_ENABLED,
);

app.use(cors());
app.use(express.json());

function healthPayload() {
  return {
    ok: true,
    service: 'badminton-scheduler-api',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  };
}

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  return { players: [], currentSchedule: null, archivedSchedules: [] };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
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
    payload.split(/\r?\n/).forEach(line => lines.push(`data: ${line}`));
  }
  return `${lines.join('\n')}\n\n`;
}

function publishScheduleEvent(code, event, data) {
  const subscribers = scheduleSubscribers.get(code);
  if (!subscribers || !subscribers.size) {
    return;
  }

  const message = formatSseMessage({
    event,
    data,
    id: data && data.revision,
  });

  for (const subscriber of [...subscribers]) {
    try {
      subscriber.res.write(message);
    } catch {
      subscriber.cleanup();
    }
  }
}

function addScheduleSubscriber(code, res) {
  let subscribers = scheduleSubscribers.get(code);
  if (!subscribers) {
    subscribers = new Set();
    scheduleSubscribers.set(code, subscribers);
  }

  const subscriber = { res, heartbeat: null, cleanup: null };
  subscriber.cleanup = () => {
    if (subscriber.heartbeat) {
      clearInterval(subscriber.heartbeat);
      subscriber.heartbeat = null;
    }
    const current = scheduleSubscribers.get(code);
    if (current) {
      current.delete(subscriber);
      if (!current.size) {
        scheduleSubscribers.delete(code);
      }
    }
  };

  subscriber.heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      subscriber.cleanup();
    }
  }, SSE_PING_MS);

  subscribers.add(subscriber);
  return subscriber;
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
  [ct.a, ct.b].forEach(team => {
    for (let i = 0; i < team.length; i++) {
      for (let j = i + 1; j < team.length; j++) {
        partners.push(pairKey(team[i], team[j]));
      }
    }
  });
  ct.a.forEach(p => ct.b.forEach(q => opponents.push(pairKey(p, q))));
  return { partners, opponents };
}

function recordRound(hist, courts) {
  const thisRound = new Set();
  (courts || []).forEach(ct => {
    const { partners, opponents } = courtPairs(ct);
    partners.forEach(k => hist.partners.set(k, (hist.partners.get(k) || 0) + 1));
    opponents.forEach(k => {
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
  const cliqueActive = activePl.filter(p => conflictGroup.includes(p));
  if (cliqueActive.length < 2) return greedyMatch(activePl, partnerCost);
  const cliqueSet = new Set(cliqueActive);
  const nonClique = shuffle(activePl.filter(p => !cliqueSet.has(p)));
  const clique = shuffle(cliqueActive);
  const pairs = [];
  const usedNonClique = new Set();
  clique.forEach(p => {
    const available = nonClique.filter(q => !usedNonClique.has(q));
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
  const matchedClique = new Set(pairs.map(pr => pr[0]));
  const leftoverClique = clique.filter(p => !matchedClique.has(p));
  const leftoverNonClique = nonClique.filter(q => !usedNonClique.has(q));
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
    pairA.forEach(p => pairB.forEach(q => { c += opponentCost(p, q); }));
    return c;
  };
  const doublesCourts = greedyMatch(partnerPairs, courtPairCost).map(([a, b]) => ({ a, b, singles: false }));
  const singlesCourts = greedyMatch(singlesPl, opponentCost).map(([a, b]) => ({ a: [a], b: [b], singles: true }));
  return [...doublesCourts, ...singlesCourts];
}

function generateRounds(rawPlayers, layout, conflictGroup, count, sitC = null, history = null) {
  if (sitC === null) {
    sitC = {};
    rawPlayers.forEach(p => (sitC[p] = 0));
  }
  if (history === null) {
    history = createPairHistory();
  }
  const rounds = [];
  for (let r = 0; r < count; r++) {
    const sorted = shuffle(rawPlayers).sort((a, b) => sitC[a] - sitC[b]);
    const subs = sorted.slice(0, layout.subs);
    subs.forEach(p => sitC[p]++);
    const activePl = rawPlayers.filter(p => !subs.includes(p));
    const courts = buildRoundCourts(activePl, layout, history, conflictGroup);
    recordRound(history, courts);
    rounds.push({ subs, courts });
  }
  return rounds;
}

app.post('/api/schedule', async (req, res) => {
  try {
    const { numCourts, players, conflictGroup, layout, rounds, shareBaseUrl } = req.body;

    if (!numCourts || !players || !Array.isArray(players)) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    const playerNames = players.map(p => (typeof p === 'string' ? p : p.name)).filter(Boolean);
    const computedLayout = layout || getLayout(playerNames.length, numCourts);

    if (!computedLayout) {
      return res.status(400).json({ error: 'Cannot create valid layout' });
    }

    const scheduleCode = generateScheduleCode();
    const roundData = Array.isArray(rounds) ? rounds : generateRounds(playerNames, computedLayout, conflictGroup || [], 15);
    const shareUrl = buildShareUrl(shareBaseUrl || req.get('origin'), scheduleCode);

    const qrDataUrl = await QRCode.toDataURL(shareUrl);

    const schedule = {
      code: scheduleCode,
      generatedAt: new Date().toISOString(),
      rounds: roundData,
      players: playerNames,
      numCourts,
      conflictGroup: Array.isArray(conflictGroup) ? conflictGroup : [],
      layout: computedLayout,
      shareUrl
    };

    touchSchedule(schedule);

    const data = loadData();
    data.archivedSchedules.push(schedule);
    saveData(data);

    res.json({
      scheduleCode,
      shareUrl,
      qrDataUrl,
      schedule
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get(['/health', '/api/health'], (req, res) => {
  res.status(200).json(healthPayload());
});

app.post('/api/schedule/share', (req, res) => {
  try {
    const { scheduleCode, organizer } = req.body;

    if (!scheduleCode || !organizer) {
      return res.status(400).json({ error: 'Missing scheduleCode or organizer' });
    }

    const data = loadData();
    const schedule = data.archivedSchedules.find(s => s.code === scheduleCode);

    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    const sharedAt = new Date().toISOString();
    schedule.sharedAt = sharedAt;
    schedule.sharedBy = organizer;
    touchSchedule(schedule);

    data.currentSchedule = schedule;
    saveData(data);
    publishScheduleEvent(scheduleCode, 'schedule-shared', scheduleStreamPayload(schedule));

    res.json({ ok: true, sharedAt, sharedBy: organizer, schedule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/data', (req, res) => {
  try {
    const data = loadData();
    res.json({
      currentSchedule: data.currentSchedule,
      players: data.players,
      showCountryLabel,
      playerCountryLookup,
      countryLookup: playerCountryLookup
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/schedule/:code', (req, res) => {
  try {
    const { code } = req.params;
    const data = loadData();
    const schedule = data.archivedSchedules.find(s => s.code === code);

    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    res.json({ schedule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/schedule/:code/stream', (req, res) => {
  try {
    const { code } = req.params;
    const data = loadData();
    const schedule = data.archivedSchedules.find(s => s.code === code);

    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    res.writeHead(200, createSseHeaders());
    res.flushHeaders?.();
    res.write(': connected\n\n');

    const subscriber = addScheduleSubscriber(code, res);
    const cleanup = () => subscriber.cleanup();
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/schedule/:code/extend', (req, res) => {
  try {
    const { code } = req.params;
    const { count = 5, baseRoundCount } = req.body || {};

    const data = loadData();
    const schedule = data.archivedSchedules.find(s => s.code === code);

    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    const currentRoundCount = Array.isArray(schedule.rounds) ? schedule.rounds.length : 0;
    const requestedBaseRoundCount = Number(baseRoundCount);
    if (!Number.isInteger(requestedBaseRoundCount) || requestedBaseRoundCount !== currentRoundCount) {
      return res.json({ schedule, extended: false });
    }

    const existingRounds = Array.isArray(schedule.rounds) ? schedule.rounds : [];
    const sitC = Object.fromEntries(schedule.players.map(p => [p, 0]));
    const history = createPairHistory();
    existingRounds.forEach(rnd => {
      rnd.subs.forEach(p => { if (p in sitC) sitC[p]++; });
      recordRound(history, rnd.courts);
    });

    const newRounds = generateRounds(schedule.players, schedule.layout, schedule.conflictGroup, count, sitC, history);
    schedule.rounds = [...existingRounds, ...newRounds];
    touchSchedule(schedule);
    saveData(data);
    publishScheduleEvent(code, 'schedule-updated', scheduleStreamPayload(schedule));
    res.json({ schedule, extended: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/profiles', (req, res) => {
  try {
    const { players } = req.body;

    if (!Array.isArray(players)) {
      return res.status(400).json({ error: 'Players must be an array' });
    }

    const data = loadData();
    data.players = players;
    saveData(data);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Badminton scheduler API running on port ${PORT}`);
});
