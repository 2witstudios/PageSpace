/** Asset/font directives shared by every canvas/published CSP variant. */
const ASSET_CSP_PREFIX =
  "default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;";

/**
 * Builds the canvas baseline CSP, optionally scoping `form-action`/`connect-src`
 * to a single origin so a published Canvas page's <form> (see
 * `../forms/form-html.ts`) can submit to the app's own public forms endpoint.
 *
 * With no origin, behavior is unchanged from the original constant:
 * `form-action 'none'` and no `connect-src` directive at all (so `fetch()`
 * stays blocked by `default-src 'none'`). Never widens to a wildcard — only
 * ever the single origin passed in.
 */
export function buildBaselineCsp(formActionOrigin?: string): string {
  const base = `${ASSET_CSP_PREFIX} script-src 'unsafe-inline'; object-src 'none'; base-uri 'none';`;

  if (!formActionOrigin) {
    return `${base} form-action 'none'`;
  }

  return `${base} form-action 'self' ${formActionOrigin}; connect-src ${formActionOrigin}`;
}

/**
 * Builds the CSP for canvas pages in SITE MODE (`pages.siteMode`) — the policy that
 * lets a canvas page behave like an ordinary production website.
 *
 * The baseline above is a *document* policy: `script-src 'unsafe-inline'` names no
 * host, so no CDN `<script src>` loads, and the absence of `connect-src` falls back
 * to `default-src 'none'`, so `fetch`/XHR/WebSocket/`sendBeacon` are all dead. That
 * is right for a rendered document and wrong for a site that wants React from a CDN
 * and an API call.
 *
 * Site mode therefore opens the fetch directives to `https:` (plus `wss:` for
 * websockets, and `blob:`/`data:` for content the page generates client-side).
 * Two things stay pinned, because a website has no legitimate need for either and
 * both are classic injection sinks:
 *
 *  - `object-src 'none'` — no `<object>`/`<embed>` plugin content;
 *  - `base-uri 'none'` — author markup can never retarget relative URL resolution.
 *
 * `default-src 'none'` is likewise kept as the deny-by-default floor, so any
 * directive NOT named here stays blocked rather than inheriting a permissive
 * default. `form-action` opens to `https:` so a site can post to its own backend,
 * a third-party form service, or the PageSpace forms endpoint alike.
 *
 * Deliberately NOT included: `'unsafe-eval'`. Loading libraries from a CDN does not
 * require it — only `eval`/`new Function` do — so it stays off until something
 * concretely needs it.
 *
 * Unlike `buildBaselineCsp` this takes no form-action origin: `form-action https:`
 * already covers every origin such a parameter could name.
 */
export function buildSiteCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' https:",
    'connect-src https: wss:',
    'img-src https: data: blob:',
    "style-src 'unsafe-inline' https:",
    'font-src https: data:',
    'media-src https: blob:',
    'frame-src https:',
    'worker-src https: blob:',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self' https:",
  ].join('; ');
}

/**
 * Builds the CSP for published DOCUMENT pages (see `../publish/render-document-page.ts`).
 * Unlike canvas pages, documents never run author scripts — the sanitizer
 * (`sanitizeDocumentHtml`) already strips `<script>` tags, and this policy is
 * the hard enforcement layer: `script-src 'none'` blocks any that slip
 * through, and `form-action 'none'` blocks form submission entirely (the
 * sanitizer also strips `<form>`). Every other baseline directive (asset/
 * font/image hosts, `object-src`, `base-uri`) is unchanged from
 * `buildBaselineCsp()`.
 */
export function buildDocumentCsp(): string {
  return `${ASSET_CSP_PREFIX} script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
}

/**
 * The policy a canvas page's own document carries, chosen by the page's site-mode
 * flag — the one place that choice is made.
 *
 * Exported because the preview route has to build its RESPONSE HEADER from the
 * same choice `renderCanvasDocument` makes for the document's `<meta>`. Browsers
 * enforce the INTERSECTION of every policy delivered, so two hand-copied
 * ternaries silently withhold whatever the copies disagree about, with no error
 * anywhere. One expression, two callers.
 *
 * The flag is optional because `renderCanvasDocument` takes it that way — an
 * absent flag is not site mode, so it can never fall through to the permissive
 * policy.
 */
export function buildCanvasCsp(siteMode?: boolean, formActionOrigin?: string): string {
  return siteMode ? buildSiteCsp() : buildBaselineCsp(formActionOrigin);
}
