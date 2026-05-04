/**
 * Coverage gate for the post-login pending invitation acceptance contract.
 *
 * Every route under `apps/web/src/app/api/auth/**\/route.ts` that creates a
 * session via `sessionService.createSession` MUST also call
 * `acceptUserPendingInvitations` after the session is live so a user who has a
 * pending `drive_members` row gains access to the drive that invited them.
 *
 * Without this gate, future auth flows could be added that authenticate a user
 * but leave their pending invitations stuck — Epic 1's authz hardening
 * (`acceptedAt IS NOT NULL`) would then silently hide the drive from them.
 *
 * Refresh routes are explicitly allow-listed because they do not transition a
 * user from unauthenticated → authenticated; they merely re-issue a session
 * for an already-authenticated user. Service-token routes are similarly exempt
 * because they mint scoped tokens (e.g. websocket short-lived tokens) rather
 * than user login sessions.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const AUTH_ROUTES_ROOT = join(__dirname, '..');
const REPO_RELATIVE_ROOT = 'apps/web/src/app/api/auth';

// Paths are relative to the auth route root. Each entry MUST justify why the
// route is exempt — adding a new entry without a justification is a code-smell.
const ALLOW_LIST: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: 'ws-token/route.ts',
    reason: 'Mints a short-lived service token for the realtime websocket — not a user login session.',
  },
  {
    path: 'device/refresh/route.ts',
    reason: 'Refreshes an existing user session via device token; the user was already authenticated.',
  },
  {
    path: 'mobile/refresh/route.ts',
    reason: 'Refreshes an existing mobile session; the user was already authenticated.',
  },
];

const allowSet = new Set(ALLOW_LIST.map((entry) => entry.path));

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...findRouteFiles(full));
    } else if (entry === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

describe('post-login pending invite acceptance coverage gate', () => {
  it('every session-creating auth route calls acceptUserPendingInvitations (or is justified in the allow-list)', () => {
    const routes = findRouteFiles(AUTH_ROUTES_ROOT);
    const violations: string[] = [];

    for (const file of routes) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('sessionService.createSession')) continue;

      const relativePath = relative(AUTH_ROUTES_ROOT, file).replace(/\\/g, '/');
      if (allowSet.has(relativePath)) continue;

      if (!source.includes('acceptUserPendingInvitations')) {
        violations.push(`${REPO_RELATIVE_ROOT}/${relativePath}`);
      }
    }

    expect(
      violations,
      [
        'These auth routes create a session but do not call acceptUserPendingInvitations.',
        'Either wire the helper after createSession (and revoke + error on failure),',
        'or add the path to ALLOW_LIST in this test with a clear justification:',
        '',
        ...violations,
      ].join('\n')
    ).toEqual([]);
  });

  it('every allow-list entry maps to a real route file (no stale entries)', () => {
    for (const entry of ALLOW_LIST) {
      const full = join(AUTH_ROUTES_ROOT, entry.path);
      expect(
        () => readFileSync(full, 'utf8'),
        `Allow-list entry ${entry.path} does not exist at ${full}`
      ).not.toThrow();
    }
  });
});
