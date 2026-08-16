/**
 * The docs and blog are no longer routes in this app.
 *
 * They are published PageSpace drives served from object storage at their own
 * hosts, so every link to them from the marketing site is now cross-origin and
 * must be absolute — a bare `/docs/...` would resolve against pagespace.ai and
 * hit the edge 301 instead of going straight to the destination.
 *
 * `NEXT_PUBLIC_*` values are baked in at build time (see the build args in
 * PageSpace-Deploy/.github/workflows/docker-images.yml); the defaults are the
 * production hosts, so nothing has to be configured for a normal build.
 */

export const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? 'https://docs.pagespace.ai';
export const BLOG_URL = process.env.NEXT_PUBLIC_BLOG_URL ?? 'https://blog.pagespace.ai';

/** `docsUrl('/features/cli')` → `https://docs.pagespace.ai/features/cli`. */
export const docsUrl = (path = '') => `${DOCS_URL}${path}`;

/** `blogUrl('/some-post')` → `https://blog.pagespace.ai/some-post`. */
export const blogUrl = (path = '') => `${BLOG_URL}${path}`;
