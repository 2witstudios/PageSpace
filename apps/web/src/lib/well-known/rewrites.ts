/**
 * Single source of truth for `/.well-known/*` routes (and `/auth.md`)
 * rewritten to routable API paths. Next.js App Router does not route dot-prefixed folders under
 * app/, so any `/.well-known/*` handler must live at a normal path and be
 * reached via a next.config.ts rewrite of its public URL.
 *
 * Both next.config.ts (which registers the rewrite) and middleware.ts (which
 * must let the request through unauthenticated, since it runs on the
 * pre-rewrite pathname) import this list, so a new well-known route can't be
 * wired into one and forgotten in the other.
 *
 * `source` must stay a literal path, not a Next.js rewrite pattern
 * (`:param`, `*`, etc.) — middleware.ts matches it with `===`, not
 * path-to-regexp, since every `/.well-known/*` URL is a fixed, spec-defined
 * path with no dynamic segments.
 */
export const WELL_KNOWN_REWRITES = [
  {
    source: '/.well-known/oauth-authorization-server',
    destination: '/api/well-known/oauth-authorization-server',
  },
  // Not under /.well-known/, but the same shape: a fixed, public discovery
  // document an agent fetches before it has any identity (ADR 0007 Decision 12,
  // the auth.md recipe). A `.md` path would otherwise be looked up as a static
  // file; the middleware rewrite reaches the handler first.
  {
    source: '/auth.md',
    destination: '/api/well-known/auth-md',
  },
] as const;
