/**
 * Single source of truth for `/.well-known/*` routes rewritten to routable
 * API paths. Next.js App Router does not route dot-prefixed folders under
 * app/, so any `/.well-known/*` handler must live at a normal path and be
 * reached via a next.config.ts rewrite of its public URL.
 *
 * Both next.config.ts (which registers the rewrite) and middleware.ts (which
 * must let the request through unauthenticated, since it runs on the
 * pre-rewrite pathname) import this list, so a new well-known route can't be
 * wired into one and forgotten in the other.
 */
export const WELL_KNOWN_REWRITES = [
  {
    source: '/.well-known/oauth-authorization-server',
    destination: '/api/well-known/oauth-authorization-server',
  },
] as const;
