'use strict';

// Regression coverage for the check-in tab's power to rewrite a live rotation.
//
// Real incident (BADM-33VE, 2026-11-18): eight players, two courts, nobody left
// early — yet from round 6 on, the shared schedule dropped to seven players
// (1 doubles + 1 singles + 1 sub). A single tap on a player's check-in chip had
// flipped them to "left", which rebuilt every round from the one being played
// onward and pushed the result to every phone holding the share link. The tap
// needed no confirmation, and the round that was actually in progress got
// rewritten along with the future ones.
//
// Check-in stays open to everyone on the share link by design — a player marking
// themselves as leaving is the whole point. So the two properties that stop a
// repeat are the ones pinned here: the round in play is never rebuilt, and a
// roster-shrinking change is confirmed, by name and round range, before any
// state is touched. The confirm is the only thing between a stray tap and a
// rewritten evening, which is exactly why it is tested from the viewer's seat
// as well as the organizer's.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const vm = require('vm');

const {
  readInlineScript,
  extractDeclaration,
  extractSchedulingCode,
  mulberry32,
} = require('./helpers/load-scheduler');

const SPA_SOURCE = readInlineScript(path.join(__dirname, '..', 'index.html'));

// Check-in behaviour lives in the SPA only — the backends never see attendance.
const CHECKIN_NAMES = [
  'ATTENDANCE_CYCLE',
  'playingRoster',
  'syncAttendance',
  'setAttendance',
  'cycleAttendance',
  'everyoneHere',
  'addCheckinPlayer',
  'regenerateUpcomingRounds',
  'parseRawName',
  'isEmail',
  'renderCheckIn',
  'computeDisplayNames',
  'escapeHtml',
];

function extractCheckinCode() {
  let code = '';
  const missing = [];
  for (const name of CHECKIN_NAMES) {
    const decl = extractDeclaration(SPA_SOURCE, name);
    if (decl === null) missing.push(name);
    else code += `${decl}\n`;
  }
  if (missing.length) {
    throw new Error(`index.html: could not extract check-in declarations: ${missing.join(', ')}`);
  }
  return code;
}

// Everything the extracted functions touch that is not itself scheduling logic:
// module-level state the tests inject, and rendering/network side effects that
// are irrelevant here. `confirm` is a recording stub so a test can assert both
// that it was asked and what happens when the answer is "no".
const PREAMBLE = `
var rawPlayers = [];
var attendance = {};
var schedule = [];
var sitC = {};
var pairHistory = null;
var currentLayout = null;
var currentNc = 0;
var currentRound = 0;
var conflictGroup = new Set();
var playerSkills = {};
var isSharedView = false;
var checkinEditMode = false;
var editingRound = null;
var editSelectedSlot = null;
var editHasUnsyncedSwap = false;

var confirmPrompts = [];
var confirmReply = true;
var syncCount = 0;

function confirm(message) { confirmPrompts.push(String(message)); return confirmReply; }
function t(key, vars) { return key + ' ' + JSON.stringify(vars || {}); }
function syncShareQr() { syncCount++; }
function renderSchedule() {}
function renderPlayers() {}
function renderConflictPicker() {}
function updateHint() {}
function syncPlayerCountries() {}
function renderAll() { syncAttendance(); }

// renderCheckIn is the real one (it is the UI half of the guarantee), so the
// elements it reaches for have to behave like the handful of DOM bits it uses.
var __elements = {};
function makeElement() {
  return {
    value: '',
    textContent: '',
    innerHTML: '',
    style: {},
    attributes: {},
    classList: { toggle: function () {}, add: function () {}, remove: function () {} },
    setAttribute: function (k, v) { this.attributes[k] = v; },
  };
}
var document = {
  getElementById: function (id) {
    if (!__elements[id]) __elements[id] = makeElement();
    return __elements[id];
  },
};
`;

const SANDBOX_CODE = `${PREAMBLE}\n${extractSchedulingCode(SPA_SOURCE, 'index.html')}\n${extractCheckinCode()}\n`;

const PLAYERS = ['Ryan', 'Paul', 'Frances', 'Jael', 'Jerry', 'Shlok', 'Ruther', 'Vincent'];

function call(context, expr, args) {
  context.__args = args;
  return vm.runInContext(`${expr}(...__args)`, context);
}

const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * Builds a session that matches the incident: eight players, two courts, a full
 * 15-round schedule already generated and shared, viewer parked on round 6.
 */
function startSession({ seed = 7, sharedView = false, currentRound = 5 } = {}) {
  const context = vm.createContext({ Math, Set, Map, Object, Array, JSON, String, console });
  context.Math = Object.create(Math);
  context.Math.random = mulberry32(seed);
  vm.runInContext(SANDBOX_CODE, context);

  context.rawPlayers = PLAYERS.slice();
  context.attendance = Object.fromEntries(PLAYERS.map((p) => [p, 'playing']));
  context.conflictGroup = new Set(['Jerry', 'Vincent']);
  context.currentNc = 2;
  context.currentLayout = call(context, 'getLayout', [PLAYERS.length, 2]);
  context.sitC = Object.fromEntries(PLAYERS.map((p) => [p, 0]));
  context.pairHistory = call(context, 'createPairHistory', []);
  context.schedule = call(context, 'generateRounds', [15, PLAYERS.slice()]);
  context.currentRound = currentRound;
  context.isSharedView = sharedView;
  context.syncCount = 0;
  context.confirmPrompts = [];
  return context;
}

