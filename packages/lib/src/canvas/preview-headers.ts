/**
 * Pure builder for the in-app canvas PREVIEW response headers.
 *
 * Why this exists at all: the in-app canvas frame used to be rendered with
 * `srcDoc`, and a `srcDoc` frame inherits the embedder's CSP. The dashboard's
 * policy is nonce-based with a narrow `connect-src`, so a site-mode page's
 * `fetch()` would work once published and die in the preview — the author would
 * be building against a different platform than the one they ship on. Serving
 * the document from a real URL instead gives the frame its OWN policy, with
 * nothing inherited.
 *
 * That fix has a sharp edge. The route runs under middleware `skipCSP`, which
 * suppresses the app's Content-Security-Policy so the route's own policy is
 * authoritative — which means a MISSING policy here is not a weaker policy, it
 * is NO policy, on a document that runs author-supplied script. That failure
 * mode is silent and fails open.
 *
 * So this returns `null` for a blank policy and the caller refuses to respond.
 * A broken preview is an acceptable failure; an unpoliced frame is not.
 */
export function buildPreviewResponseHeaders(csp: string): Readonly<Record<string, string>> | null {
  const policy = csp.trim();
  if (!policy) return null;

  return Object.freeze({
    'Content-Type': 'text/html; charset=utf-8',
    // The author's policy verbatim, plus the one directive that must differ from
    // the published artifact: published pages are top-level documents (the edge
    // gives them `frame-ancestors 'none'`), while the preview exists precisely to
    // be framed — but only ever by the dashboard itself. Every FETCH directive is
    // preserved byte-for-byte, which is what preview/production parity means.
    'Content-Security-Policy': `${policy.replace(/;\s*$/, '')}; frame-ancestors 'self'`,
    // Per-viewer content sitting behind a permission check: never store it in a
    // shared cache, so one viewer's copy can never be served to another.
    'Cache-Control': 'no-store, private',
  });
}
