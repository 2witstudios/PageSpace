/**
 * The preview FRAME's contract — the pieces every surface that mounts the
 * preview iframe needs, and nothing else. Split out of the pane so a caller
 * (and a test) can reason about the frame without importing a component.
 *
 * THE FRAME. Its `src` is the APP-ORIGIN `/preview/open` route for the
 * reader (session or env). That route authenticates, runs the drive/session
 * gate, mints a single-use grant and 302s to the holder's dedicated preview
 * origin, whose auth endpoint installs a host-only partitioned cookie and
 * 302s to `/` — the frame does the rest, and root-relative URLs resolve
 * against the preview origin, so a real Vite/Next dev server just works. The
 * app's CSP `frame-src` admits `*.preview.<apex>` only when the feature is
 * configured, which is also the only time the pane can render (the
 * capability gate). `referrerPolicy="no-referrer"` keeps the app URL out of
 * the dev server's logs.
 *
 * SANDBOX ALLOW-LIST. The frame runs agent-authored (or npm-supply-chain)
 * code, so it gets exactly what a dev server needs and nothing that reaches
 * the PageSpace tab: `allow-scripts allow-same-origin allow-forms
 * allow-popups allow-modals`. `allow-same-origin` grants the frame ITS OWN
 * preview origin (not the parent's — it is cross-site by design), which is
 * what lets the partitioned cookie flow; without it the frame is an opaque
 * origin, sends no cookie and renders nothing. Withheld on purpose:
 * `allow-top-navigation` (and the `-by-user-activation` form — one in-frame
 * click must not be able to `top.location` the dashboard away),
 * `allow-downloads`, `allow-popups-to-escape-sandbox` (a popup the frame
 * opens stays sandboxed), `allow-pointer-lock`, `allow-orientation-lock`.
 *
 * RE-AUTH. The preview origin's cookie is short-lived; when it expires inside
 * the frame the origin renders a page that posts
 * `{ type: 'pagespace:dev-preview', event: 'reauth-required', holder }` to
 * this window (contract from the proxy task). The pane accepts it ONLY from
 * its own frame (`event.source === iframe.contentWindow`), only about ITS
 * holder, and at most once per {@link REAUTH_DEBOUNCE_MS} — every accepted
 * message costs a grant row on the server, so a page spamming it must not
 * be able to mint one per tick. Anything else is ignored — the frame's
 * content is untrusted code.
 *
 * OPEN IN NEW TAB is a plain link to the SAME `/preview/open` route with
 * `target="_blank"`: a top-level navigation, where the partitioned cookie does
 * not carry, so the route mints a fresh grant for that context (already
 * supported and tested server-side). `rel="noopener"` so the dev server's
 * tab holds no handle to PageSpace.
 */

/** The open pane polls faster than the affordance: its chrome should notice a relay crash within a few seconds. */
export const PANE_POLL_MS = 5_000;

/** A re-auth is a grant mint; one per this window is plenty for a cookie that lives ten minutes. */
export const REAUTH_DEBOUNCE_MS = 5_000;

/** Exactly what a dev server needs inside the frame, and nothing that reaches the PageSpace tab — see the docblock. */
export const DEV_PREVIEW_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals';

/** Pure: the frame URL for a reload nonce — a changed query string forces a fresh navigation through the handshake. */
export function buildFrameSrc(openPath: string, nonce: number): string {
  return nonce === 0 ? openPath : `${openPath}${openPath.includes('?') ? '&' : '?'}r=${nonce}`;
}
