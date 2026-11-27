export const MAX_COURTS_SHOWN = 3;
export const MAX_AVATARS_SHOWN = 6;

// Inlined from index.js's SPORTS/SPORT_LABELS/sportLabel rather than imported:
// Task 3 added `import { ImageResponse } from 'workers-og'` to index.js, so
// importing anything from index.js now transitively pulls in workers-og,
// which isn't resolvable from plain `node --test` outside worker/'s own
// node_modules. This keeps og-card.js's zero-Workers-dependency guarantee.
const SPORTS = ['badminton', 'pickleball', 'tennis', 'padel', 'tabletennis'];
const SPORT_LABELS = {
  badminton: 'Badminton',
  pickleball: 'Pickleball',
  tennis: 'Tennis',
  padel: 'Padel',
  tabletennis: 'Table tennis',
};
function sportLabel(value) {
  const v = String(value || '').trim().toLowerCase();
  return SPORT_LABELS[SPORTS.includes(v) ? v : ''] || 'Rotation';
}

function formatDateLabel(generatedAt) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(generatedAt));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Each player name is escaped individually, then joined with a literal,
// program-controlled ' & ' separator -- escaping the already-joined string
// instead would also escape that trusted separator's own '&', breaking the
// display string for every doubles team (any 2-player team name contains one).
function joinTeamNames(names) {
  return names.map(escapeHtml).join(' & ');
}

export function buildOgCardData(schedule) {
  if (!schedule?.rounds?.[0] || !Array.isArray(schedule?.players)) return null;

  const roundCourts = schedule.rounds[0].courts;
  const courts = roundCourts.slice(0, MAX_COURTS_SHOWN).map((court) => ({
    teamA: joinTeamNames(court.a),
    teamB: joinTeamNames(court.b),
  }));
  const overflowCourtCount = Math.max(0, roundCourts.length - MAX_COURTS_SHOWN);

  const avatars = schedule.players.slice(0, MAX_AVATARS_SHOWN).map((name, index) => ({
    initial: escapeHtml(name.trim()[0].toUpperCase()),
    color: index % 2 === 0 ? 'green' : 'blue',
  }));
  const overflowPlayerCount = Math.max(0, schedule.players.length - MAX_AVATARS_SHOWN);

  return {
    roundLabel: `ROUND 1 OF ${schedule.rounds.length}`,
    dateLabel: formatDateLabel(schedule.generatedAt),
    courts,
    overflowCourtCount,
    avatars,
    overflowPlayerCount,
    playingCount: schedule.players.length,
  };
}

function formatMetaDateStr(generatedAt) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
  }).format(new Date(generatedAt));
}

// Values below are lifted from docs/superpowers/specs/assets/2026-11-26-trulioo-link-preview-card/approved-mockup.html's
// `.B`/`.B-*`/`.avatar*` rules, doubled from that mockup's 600x315 display
// scale to this card's real 1200x630 canvas. workers-og needs explicit pixel
// sizing on the root (percentage sizing left most of the canvas blank in
// Task 1's spike) and has no CSS pseudo-element support, so the `.B-vs`
// divider lines are built from real child elements instead of ::before/::after.
// Every single <div> below declares display:flex, including ones with a
// single text child and ones with NO children at all (the divider lines, the
// logo dot). workers-og@0.0.27's HTML-string parser always represents a
// div's children as an array -- even an empty one, which is still truthy in
// JS -- never collapsing to a bare string (for one text child) or to
// undefined (for none) the way JSX does. Satori's "a <div> with more than
// one child must declare display:flex or display:none" check reads that
// truthy non-string children value as "more than one child" regardless of
// the actual count, so it fires for every div here, not just ones that
// visually need flex layout. Confirmed by bisecting down to a two-node repro
// during Task 3. <span> is not subject to this and needs no such declaration.
function renderCourtBlock(court) {
  return `<div style="flex:1;background:rgba(255,255,255,.06);border:2px solid rgba(255,255,255,.14);border-radius:20px;padding:24px;display:flex;flex-direction:column;justify-content:center;min-width:0">`
    + `<div style="display:flex;font-size:19px;font-weight:700;color:#8fb8ae;text-transform:uppercase;letter-spacing:.05em;margin-bottom:16px">COURT</div>`
    + `<div style="display:flex;font-size:29px;font-weight:700;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${court.teamA}</div>`
    + `<div style="display:flex;align-items:center;gap:14px;margin:8px 0">`
      + `<div style="display:flex;flex:1;height:2px;background:rgba(255,255,255,.18)"></div>`
      + `<span style="font-size:18px;font-weight:800;color:#F7C11B">VS</span>`
      + `<div style="display:flex;flex:1;height:2px;background:rgba(255,255,255,.18)"></div>`
    + `</div>`
    + `<div style="display:flex;font-size:29px;font-weight:700;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${court.teamB}</div>`
    + `</div>`;
}

