'use strict';

// Loads the rotation-scheduling functions out of each of the three places they
// live (the SPA's inline <script>, the Cloudflare Worker, and the Express server)
// and exposes them behind one normalized `generate()` call.
//
// The functions are lifted straight out of the real sources rather than imported,
// because index.html is a deliberately self-contained single file with no build
// step, and importing server.js / worker/src/index.js would pull in express,
// hono and a live listener. Extracting keeps the suite dependency-free and makes
// the three implementations testable against identical assertions, which is what
// keeps them from drifting apart.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..', '..');

// Names every implementation must provide. Extraction fails loudly if one is
// missing, so deleting or renaming a scheduling function breaks the suite
// instead of silently skipping coverage.
const REQUIRED_NAMES = [
  'REPEAT_PARTNER_WEIGHT',
  'REPEAT_OPPONENT_WEIGHT',
  'CONSECUTIVE_OPPONENT_WEIGHT',
  'shuffle',
  'teamKey',
  'conflictPair',
  'teamOk',
  'pairKey',
  'createPairHistory',
  'courtPairs',
  'recordRound',
  'greedyMatch',
  'matchPartnersRespectingConflicts',
  'buildRoundCourts',
  'generateRounds',
  'getLayout',
];

function sliceBalancedBraces(source, startIdx) {
  let depth = 0;
  let seenBrace = false;
  for (let i = startIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      depth++;
      seenBrace = true;
    } else if (ch === '}') {
      depth--;
      if (seenBrace && depth === 0) return source.slice(startIdx, i + 1);
    }
  }
  throw new Error('Unbalanced braces while extracting declaration');
}

// The const declarations in these files are simple literals, `new Map()` /
// `new Set()` or object literals, so tracking bracket depth is enough to find
// the terminating semicolon without a full parser.
function sliceStatement(source, startIdx) {
  let depth = 0;
  for (let i = startIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ';' && depth === 0) return source.slice(startIdx, i + 1);
  }
  throw new Error('Could not find end of statement while extracting declaration');
}

function extractDeclaration(source, name) {
  const fnIdx = source.indexOf(`function ${name}(`);
  if (fnIdx !== -1) return sliceBalancedBraces(source, fnIdx);

  // Also matches multi-name declarations like `const A=1,B=2;`, which the SPA uses.
  const constMatch = new RegExp(`const [^;\\n]*\\b${name}\\b\\s*=`).exec(source);
  if (constMatch) return sliceStatement(source, constMatch.index);

  return null;
}

function isAlreadyDeclared(code, name) {
  return new RegExp(`(function|const|let)\\s[^;\\n]*\\b${name}\\b`).test(code);
}

function extractSchedulingCode(source, label) {
  let code = '';
  const missing = [];
  for (const name of REQUIRED_NAMES) {
    if (isAlreadyDeclared(code, name)) continue;
    const decl = extractDeclaration(source, name);
    if (decl === null) {
      missing.push(name);
      continue;
    }
    code += `${decl}\n`;
  }
  if (missing.length) {
    throw new Error(`${label}: could not extract scheduling declarations: ${missing.join(', ')}`);
  }
  return code;
}

function readInlineScript(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!blocks.length) throw new Error(`No inline <script> found in ${htmlPath}`);
  // The scheduling logic lives in the largest inline block (the app script).
  return blocks.sort((a, b) => b.length - a.length)[0];
}

// Deterministic PRNG so a failing test can be replayed from its seed instead of
// being dismissed as flake.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSandbox(code) {
  // `sitC`, `currentLayout` and `pairHistory` are module-level state in the SPA
  // that its generateRounds() reads directly; the backends take them as
  // parameters and simply ignore these.
  // Declared with `var` on purpose: inside a vm context only `var` bindings become
  // properties of the context object, which is how the tests inject state.
  const preamble = `
var rawPlayers = [];
var conflictGroup = new Set();
var sitC = {};
var currentLayout = null;
var pairHistory = null;
function playingRoster() { return rawPlayers.slice(); }
`;
  const context = vm.createContext({ Math, Set, Map, Object, Array, JSON, console });
  vm.runInContext(`${preamble}\n${code}\n`, context);
  return context;
}

function makeImplementation({ name, source }) {
  const code = extractSchedulingCode(source, name);
  const context = buildSandbox(code);

  const call = (expr, args) => {
    context.__args = args;
    return vm.runInContext(`${expr}(...__args)`, context);
  };

  // Objects created inside a vm context carry that context's prototypes, which
  // makes them unequal to host-realm objects under deepStrictEqual even when
  // structurally identical. Rounds and layouts are plain data, so copy them into
  // the host realm before handing them to tests.
  const plain = (value) => JSON.parse(JSON.stringify(value));

  const isClient = /function generateRounds\(count/.test(code);

  return {
    name,
    isClient,
    getLayout: (n, nc) => plain(call('getLayout', [n, nc])),
    // Pair history holds Maps and is fed back into the vm, so it stays as-is.
    createPairHistory: () => call('createPairHistory', []),
    recordRound: (hist, courts) => call('recordRound', [hist, courts]),

    /**
     * Generates rounds through the implementation's own round loop.
     *
     * @param {object} opts
     * @param {string[]} opts.players roster, in setup order
     * @param {number} opts.numCourts
     * @param {number} opts.rounds how many rounds to generate
     * @param {string[]} [opts.conflicts] players who must never be teammates
     * @param {number} [opts.seed] PRNG seed; same seed gives the same schedule
     * @param {object} [opts.history] pre-seeded pair history (extension path)
     * @param {object} [opts.sitCounts] pre-seeded sit-out counts (extension path)
     */
    generate({ players, numCourts, rounds, conflicts = [], seed = 1, history = null, sitCounts = null }) {
      context.Math = Object.create(Math);
      context.Math.random = mulberry32(seed);

      const layout = call('getLayout', [players.length, numCourts]);
      if (!layout) throw new Error(`No layout for ${players.length} players on ${numCourts} courts`);

      if (this.isClient) {
        context.rawPlayers = players.slice();
        context.conflictGroup = new Set(conflicts);
        context.sitC = sitCounts || Object.fromEntries(players.map((p) => [p, 0]));
        context.currentLayout = layout;
        context.pairHistory = history || call('createPairHistory', []);
        return { rounds: plain(call('generateRounds', [rounds, players.slice()])), layout };
      }

      return {
        rounds: plain(
          call('generateRounds', [
            players.slice(),
            layout,
            conflicts.slice(),
            rounds,
            sitCounts || Object.fromEntries(players.map((p) => [p, 0])),
            history || call('createPairHistory', []),
          ]),
        ),
        layout,
      };
    },
  };
}

function loadImplementations() {
  return [
    makeImplementation({
      name: 'index.html (SPA)',
      source: readInlineScript(path.join(REPO_ROOT, 'index.html')),
    }),
    makeImplementation({
      name: 'worker/src/index.js (Cloudflare Worker)',
      source: fs.readFileSync(path.join(REPO_ROOT, 'worker', 'src', 'index.js'), 'utf8'),
    }),
    makeImplementation({
      name: 'server.js (Express)',
      source: fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8'),
    }),
  ];
}

module.exports = { loadImplementations, mulberry32, REQUIRED_NAMES, readInlineScript, extractDeclaration };
