// Courtly serves the SPA from the Worker itself, so only index.html is exposed —
// unlike a static host pointed at the repo root, which would publish every file.
// This entry exists so the shared worker source and the Trulioo config stay
// untouched: the HTML import and its text rule live only on the Courtly side.
import worker, { handleGetSchedule, sportLabel } from './index.js';
import indexHtml from '../../index.html';
import ogCourtlyImage from '../../og-courtly.png';

export { ScheduleRoom } from './index.js';

const COURTLY_IMAGE_URL = 'https://courtly.ryanxu.dev/og-courtly.png';
const COURTLY_DESCRIPTION =
  'Fair rotations for badminton, pickleball, tennis, padel and table tennis. Paste your player list — everyone plays, partners change every round.';
const SCHEDULE_CODE_RE = /^BADM-[A-Z0-9]{4}$/;

// index.html ships with Trulioo's static meta values (they must be Trulioo's
// so link scrapers, which do not run JS, see the right product for the static
// file served as-is at trulioo-badminton.onrender.com). Courtly rewrites them
// here with a plain string replacement rather than templating the whole page,
// so a missing/renamed tag just leaves that value alone instead of throwing.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function setTitle(html, title) {
  return html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(title)}</title>`);
}

// attrMatch identifies the meta tag, e.g. property="og:title" or name="description".
// Assumes that attribute appears before content="..." in the tag, which is how
// index.html's tags are authored. If the tag isn't found, the html is returned
// unchanged rather than throwing.
function setMetaContent(html, attrMatch, value) {
  const re = new RegExp(`(<meta[^>]*${attrMatch}[^>]*content=")[^"]*(")`, 'i');
  if (!re.test(html)) return html;
  return html.replace(re, (_match, pre, post) => pre + escapeHtml(value) + post);
}

function applyCourtlyBrand(html) {
  let out = html;
  out = setTitle(out, 'Courtly — fair rotations for racquet sports');
  out = setMetaContent(out, 'property="og:site_name"', 'Courtly');
  out = setMetaContent(out, 'property="og:title"', 'Courtly');
  out = setMetaContent(out, 'name="twitter:title"', 'Courtly');
  out = setMetaContent(out, 'property="og:description"', COURTLY_DESCRIPTION);
  out = setMetaContent(out, 'name="twitter:description"', COURTLY_DESCRIPTION);
  out = setMetaContent(out, 'property="og:url"', 'https://courtly.ryanxu.dev');
  out = setMetaContent(out, 'property="og:image"', COURTLY_IMAGE_URL);
  out = setMetaContent(out, 'name="twitter:image"', COURTLY_IMAGE_URL);
  return out;
}

// Reuses index.js's own loadSchedule (via the already-exported handleGetSchedule
// handler) instead of duplicating the KV read here. handleGetSchedule only
// touches c.req.param('code') and c.env for a non-"current" code, so a minimal
// stand-in context is enough.
async function loadScheduleForPreview(env, code) {
  const fakeContext = {
    req: { param: (key) => (key === 'code' ? code : undefined) },
    env,
    json: (body) => ({ body }),
  };
  const result = await handleGetSchedule(fakeContext);
  return result && result.body && result.body.schedule ? result.body.schedule : null;
}

function buildScheduleMeta(schedule) {
  if (!schedule) return null;
  const playerCount = Array.isArray(schedule.players) ? schedule.players.length : null;
  const roundCount = Array.isArray(schedule.rounds) ? schedule.rounds.length : null;
  const courtCount = Number.isFinite(Number(schedule.numCourts)) ? Number(schedule.numCourts) : null;
  const generatedAt = schedule.generatedAt ? new Date(schedule.generatedAt) : null;
  if (playerCount == null || roundCount == null || courtCount == null || !generatedAt || Number.isNaN(generatedAt.getTime())) {
    return null;
  }
  const dateStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
  }).format(generatedAt);
  return {
    title: `${sportLabel(schedule.sport)} · ${playerCount} players`,
    description: `${playerCount} players · ${courtCount} courts · ${roundCount} rounds · ${dateStr}`,
  };
}

async function renderCourtlyHtml(request, env) {
  let html = applyCourtlyBrand(indexHtml);
  const scheduleCode = new URL(request.url).searchParams.get('scheduleCode');
  if (scheduleCode && SCHEDULE_CODE_RE.test(scheduleCode)) {
    // A broken preview must never break the page: any KV/lookup failure here
    // just leaves the generic Courtly card already applied above.
    try {
      const schedule = await loadScheduleForPreview(env, scheduleCode);
      const meta = buildScheduleMeta(schedule);
      if (meta) {
        html = setMetaContent(html, 'property="og:title"', meta.title);
        html = setMetaContent(html, 'name="twitter:title"', meta.title);
        html = setMetaContent(html, 'property="og:description"', meta.description);
        html = setMetaContent(html, 'name="twitter:description"', meta.description);
      }
    } catch (_err) {
      // fall through to the generic Courtly card
    }
  }
  return html;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // HEAD as well as GET: uptime monitors, link checkers and crawlers use HEAD,
    // and without it they fall through to the API's 404 and report the site down.
    const isPageRequest = request.method === 'GET' || request.method === 'HEAD';
    if (isPageRequest && url.pathname === '/og-courtly.png') {
      return new Response(ogCourtlyImage, {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
    }
    if (isPageRequest && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await renderCourtlyHtml(request, env);
      return new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=0, must-revalidate',
        },
      });
    }
    return worker.fetch(request, env, ctx);
  },
};
