// Single source of truth for the in-app canvas PREVIEW request path, which
// returns a full HTML document carrying its OWN Content-Security-Policy (see
// `@pagespace/lib/canvas/preview-headers`). The edge middleware reads this to:
//
//   1. skip its restrictive API CSP, so that policy doesn't intersect with — and
//      clobber — the route's own (browsers enforce the intersection of every CSP
//      header delivered); and
//   2. relax `X-Frame-Options` from DENY to SAMEORIGIN, because the dashboard
//      frames this route itself. DENY blocks framing even same-origin, so
//      without this the preview renders as a blank frame.
//
// Pure leaf (no imports) so it stays safe to pull into the Edge-runtime
// middleware graph — same rationale as the token-prefixes and handoff-bridge
// leaves.
//
// Anchored on both ends: only `/api/canvas/<id>/preview` matches, and the id
// segment may not contain a slash, so no deeper path can masquerade as the
// preview route and inherit its relaxed framing.
const CANVAS_PREVIEW_PATH = /^\/api\/canvas\/[^/]+\/preview$/;

export const isCanvasPreviewRoute = (pathname: string): boolean =>
  CANVAS_PREVIEW_PATH.test(pathname);