const roundRoster = (round) =>
  round.courts.reduce((acc, ct) => acc.concat(ct.a, ct.b), round.subs.slice());

test('a player on a share link can mark themselves as leaving', () => {
  const ctx = startSession({ sharedView: true, currentRound: 5 });

  call(ctx, 'cycleAttendance', ['Paul']);

  assert.strictEqual(ctx.attendance.Paul, 'left', 'a viewer must be able to check themselves out');
  assert.ok(ctx.syncCount > 0, 'the change must be published so the group sees it');
  assert.ok(
    !roundRoster(plain(ctx.schedule)[6]).includes('Paul'),
    'later rounds must be rebuilt without the departed player',
  );
});

test('a viewer tap is still gated by the confirm, and declining changes nothing', () => {
  const ctx = startSession({ sharedView: true, currentRound: 5 });
  const before = plain(ctx.schedule);
  ctx.confirmReply = false;

  call(ctx, 'cycleAttendance', ['Paul']);

  assert.strictEqual(ctx.confirmPrompts.length, 1, 'a viewer tap must still ask before rebuilding');
  assert.strictEqual(ctx.attendance.Paul, 'playing', 'declining must leave attendance alone');
  assert.deepStrictEqual(plain(ctx.schedule), before, 'declining must leave the schedule alone');
  assert.strictEqual(ctx.syncCount, 0, 'declining must not publish anything');
});

test('a viewer can add a late arrival from their own phone', () => {
  const ctx = startSession({ sharedView: true, currentRound: 5 });

  ctx.__elements['checkin-add-input'] = { value: 'Late Arrival', textContent: '', style: {} };
  call(ctx, 'addCheckinPlayer', []);

  assert.ok(ctx.rawPlayers.includes('Late Arrival'), 'a late arrival must be able to add themselves');
  assert.strictEqual(ctx.attendance['Late Arrival'], 'playing');
});

test('marking a player as left never rewrites the round being played', () => {
  const ctx = startSession({ currentRound: 5 });
  const before = plain(ctx.schedule);

  call(ctx, 'setAttendance', ['Paul', 'left']);
  const after = plain(ctx.schedule);

  assert.strictEqual(after.length, before.length, 'round count must not change');
  assert.deepStrictEqual(
    after.slice(0, 6),
    before.slice(0, 6),
    'rounds 1-6 were already played or are in progress — they must survive untouched',
  );
  assert.ok(
    roundRoster(after[5]).includes('Paul'),
    'the round in play must keep the player who was already on court',
  );
  for (let i = 6; i < after.length; i++) {
    assert.ok(
      !roundRoster(after[i]).includes('Paul'),
      `round ${i + 1} must be rebuilt without the departed player`,
    );
  }
});

test('the rounds already played keep the full roster and layout they were played with', () => {
  const ctx = startSession({ currentRound: 5 });

  call(ctx, 'setAttendance', ['Paul', 'left']);
  const after = plain(ctx.schedule);

  for (let i = 0; i <= 5; i++) {
    assert.strictEqual(roundRoster(after[i]).length, 8, `round ${i + 1} must still cover 8 players`);
    assert.strictEqual(after[i].subs.length, 0, `round ${i + 1} must still have nobody sitting out`);
    assert.ok(
      after[i].courts.every((ct) => !ct.singles),
      `round ${i + 1} must still be two doubles courts`,
    );
  }
});

test('shrinking the roster is confirmed first, and declining changes nothing', () => {
  const ctx = startSession({ currentRound: 5 });
  const before = plain(ctx.schedule);
  ctx.confirmReply = false;

  call(ctx, 'setAttendance', ['Paul', 'left']);

  assert.strictEqual(ctx.confirmPrompts.length, 1, 'removing a player must ask for confirmation');
  assert.match(ctx.confirmPrompts[0], /Paul/, 'the prompt must name the player being removed');
  assert.strictEqual(ctx.attendance.Paul, 'playing', 'declining must leave attendance alone');
  assert.deepStrictEqual(plain(ctx.schedule), before, 'declining must leave the schedule alone');
  assert.strictEqual(ctx.syncCount, 0, 'declining must not publish anything');
});

test('check-in chips are tappable whether or not you arrived via a share link', () => {
  for (const sharedView of [true, false]) {
    const ctx = startSession({ sharedView });
    call(ctx, 'renderCheckIn', []);

    const chips = ctx.__elements['checkin-chips'].innerHTML;
    assert.match(
      chips,
      /onclick="cycleAttendance\('Paul'\)"/,
      `chips must stay tappable with isSharedView=${sharedView}`,
    );
  }
});

test('adding a player back does not ask for confirmation', () => {
  const ctx = startSession({ currentRound: 5 });
  ctx.attendance.Paul = 'not_arrived';

  call(ctx, 'setAttendance', ['Paul', 'playing']);

  assert.strictEqual(ctx.confirmPrompts.length, 0, 'growing the roster is not destructive');
  assert.strictEqual(ctx.attendance.Paul, 'playing');
});
