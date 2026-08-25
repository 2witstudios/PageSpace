/**
 * parked-page — what the edge SERVES when it refuses to wake an app (pure).
 *
 * The parked page is the visible half of the enforcement decision, and it is
 * rendered HERE, at the router, from a self-contained string: no request to the
 * app, no request to the web app's renderer, no asset fetch. That is the point —
 * every one of those would either start the machine we are refusing to start, or
 * add a dependency to the one response that has to work when things are broken.
 *
 * No CSS file, no image, no script: a single inline-styled document, so the page
 * is exactly as reliable as the router itself.
 */

import type { AppRouteDecision } from './router-core';

/**
 * HTTP status per outcome.
 *
 * `parked` answers **402 Payment Required** — the one status that actually says
 * what happened. A 503 would be a lie the retry machinery believes: crawlers and
 * uptime monitors treat 503 as transient and come back, and each of those
 * requests would re-run the balance check for an account that is out of credits.
 * 402 is terminal-until-you-act, which is the truth, and it makes enforcement
 * countable in edge logs rather than blended into every other outage.
 *
 * `unavailable` IS transient (a deploy in flight, a failed provision awaiting the
 * reconciler), so it takes 503 plus a `Retry-After` — see {@link retryAfterFor}.
 */
export function statusCodeFor(decision: AppRouteDecision): number {
  switch (decision.kind) {
    case 'replay':
      return 204;
    case 'parked':
      return 402;
    case 'unavailable':
      return 503;
    case 'not_found':
      return 404;
  }
}

/** Seconds for `Retry-After`, or null when the outcome is not "come back later". */
export function retryAfterFor(decision: AppRouteDecision): number | null {
  if (decision.kind !== 'unavailable') return null;
  // A deploy is seconds-to-a-minute; a failed or destroying app is minutes at
  // best and is waiting on a human or a reconciler, so back the caller further
  // off rather than letting a monitor hammer a state no retry can change.
  return decision.reason === 'deploying' ? 15 : 120;
}

/** Escape text for interpolation into the HTML body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface PageCopy {
  title: string;
  heading: string;
  body: string;
}

function copyFor(decision: AppRouteDecision): PageCopy {
  switch (decision.kind) {
    case 'parked':
      return {
        title: 'App paused',
        heading: 'This app is paused',
        body:
          'It ran out of credits, so it has been stopped rather than left running. ' +
          'The owner can bring it back by topping up their PageSpace account — nothing has been lost.',
      };
    case 'unavailable':
      return decision.reason === 'deploying'
        ? {
            title: 'App starting',
            heading: 'This app is starting up',
            body: 'A new version is being deployed. Refresh in a few seconds.',
          }
        : {
            title: 'App unavailable',
            heading: 'This app is unavailable',
            body: 'It is not currently able to serve requests. Its owner has been able to see why.',
          };
    case 'not_found':
      return {
        title: 'No app here',
        heading: 'There is no app at this address',
        body: 'The address may be misspelled, or the app may have been unpublished.',
      };
    case 'replay':
      // Not rendered — a replay produces a bodiless response. Present so the
      // switch stays exhaustive under a future decision kind.
      return { title: 'Routing', heading: 'Routing', body: '' };
  }
}

/**
 * Render the router's own response body.
 *
 * `host` is echoed so an operator reading a screenshot knows which hostname
 * produced it; it is escaped because it comes from a request header.
 */
export function renderAppRouterPage(decision: AppRouteDecision, host: string): string {
  const { title, heading, body } = copyFor(decision);
  const safeHost = escapeHtml(host);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    title,
  )}</title></head><body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#fafafa;color:#1c1c1c;display:flex;min-height:100vh;align-items:center;justify-content:center"><main style="max-width:32rem;padding:2rem;text-align:center"><h1 style="font-size:1.5rem;font-weight:600;margin:0 0 .75rem">${escapeHtml(
    heading,
  )}</h1><p style="margin:0 0 1.5rem;line-height:1.6;color:#555">${escapeHtml(
    body,
  )}</p><p style="margin:0;font-size:.8125rem;color:#999"><code>${safeHost}</code></p></main></body></html>`;
}
