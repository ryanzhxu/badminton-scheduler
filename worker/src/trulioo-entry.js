// Trulioo's frontend is a static file on Render (trulioo-badminton.onrender.com)
// with no server-side logic, so it can never show a dynamic link-preview card --
// a static host serves one file to everyone, crawler or human, with no way to
// vary it per request. This entry exists to give Trulioo a dynamic card anyway:
// it becomes the *shared* link instead (same path/query shape, different host),
// serves a tiny server-rendered page with schedule-aware og:/twitter: tags for
// crawlers, then bounces real browsers on to the real Render-hosted app.
// Mirrors courtly-entry.js's wrap-and-fall-through shape, but Courtly rewrites
// its own already-served SPA in place; this file has no SPA of its own to serve.
import worker, { loadSchedule, loadCurrentSchedule } from './index.js';
import { buildOgCardData, buildCardMetaText } from './og-card.js';

export { ScheduleRoom } from './index.js';

const RENDER_APP_URL = 'https://trulioo-badminton.onrender.com';
const WORKER_ORIGIN = 'https://trulioo.courtly.ryanxu.dev';
// Admits the literal "current" pseudo-code alongside real codes -- unlike
// courtly-entry.js's copy of this pattern, which doesn't need to, since
// Courtly 404s "current" in public mode regardless.
const SCHEDULE_CODE_RE = /^(current|BADM-[A-Z0-9]{4})$/;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function buildRedirectUrl(code) {
  return `${RENDER_APP_URL}/?scheduleCode=${encodeURIComponent(code)}`;
}

async function renderLandingPage(request, env, code) {
  try {
    const schedule = code === 'current' ? await loadCurrentSchedule(env) : await loadSchedule(env, code);
    const cardData = buildOgCardData(schedule);
    const meta = buildCardMetaText(schedule);
    if (!cardData || !meta) return null;

    const pageUrl = `${WORKER_ORIGIN}/?scheduleCode=${encodeURIComponent(code)}`;
    const imageUrl = `${WORKER_ORIGIN}/api/schedule/${encodeURIComponent(code)}/og.png`;
    const redirectUrl = buildRedirectUrl(code);
    const title = escapeHtml(meta.title);
    const description = escapeHtml(meta.description);

    return `<!DOCTYPE html><html lang="en"><head>`
      + `<meta charset="UTF-8">`
      + `<meta http-equiv="refresh" content="0;url=${escapeHtml(redirectUrl)}">`
      + `<title>${title}</title>`
      + `<meta property="og:site_name" content="Courtly">`
      + `<meta property="og:title" content="${title}">`
      + `<meta name="twitter:title" content="${title}">`
      + `<meta property="og:description" content="${description}">`
      + `<meta name="twitter:description" content="${description}">`
      + `<meta property="og:url" content="${escapeHtml(pageUrl)}">`
      + `<meta property="og:image" content="${escapeHtml(imageUrl)}">`
      + `<meta name="twitter:image" content="${escapeHtml(imageUrl)}">`
      + `<meta property="og:image:width" content="1200">`
      + `<meta property="og:image:height" content="630">`
      + `<meta name="twitter:card" content="summary_large_image">`
      + `</head><body>`
      + `<a href="${escapeHtml(redirectUrl)}">Continue to Courtly</a>`
      + `</body></html>`;
  } catch (_err) {
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isPageRequest = request.method === 'GET' || request.method === 'HEAD';
    if (isPageRequest && (url.pathname === '/' || url.pathname === '/index.html')) {
      const code = url.searchParams.get('scheduleCode');
      if (code && SCHEDULE_CODE_RE.test(code)) {
        const html = await renderLandingPage(request, env, code);
        if (html) {
          return new Response(html, {
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'public, max-age=0, must-revalidate',
            },
          });
        }
        return Response.redirect(buildRedirectUrl(code), 302);
      }
      return Response.redirect(`${RENDER_APP_URL}/`, 302);
    }
    return worker.fetch(request, env, ctx);
  },
};
