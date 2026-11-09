# Skill-Based Game Balancing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reinstate a per-session 3-tier skill rating, and add two new soft cost terms (complementary doubles partners, balanced doubles teams, similar-skill singles opponents) to the scheduling algorithm, Trulioo-only, across all three implementations.

**Architecture:** Additive cost terms layered onto the existing `greedyMatch`/`matchPartnersRespectingConflicts`/`buildRoundCourts` pipeline in all three copies (`index.html`, `worker/src/index.js`, `server.js`), gated off entirely in Courtly/public mode. Rating state is per-session (not persisted by player identity), but *is* persisted on the stored schedule record so `extend` can reuse it.

**Tech Stack:** Vanilla JS (SPA), Cloudflare Worker (Hono), Express — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-08-skill-balancing-design.md`

## Global Constraints

- Conflicts remain an absolute, never-violated restriction — skill cost terms never override `matchPartnersRespectingConflicts`'s clique-first conflict handling.
- Must not regress existing invariants in `tests/scheduling.test.js` (sit-out fairness, conflict avoidance, pairing variety, cross-implementation parity, identical-seed determinism).
- All three implementations (`index.html`, `worker/src/index.js`, `server.js`) must stay behaviorally aligned, since `tests/helpers/load-scheduler.js` extracts and runs all three against the same assertions.
- Courtly (public mode) must be unaffected: in the Worker, gate via the existing `isPublicMode(env)` check (`worker/src/index.js:20`), not just by the client never sending skill data.
- 3-tier scale: 1=Beginner, 2=Intermediate, 3=Advanced, default 2 when unset.
- Rating is per-session: no new KV/registry entity, no persistence by player identity.
- Starting weights: `SKILL_COMPLEMENT_WEIGHT`, `SKILL_TEAM_BALANCE_WEIGHT`, `SKILL_SINGLES_WEIGHT` all start at `0.1` (the old feature's precedent weight), tuned during Task 4 against measured behavior.

## Review Focus

- A roster where every player is unrated (all default to tier 2): all three new cost terms must evaluate to zero everywhere, so output is identical to today's pre-feature behavior — exercised implicitly by the existing suite's untouched tests, which pass no skill data.
- A conflict-group pair that is also each other's best complementary-skill match: must never end up partnered, same as today — exercised by Task 4's new conflict-priority test.
- A roster with an odd skill distribution (e.g. one Advanced player among many Beginners) that has no clean complementary pairing available: `greedyMatch`'s existing leftover-pairing fallback must still produce a complete, valid round rather than erroring — exercised by Task 4 using an already-covered scenario size from the existing suite (13/14/17 players) with a skewed skill distribution layered on top.
- Extending a schedule generated *before* this feature existed (no stored `playerSkills`): must not error, and must simply skip the skill cost terms for that extension — exercised by Task 3's Worker/server handler tests (manual verification, no stored field present).
- Courtly/public-mode request that attaches `players[].skill` directly (bypassing the UI): must get byte-identical output to a request with no skill data, not skill-influenced output — exercised by Task 3's `isPublicMode` gating check.

---

### Task 1: Reinstate skill rating state and UI in `index.html`

**Files:**
- Modify: `index.html:506` (global state), `index.html:1178-1179` (removePlayer/clearAllPlayers), `index.html:1511-1515` (renderPlayers), `index.html:1477-1500` (syncShareQr), `index.html:839-857` (applyScheduleSnapshot), `index.html:56` (`.pchip` CSS block — add `.skill-btn` rules nearby)
- Test: manual browser verification (no automated test — this is UI-only state/rendering, consistent with how `demoPlayers`/`attendance` are untested today)

**Interfaces:**
- Produces: `playerSkills` (global `{[name]: 1|2|3}`), `getSkill(name): 1|2|3`, `cycleSkill(name): void` — consumed by Task 2 (cost functions).

- [ ] **Step 1: Add `playerSkills` to global state**

  In `index.html:506`, change
  `let rawPlayers=[],conflictGroup=new Set(),schedule=[],currentRound=0;`
  to also declare `playerSkills={}` on the same line.

- [ ] **Step 2: Add `getSkill`/`cycleSkill` helpers**

  Add near `teamKey`/`pairKey` (around `index.html:1540`):
  ```js
  function getSkill(name){const v=playerSkills[name];return v===1||v===2||v===3?v:2;}
  function cycleSkill(raw){const cur=getSkill(raw);playerSkills[raw]=cur>=3?1:cur+1;renderPlayers();}
  ```

- [ ] **Step 3: Clean up `playerSkills` on player removal**

  In `index.html:1178`, `removePlayer(i)` gets `delete playerSkills[r];` added alongside the existing `conflictGroup.delete(r);demoPlayers.delete(r);`.
  In `index.html:1179`, `clearAllPlayers()` gets `playerSkills={};` added alongside `conflictGroup=new Set();demoPlayers=new Set();`.

- [ ] **Step 4: Add the skill-cycle button to each player chip**

  In `renderPlayers()` (`index.html:1511-1515`), the chip markup gains a button between the name and the remove (`×`) span, **only when `!IS_COURTLY`**:
  ```js
  const skillBtn=IS_COURTLY?'':`<button type="button" class="skill-btn s${getSkill(r)}" title="${t('skillTierLabel')}" onclick="cycleSkill('${r.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')">${getSkill(r)}</button>`;
  ```
  (letter/number shown on the button and its `s1`/`s2`/`s3` CSS class are the implementer's call on exact label — `2fe6ed3`'s old version used single-letter tier labels via a `SKILL_LETTERS` map if you want to match that precedent exactly, otherwise the raw tier number is fine.)

- [ ] **Step 5: Add `.skill-btn` CSS**

  Near `index.html:56` (`.pchip{...}`), add:
  ```css
  .skill-btn{cursor:pointer;border:none;background:var(--ph);color:#fff;font-size:10px;font-weight:700;line-height:1;padding:2px 6px;border-radius:8px;margin-left:2px}
  .skill-btn.s1{background:#8FA6A0}
  .skill-btn.s2{background:var(--ph)}
  .skill-btn.s3{background:var(--ia)}
  ```

- [ ] **Step 6: Send skill data on generate/extend, restore it on snapshot**

  In `syncShareQr()` (`index.html:1491`), change `players:rawPlayers,` to
  `players:rawPlayers.map(name=>({name,skill:getSkill(name)})),` and add a top-level
  `playerSkills:{...playerSkills},` field to the same request body object.

  In `applyScheduleSnapshot()` (`index.html:842`, right after the `rawPlayers=` line), add:
  ```js
  playerSkills=sch.playerSkills&&typeof sch.playerSkills==='object'?{...sch.playerSkills}:Object.fromEntries((sch.players||[]).filter(p=>p&&typeof p==='object'&&p.name&&p.skill).map(p=>[p.name,p.skill]));
  ```

- [ ] **Step 7: Manual verification**

  Run `npm start`, open the app on `localhost` (Trulioo branch), add a few players, confirm the skill-cycle button appears on each chip and cycles 1→2→3→1 on click, persists through "Generate Schedule," and survives reloading via `?scheduleCode=...`. Then simulate Courtly (temporarily set `IS_COURTLY` true or test via the Courtly hostname/build) and confirm the button is absent.

- [ ] **Step 8: Commit**

  ```bash
  git add index.html
  git commit -m "feat: reinstate per-player skill rating UI (Trulioo only)"
  ```

---

### Task 2: Add skill-aware cost terms to `index.html`'s scheduling functions

**Files:**
- Modify: `index.html:1601-1645` (`matchPartnersRespectingConflicts`, `buildRoundCourts`)

**Interfaces:**
- Consumes: `getSkill(name)` from Task 1.
- Produces: unchanged function signatures (`matchPartnersRespectingConflicts(activePl,hist)`, `buildRoundCourts(activePl,layout,hist)`) — the SPA reads `playerSkills` via the global, like it already does for `conflictGroup`/`pairHistory`, so no new parameters here. This matters for Task 5 (test harness), which must inject the global rather than pass an argument for this implementation only.

- [ ] **Step 1: Add the three weight constants**

  Near `index.html:1545` (`const REPEAT_PARTNER_WEIGHT=...`), add:
  ```js
  const SKILL_COMPLEMENT_WEIGHT=0.1,SKILL_TEAM_BALANCE_WEIGHT=0.1,SKILL_SINGLES_WEIGHT=0.1;
  ```

- [ ] **Step 2: Reward complementary-skill partners**

  In `matchPartnersRespectingConflicts` (`index.html:1602`), change
  `const partnerCost=(a,b)=>{const n=hist.partners.get(pairKey(a,b))||0;return n*n*REPEAT_PARTNER_WEIGHT;};`
  to subtract a skill-dissimilarity reward:
  `const partnerCost=(a,b)=>{const n=hist.partners.get(pairKey(a,b))||0;return n*n*REPEAT_PARTNER_WEIGHT-SKILL_COMPLEMENT_WEIGHT*Math.pow(getSkill(a)-getSkill(b),2);};`

- [ ] **Step 3: Add team-sum balance and singles skill-similarity**

  In `buildRoundCourts` (`index.html:1629-1645`), after the existing `opponentCost` definition, add a singles-specific wrapper and extend `courtPairCost`:
  ```js
  const singlesOpponentCost=(a,b)=>opponentCost(a,b)+SKILL_SINGLES_WEIGHT*Math.pow(getSkill(a)-getSkill(b),2);
  ```
  Change `const courtPairCost=(pairA,pairB)=>{let c=0;pairA.forEach(p=>pairB.forEach(q=>{c+=opponentCost(p,q);}));return c;};`
  to add a team-sum-difference term before returning:
  ```js
  const courtPairCost=(pairA,pairB)=>{
    let c=0;pairA.forEach(p=>pairB.forEach(q=>{c+=opponentCost(p,q);}));
    const skillSum=pair=>pair.reduce((s,p)=>s+getSkill(p),0);
    c+=SKILL_TEAM_BALANCE_WEIGHT*Math.pow(skillSum(pairA)-skillSum(pairB),2);
    return c;
  };
  ```
  Change the singles line `const singlesCourts=greedyMatch(singlesPl,opponentCost).map(...)` to use `singlesOpponentCost` instead of `opponentCost`.

- [ ] **Step 4: Commit**

  ```bash
  git add index.html
  git commit -m "feat: add skill-aware cost terms to SPA scheduling functions"
  ```

---

### Task 3: Port the same state threading and cost terms to `worker/src/index.js` and `server.js`

**Files:**
- Modify: `worker/src/index.js:296-298` (weights), `worker/src/index.js:388-448` (`matchPartnersRespectingConflicts`, `buildRoundCourts`), `worker/src/index.js:450-468` (`generateRounds`), `worker/src/index.js:713-795` (`handleGenerateSchedule`), `worker/src/index.js:892-939` (`handleExtendSchedule`)
- Modify: `server.js:232-234` (weights), `server.js:324-405` (`matchPartnersRespectingConflicts`, `buildRoundCourts`, `generateRounds`), `server.js:407-454` (`/api/schedule` POST), `server.js:545-580` (`/api/schedule/:code/extend` POST)

**Interfaces:**
- Consumes: `isPublicMode(env)` (`worker/src/index.js:20`) — unchanged signature.
- Produces: `getSkill(playerSkills, name): 1|2|3`; new 4th param `playerSkills` on `matchPartnersRespectingConflicts(activePl, hist, conflictGroup, playerSkills)`; new 5th param on `buildRoundCourts(activePl, layout, hist, conflictGroup, playerSkills)`; new 7th param on `generateRounds(rawPlayers, layout, conflictGroup, count, sitC, history, playerSkills = null)` — these three new signatures are identical in both `worker/src/index.js` and `server.js`, and are what Task 5's test harness must call with.

- [ ] **Step 1: Add weight constants and `getSkill` helper (both files)**

  Next to each file's `REPEAT_PARTNER_WEIGHT`/`REPEAT_OPPONENT_WEIGHT`/`CONSECUTIVE_OPPONENT_WEIGHT` consts, add the same three skill weight consts as Task 2, Step 1 (`SKILL_COMPLEMENT_WEIGHT = 0.1`, `SKILL_TEAM_BALANCE_WEIGHT = 0.1`, `SKILL_SINGLES_WEIGHT = 0.1`, worker-style multi-line `const` declarations to match each file's existing style). Add:
  ```js
  function getSkill(playerSkills, name) {
    const v = playerSkills ? playerSkills[name] : undefined;
    return v === 1 || v === 2 || v === 3 ? v : 2;
  }
  ```

- [ ] **Step 2: Thread `playerSkills` through `matchPartnersRespectingConflicts`, `buildRoundCourts`, `generateRounds` (both files)**

  Mirror Task 2, Step 2-3's cost-function changes, but call `getSkill(playerSkills, a)` instead of `getSkill(a)`, and add `playerSkills` as the new trailing parameter at each level (`matchPartnersRespectingConflicts(activePl, hist, conflictGroup, playerSkills)`, `buildRoundCourts(activePl, layout, hist, conflictGroup, playerSkills)`, passing it down from `generateRounds(..., playerSkills = null)`'s new parameter into its `buildRoundCourts(...)` call at `worker/src/index.js:464` / `server.js:400`.

- [ ] **Step 3: Thread `playerSkills` through the Worker's generate/extend handlers, gated by `isPublicMode`**

  In `handleGenerateSchedule` (`worker/src/index.js:713`), destructure `playerSkills` isn't sent directly — it's derived from `players[].skill`, matching the `sport` fallback precedent at line 767:
  ```js
  const incomingSkills = {};
  players.forEach((p) => {
    if (p && typeof p === 'object' && p.name && (p.skill === 1 || p.skill === 2 || p.skill === 3)) {
      incomingSkills[p.name] = p.skill;
    }
  });
  const playerSkills = isPublicMode(c.env)
    ? null
    : (Object.keys(incomingSkills).length ? incomingSkills : existing?.playerSkills || null);
  ```
  Pass `playerSkills` as the new 7th arg to the `generateRounds(...)` call at line 751, and add `playerSkills,` as a new field on the `schedule` object literal at line 755-768 (alongside `sport`).

  In `handleExtendSchedule` (`worker/src/index.js:892`), add `schedule.playerSkills || null` as the new 7th arg to the `generateRounds(...)` call at line 918-925 (no `isPublicMode` check needed here — a public-mode schedule never has this field populated, per Step 3 above, so it's already null for Courtly).

- [ ] **Step 4: Thread `playerSkills` through `server.js`'s generate/extend routes (no public-mode concept)**

  In `app.post('/api/schedule', ...)` (`server.js:407`), derive `incomingSkills` the same way as Step 3 (no `isPublicMode` gating — `server.js` has no Courtly/public-mode concept), add `playerSkills: Object.keys(incomingSkills).length ? incomingSkills : null` to the `schedule` object literal (line 428-437), and pass it as the 7th arg to `generateRounds(...)` at line 423.

  In `app.post('/api/schedule/:code/extend', ...)` (`server.js:545`), add `schedule.playerSkills || null` as the 7th arg to `generateRounds(...)` at line 571.

- [ ] **Step 5: Syntax check**

  Run: `node --check worker/src/index.js && node --check server.js`
  Expected: no output, exit code 0.

- [ ] **Step 6: Manual verification**

  Run `npm start`; from the SPA, generate a schedule with mixed skill ratings, confirm `shared-data.json`'s schedule entry gains a `playerSkills` field; extend the schedule and confirm the field is still present and used (spot-check that new rounds still show skill-aware pairing via the constraint panel or a quick console log).

- [ ] **Step 7: Commit**

  ```bash
  git add worker/src/index.js server.js
  git commit -m "feat: thread skill ratings through Worker and server scheduling"
  ```

---

### Task 4: Extend the test harness and add regression coverage

**Files:**
- Modify: `tests/helpers/load-scheduler.js` (`REQUIRED_NAMES`, sandbox preamble, `generate()` options)
- Modify: `tests/helpers/analyze.js` (new skill-aware analysis helpers)
- Modify: `tests/scheduling.test.js` (new `describe` block or new tests within existing structure)

**Interfaces:**
- Consumes: `getSkill`/weight consts from Tasks 2-3; `generateRounds`'s new 7th param (backends) / global `playerSkills` (SPA).
- Produces: `impl.generate({ ..., playerSkills })` option, usable by any future test.

- [ ] **Step 1: Add `getSkill` and the three weight consts to `REQUIRED_NAMES`**

  In `tests/helpers/load-scheduler.js:23-40`, add `'getSkill'`, `'SKILL_COMPLEMENT_WEIGHT'`, `'SKILL_TEAM_BALANCE_WEIGHT'`, `'SKILL_SINGLES_WEIGHT'` to the `REQUIRED_NAMES` array. (`getSkill` extracts fine via the existing `function NAME(` matcher in both forms — the SPA's zero-arg-closure version and the backends' two-arg version both match `function getSkill(`.)

- [ ] **Step 2: Add `playerSkills` to the sandbox preamble**

  In `buildSandbox()` (`tests/helpers/load-scheduler.js:126-143`), add `var playerSkills = {};` to the `preamble` string, alongside the existing `var rawPlayers = [];` etc.

- [ ] **Step 3: Add a `playerSkills` option to `generate()`**

  In `makeImplementation()`'s `generate({...})` (`tests/helpers/load-scheduler.js:182-211`), add `playerSkills = null` to the destructured options. For the `isClient` (SPA) branch, add `context.playerSkills = playerSkills || {};` alongside the other `context.*` assignments. For the backend branch, add `playerSkills || {}` as a new trailing element in the `call('generateRounds', [...])` array at line 200-207.

- [ ] **Step 4: Write the failing tests**

  Add a new `describe('skill balancing', ...)` block (or extend the existing per-implementation `describe`) in `tests/scheduling.test.js`, inside the `for (const impl of implementations)` loop, using a roster with a deliberate skill split, e.g.:
  ```js
  const SKILL_ROSTER = filler(12);
  const SKEWED_SKILLS = Object.fromEntries(SKILL_ROSTER.map((p, i) => [p, i < 6 ? 1 : 3]));
  ```
  Write four tests:
  1. `'pairs complementary-skill partners more than chance'` — generate several seeds with `playerSkills: SKEWED_SKILLS`, use a new `analyze.js` helper (Step 5) to compute the fraction of doubles partnerships that cross the 1/3 skill split, assert it's above a threshold measured in Step 6.
  2. `'keeps doubles teams closer in combined skill than unweighted'` — same roster, assert average `|teamASkillSum - teamBSkillSum|` across all doubles courts stays below a measured threshold.
  3. `'matches closer-skilled singles opponents when overflow exists'` — use a roster size that forces singles courts (e.g. `filler(13)` with a skewed skill split), assert average singles opponent skill diff stays below a measured threshold.
  4. `'conflicts still outrank skill complementarity'` — construct a roster where the conflict-group pair are also each other's only available complementary-skill match, run several seeds, and assert via the existing `conflictViolations` helper (from `analyze.js`) that it stays zero.

- [ ] **Step 5: Add skill-aware analysis helpers**

  In `tests/helpers/analyze.js`, add and export:
  ```js
  function doublesPartnerSkillDiffs(rounds, playerSkills) { /* returns array of |skillA - skillB| for every doubles partner pair across all rounds */ }
  function doublesTeamSkillSumDiffs(rounds, playerSkills) { /* returns array of |teamASum - teamBSum| per doubles court across all rounds */ }
  function singlesOpponentSkillDiffs(rounds, playerSkills) { /* returns array of |skillA - skillB| for every singles court across all rounds */ }
  ```
  Signature/shape only — bodies follow `courtPairs`'s existing iteration style in the same file.

- [ ] **Step 6: Run the tests, measure actual behavior, fill in thresholds**

  Run: `npm test`
  Expected initially: FAIL (thresholds are placeholders, e.g. `0`, until measured).
  Following the existing suite's documented methodology (`tests/scheduling.test.js:24-27`'s comment on `MAX_OPPONENT_STREAK` etc.), run the new tests against the actual implementation output, record the real numbers across the `quickSeeds`, and set each threshold to the measured value plus margin — adjusting `SKILL_COMPLEMENT_WEIGHT`/`SKILL_TEAM_BALANCE_WEIGHT`/`SKILL_SINGLES_WEIGHT` (currently `0.1` in all three files) if the measured effect is too weak relative to the existing repeat-pairing costs it competes with. Add a comment above the new tests recording what was measured, matching the existing style.

- [ ] **Step 7: Run full suite to verify no regressions**

  Run: `npm test`
  Expected: PASS, all existing and new tests, across all three implementations.

- [ ] **Step 8: Commit**

  ```bash
  git add tests/helpers/load-scheduler.js tests/helpers/analyze.js tests/scheduling.test.js
  git commit -m "test: add skill-balancing regression coverage"
  ```

---

### Task 5: i18n keys and documentation updates

**Files:**
- Modify: `index.html` (all 6 active language blocks — `en`, `zh-s`, `zh-t`, `ko`, `hi`, `fil`)
- Modify: `CLAUDE.md` (feature-flag table, `BRAND` config reference)

**Interfaces:**
- Consumes: none new.
- Produces: `t('skillTierLabel')`, `t('skillBeginner')`, `t('skillIntermediate')`, `t('skillAdvanced')` — consumed by Task 1's chip button title (already written assuming `skillTierLabel` exists).

- [ ] **Step 1: Add i18n keys to all 6 language blocks**

  Add `skillTierLabel`, `skillBeginner`, `skillIntermediate`, `skillAdvanced` keys to each of the 6 language object literals in `index.html` (find each block's start via `grep -n "^const i18n={en:\|^'zh-s':{\|^'zh-t':{\|^ *ko:{\|^ *hi:{\|^ *fil:{" index.html`). English wording: `skillTierLabel: 'Skill'`, `skillBeginner: 'Beginner'`, `skillIntermediate: 'Intermediate'`, `skillAdvanced: 'Advanced'`. Translate the other 5 blocks to match their existing tone/register.

- [ ] **Step 2: Add a `showSkillBalancing` flag to `BRAND` and update `CLAUDE.md`'s feature table**

  In `index.html`'s `BRAND` config (around line 559-561), add `showSkillBalancing:false` to the Courtly branch and `showSkillBalancing:true` to the Trulioo branch. Use this flag (instead of a raw `!IS_COURTLY` check) in Task 1 Step 4's chip-button gating, for consistency with how `showLeaderboard`/`multiSport` are modeled.

  Update the feature-comparison table in `CLAUDE.md`'s "Project Overview" section to add a row for skill balancing (yes for Trulioo, no for Courtly), matching the existing table's style.

- [ ] **Step 3: Manual verification**

  Switch languages in the running app and confirm the skill-button tooltip text updates per language.

- [ ] **Step 4: Commit**

  ```bash
  git add index.html CLAUDE.md
  git commit -m "feat: add skill-balancing i18n keys and BRAND flag"
  ```
