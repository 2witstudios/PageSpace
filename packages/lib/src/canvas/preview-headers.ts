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

/**
 * Sandbox tokens applied to the preview RESPONSE.
 *
 * ⚠️ SECURITY-CRITICAL: NEVER add `allow-same-origin`.
 *
 * Deliberately identical to `CANVAS_IFRAME_SANDBOX` (the frame attribute), so the
 * document behaves the same however it is loaded. That matters because the
 * preview lives at a real, authenticated, same-origin url: the iframe's
 * `sandbox` ATTRIBUTE does not travel with the response, so a direct navigation
 * would otherwise run author script as a first-party document on the app origin,
 * holding the viewer's cookies — stored XSS. Author JS can reach that state
 * unaided, since the frame is granted `allow-popups-to-escape-sandbox` and can
 * therefore `window.open()` this very url into an unsandboxed tab.
 *
 * Declaring the sandbox on the response makes the isolation a property of the
 * DOCUMENT rather than of one particular embedding. `allow-popups-to-escape-sandbox`
 * stays safe here precisely because of that: a popup pointed back at this route
 * receives this same header and is re-sandboxed, while an external link still
 * opens as a normal working tab.
 */
export const PREVIEW_SANDBOX_TOKENS = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';

export function buildPreviewResponseHeaders(csp: string): Readonly<Record<string, string>> | null {
  const policy = csp.trim();
  if (!policy) return null;

  return Object.freeze({
    'Content-Type': 'text/html; charset=utf-8',
    // The author's policy verbatim, plus the two directives that must differ from
    // the published artifact:
    //
    //  - `frame-ancestors 'self'`: published pages are top-level documents (the
    //    edge gives them `frame-ancestors 'none'`), while the preview exists
    //    precisely to be framed — but only ever by the dashboard itself.
    //  - `sandbox`: a published page is served from its own origin, so it is
    //    already walled off from the app session; the preview is same-origin and
    //    needs the sandbox to reach the same isolation. See PREVIEW_SANDBOX_TOKENS.
    //
    // Every FETCH directive is preserved byte-for-byte, which is what
    // preview/production parity means.
    'Content-Security-Policy':
      `${policy.replace(/;\s*$/, '')}; frame-ancestors 'self'; sandbox ${PREVIEW_SANDBOX_TOKENS}`,
    // Per-viewer content sitting behind a permission check: never store it in a
    // shared cache, so one viewer's copy can never be served to another.
    'Cache-Control': 'no-store, private',
  });
}
