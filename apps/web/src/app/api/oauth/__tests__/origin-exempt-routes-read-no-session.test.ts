/**
 * `/api/oauth/token` and `/api/oauth/revoke` are exempt from middleware origin
 * validation and answer cross-origin with CORS (ADR 0004 Decision 9,
 * `CROSS_ORIGIN_READABLE_OAUTH_PATHS` in `apps/web/src/middleware.ts`).
 *
 * That exemption is safe for exactly one reason: neither handler reads a
 * cookie or a session. Both authenticate with credentials in the request BODY
 * (PKCE verifier, single-use code, refresh token, device_code), which a
 * cross-site form cannot forge. The day either route consults ambient
 * credentials, the exemption becomes a CSRF hole — so this fails first.
 */

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const OAUTH_API_DIR = join(__dirname, '..');

const ORIGIN_EXEMPT_ROUTES = ['token/route.ts', 'revoke/route.ts'];

/** Every way a route handler reaches ambient (cookie/session) credentials. */
const AMBIENT_CREDENTIAL_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['cookies', /\bcookies\b/],
  ['getSessionFromCookies', /\bgetSessionFromCookies\b/],
  ['sessionService', /\bsessionService\b/],
  ['authenticateRequest* (any)', /\bauthenticate\w*Request\w*\b/],
  ["a 'session' allow-list", /allow\s*:\s*\[[^\]]*['"]session['"]/],
  ['verifyAuth', /\bverifyAuth\b/],
  ['a Cookie header read', /headers\.get\(\s*['"]cookie['"]\s*\)/i],
];

/** Comments may explain the invariant; only code may not break it. */
function code(file: string): string {
  return readFileSync(join(OAUTH_API_DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('origin-exempt OAuth routes read no cookie or session', () => {
  for (const route of ORIGIN_EXEMPT_ROUTES) {
    for (const [label, pattern] of AMBIENT_CREDENTIAL_PATTERNS) {
      it(`${route} never references ${label}`, () => {
        expect(code(route)).not.toMatch(pattern);
      });
    }
  }

  it('the exemption list in middleware is exactly these two routes (a Set of exact paths, never a prefix)', () => {
    const middleware = readFileSync(join(OAUTH_API_DIR, '..', '..', '..', 'middleware.ts'), 'utf8');
    const declaration = middleware.match(/const CROSS_ORIGIN_READABLE_OAUTH_PATHS[^=]*=\s*new Set\(\[([^\]]*)\]\)/);

    expect(declaration).not.toBeNull();
    const paths = declaration![1].split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();
    expect(paths).toEqual(['/api/oauth/revoke', '/api/oauth/token']);
  });
});
