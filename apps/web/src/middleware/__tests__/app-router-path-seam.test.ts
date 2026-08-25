/**
 * The middleware carve-out has to name the route that actually exists.
 *
 * `APP_ROUTER_ROUTE_PATH` is the ONLY thing tying two independent decisions
 * together: middleware.ts exempts that path from the session check, and
 * `routeOwnsItsOwnCsp` exempts it from the API CSP. Because the exemption
 * removes authentication entirely for that path, the route's own shared-secret
 * check is the only gate left — so the constant pointing at the wrong place is
 * not a cosmetic bug in either direction:
 *
 *   • constant BROADER than the route → more paths lose their session check.
 *     Covered by middleware.test.ts's sibling-path test.
 *   • constant no longer matching the route's location → the real endpoint is
 *     401'd by middleware and every published app goes dark. NOT covered
 *     anywhere, because the route's own tests invoke the handler directly and
 *     never traverse middleware.
 *
 * And every middleware suite `vi.mock`s this constant to a literal, so none of
 * them would notice the real one changing. This file deliberately imports the
 * REAL constant and checks it against the filesystem.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { APP_ROUTER_ROUTE_PATH } from '../security-headers';

describe('APP_ROUTER_ROUTE_PATH names a route that exists', () => {
  it('given the carve-out path, should find a route handler at exactly that location', () => {
    // App Router maps /api/x/y to src/app/api/x/y/route.ts.
    //
    // Resolved from `__dirname`, NOT `process.cwd()`: this file sits at a known
    // place in the tree, whereas the working directory depends on how the suite
    // was invoked — `bun run --filter web test` and CI's `turbo run` do not agree
    // about it. A cwd-relative path would make this assertion pass or fail on the
    // invocation rather than on the thing it is supposed to be checking. Matches
    // how `api/__tests__/security-audit-coverage.test.ts` walks the route tree.
    const handler = join(__dirname, '../../app', APP_ROUTER_ROUTE_PATH, 'route.ts');

    expect(existsSync(handler)).toBe(true);
  });

  // Pins the shape too: a constant that stopped being an absolute /api path
  // would still "exist" under some join and quietly stop matching `pathname`.
  it('given the constant, should be an absolute /api path with no trailing slash', () => {
    expect(APP_ROUTER_ROUTE_PATH.startsWith('/api/')).toBe(true);
    expect(APP_ROUTER_ROUTE_PATH.endsWith('/')).toBe(false);
  });
});