function renderOverflowCourtTile(overflowCourtCount) {
  return `<div style="flex:0 0 152px;background:rgba(255,255,255,.1);border:2px dashed rgba(255,255,255,.3);border-radius:20px;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;color:#F7C11B;text-align:center;line-height:1.2;padding:0 12px">+${overflowCourtCount} courts</div>`;
}

function renderAvatar(avatar, isFirst) {
  const isGreen = avatar.color === 'green';
  const background = isGreen ? '#D5EBDB' : '#D3EDF6';
  const color = isGreen ? '#004C45' : '#128BA6';
  const ringColor = isGreen ? '#c9e3d1' : '#a9d6e8';
  const marginLeft = isFirst ? '0' : '-12px';
  return `<div style="width:48px;height:48px;border-radius:50%;background:${background};color:${color};font-size:20px;font-weight:700;display:flex;align-items:center;justify-content:center;border:3px solid #172D2D;box-shadow:0 0 0 2px ${ringColor};margin-left:${marginLeft}">${avatar.initial}</div>`;
}

function renderOverflowAvatar(overflowPlayerCount) {
  return `<div style="width:48px;height:48px;border-radius:50%;background:#ddd;color:#555;font-size:19px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-left:-12px">+${overflowPlayerCount}</div>`;
}

export function renderOgCardHtml(cardData) {
  const courtBlocks = cardData.courts.map(renderCourtBlock).join('');
  const overflowCourtTile = cardData.overflowCourtCount > 0 ? renderOverflowCourtTile(cardData.overflowCourtCount) : '';

  const avatarCircles = cardData.avatars.map((avatar, i) => renderAvatar(avatar, i === 0)).join('');
  const overflowAvatar = cardData.overflowPlayerCount > 0 ? renderOverflowAvatar(cardData.overflowPlayerCount) : '';

  return `<div style="display:flex;flex-direction:column;width:1200px;height:630px;background:#172D2D;color:#fff">`
    + `<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:32px 48px 0">`
      + `<div style="display:flex;align-items:center;gap:16px">`
        + `<div style="display:flex;width:18px;height:18px;border-radius:50%;background:#F7C11B"></div>`
        + `<div style="display:flex;color:#fff;font-weight:800;font-size:30px">Courtly</div>`
      + `</div>`
      + `<div style="display:flex;flex-direction:column;align-items:flex-end;text-align:right">`
        + `<div style="display:flex;color:#F7C11B;font-size:24px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;line-height:1.3">${escapeHtml(cardData.roundLabel)}</div>`
        + `<div style="display:flex;color:#9fc2b9;font-size:22px;font-weight:600;margin-top:4px">${escapeHtml(cardData.dateLabel)}</div>`
      + `</div>`
    + `</div>`
    + `<div style="flex:1;display:flex;padding:28px 40px;gap:24px">${courtBlocks}${overflowCourtTile}</div>`
    + `<div style="background:rgba(0,0,0,.22);padding:20px 40px;display:flex;align-items:center;justify-content:space-between">`
      + `<div style="display:flex">${avatarCircles}${overflowAvatar}</div>`
      + `<div style="display:flex;font-size:23px;color:#cfe3de;font-weight:600">${cardData.playingCount} playing tonight</div>`
    + `</div>`
    + `</div>`;
}

export function buildCardMetaText(schedule) {
  if (!schedule?.rounds?.[0] || !Array.isArray(schedule?.players)) return null;

  const playerCount = schedule.players.length;
  const dateStr = formatMetaDateStr(schedule.generatedAt);
  return {
    title: `${sportLabel(schedule.sport)} · ${playerCount} players`,
    description: `${playerCount} players · ${schedule.numCourts} courts · ${schedule.rounds.length} rounds · ${dateStr}`,
  };
}
