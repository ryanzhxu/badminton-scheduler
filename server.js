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
const COUNTRY_LOOKUP_FILE = path.join(__dirname, 'player-countries.json');
const SSE_PING_MS = 25000;
const scheduleSubscribers = new Map();
const normalizePlayerName = name =>
  String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

function loadCountryLookup() {
  try {
    if (!fs.existsSync(COUNTRY_LOOKUP_FILE)) {
      return {};
    }
    const raw = JSON.parse(fs.readFileSync(COUNTRY_LOOKUP_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(raw)
        .map(([name, code]) => [normalizePlayerName(name), String(code || '').trim().toUpperCase()])
        .filter(([, code]) => /^[A-Z]{2}$/.test(code))
    );
  } catch {
    return {};
  }
}

function readBooleanFlag(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

const playerCountryLookup = loadCountryLookup();
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
  return { players: [], courtLocation: '', currentSchedule: null, archivedSchedules: [] };
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

// Skill tiers are 1 (Beginner), 2 (Intermediate), 3 (Advanced). Unrated players
// are treated as a neutral 2 so they don't skew balancing for rosters without
// skill data (fully backward compatible with existing schedules).
const SKILL_IMBALANCE_WEIGHT = 0.1;

function getSkill(playerSkills, name) {
  const v = playerSkills ? playerSkills[name] : undefined;
  return v === 1 || v === 2 || v === 3 ? v : 2;
}

function skillImbalance(ct, playerSkills) {
  if (ct.singles || ct.a.length !== 2 || ct.b.length !== 2) return 0;
  const sa = ct.a.reduce((s, p) => s + getSkill(playerSkills, p), 0);
  const sb = ct.b.reduce((s, p) => s + getSkill(playerSkills, p), 0);
  return Math.pow(sa - sb, 2) * SKILL_IMBALANCE_WEIGHT;
}

function assignCourts(pl, layout) {
  const courts = [];
  let idx = 0;
  for (let c = 0; c < layout.doubles; c++) {
    courts.push({
      a: [pl[idx], pl[idx + 1]],
      b: [pl[idx + 2], pl[idx + 3]],
      singles: false
    });
    idx += 4;
  }
  for (let c = 0; c < layout.singles; c++) {
    courts.push({
      a: [pl[idx]],
      b: [pl[idx + 1]],
      singles: true
    });
    idx += 2;
  }
  return courts;
}

function makeTeams(activePl, layout, used, conflictGroup, playerSkills) {
  let best = null;
  let bestScore = Infinity;
  for (let att = 0; att < 600; att++) {
    const s = shuffle(activePl);
    const courts = assignCourts(s, layout);
    let cv = 0;
    let rv = 0;
    let sv = 0;
    courts.forEach(ct => {
      if (!teamOk(ct.a, conflictGroup)) cv++;
      if (!teamOk(ct.b, conflictGroup)) cv++;
      if (used.has(teamKey(ct.a))) rv++;
      if (used.has(teamKey(ct.b))) rv++;
      sv += skillImbalance(ct, playerSkills);
    });
    const score = cv * 1000 + rv + sv;
    if (score < bestScore) {
      bestScore = score;
      best = courts;
      if (!score) break;
    }
  }
  return best;
}

function generateRounds(rawPlayers, layout, conflictGroup, count, sitC = null, usedTeams = null, playerSkills = null) {
  if (sitC === null) {
    sitC = {};
    rawPlayers.forEach(p => (sitC[p] = 0));
  }
  if (usedTeams === null) {
    usedTeams = new Set();
  }
  const rounds = [];
  for (let r = 0; r < count; r++) {
    const sorted = shuffle(rawPlayers).sort((a, b) => sitC[a] - sitC[b]);
    const subs = sorted.slice(0, layout.subs);
    subs.forEach(p => sitC[p]++);
    const activePl = rawPlayers.filter(p => !subs.includes(p));
    const courts = makeTeams(activePl, layout, usedTeams, conflictGroup, playerSkills);
    courts.forEach(ct => {
      usedTeams.add(teamKey(ct.a));
      usedTeams.add(teamKey(ct.b));
    });
    rounds.push({ subs, courts });
  }
  return rounds;
}

app.post('/api/schedule', async (req, res) => {
  try {
    const { courtLocation, numCourts, players, conflictGroup, layout, rounds, shareBaseUrl } = req.body;

    if (!numCourts || !players || !Array.isArray(players)) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    const playerNames = players.map(p => (typeof p === 'string' ? p : p.name)).filter(Boolean);
    const playerSkills = {};
    players.forEach(p => {
      if (p && typeof p === 'object' && p.name && (p.skill === 1 || p.skill === 2 || p.skill === 3)) {
        playerSkills[p.name] = p.skill;
      }
    });
    const computedLayout = layout || getLayout(playerNames.length, numCourts);

    if (!computedLayout) {
      return res.status(400).json({ error: 'Cannot create valid layout' });
    }

    const scheduleCode = generateScheduleCode();
    const roundData = Array.isArray(rounds) ? rounds : generateRounds(playerNames, computedLayout, conflictGroup || [], 10, null, null, playerSkills);
    const shareUrl = buildShareUrl(shareBaseUrl || req.get('origin'), scheduleCode);

    const qrDataUrl = await QRCode.toDataURL(shareUrl);

    const schedule = {
      code: scheduleCode,
      generatedAt: new Date().toISOString(),
      rounds: roundData,
      players: playerNames,
      playerSkills,
      numCourts,
      courtLocation: courtLocation || '',
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
      courtLocation: data.courtLocation,
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
    const usedTeams = new Set();
    existingRounds.forEach(rnd => {
      rnd.subs.forEach(p => { if (p in sitC) sitC[p]++; });
      rnd.courts.forEach(ct => { usedTeams.add(teamKey(ct.a)); usedTeams.add(teamKey(ct.b)); });
    });

    const newRounds = generateRounds(schedule.players, schedule.layout, schedule.conflictGroup, count, sitC, usedTeams, schedule.playerSkills || null);
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
    const { players, courtLocation } = req.body;

    if (!Array.isArray(players)) {
      return res.status(400).json({ error: 'Players must be an array' });
    }

    const data = loadData();
    data.players = players;
    if (courtLocation) {
      data.courtLocation = courtLocation;
    }
    saveData(data);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Badminton scheduler API running on port ${PORT}`);
});
