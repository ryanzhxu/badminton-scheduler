// Courtly serves the SPA from the Worker itself, so only index.html is exposed —
// unlike a static host pointed at the repo root, which would publish every file.
// This entry exists so the shared worker source and the Trulioo config stay
// untouched: the HTML import and its text rule live only on the Courtly side.
import worker from './index.js';
import indexHtml from '../../index.html';

export { ScheduleRoom } from './index.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // HEAD as well as GET: uptime monitors, link checkers and crawlers use HEAD,
    // and without it they fall through to the API's 404 and report the site down.
    const isPageRequest = request.method === 'GET' || request.method === 'HEAD';
    if (isPageRequest && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(indexHtml, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=0, must-revalidate',
        },
      });
    }
    return worker.fetch(request, env, ctx);
  },
};
