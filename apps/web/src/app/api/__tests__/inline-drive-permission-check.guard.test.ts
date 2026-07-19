/**
 * Inline Drive-Permission-Check Guard
 *
 * The permissions-hardening pass centralized the "is this user an accepted
 * owner/admin/member of this drive" question into a small set of shared
 * functions — `isDriveOwnerOrAdmin` / `isUserDriveMember`
 * (packages/lib/src/permissions/permissions.ts), `getDriveAccessLevel`
 * (packages/lib/src/permissions/drive-access-level.ts), and the
 * `driveMembers`-list helpers in packages/lib/src/services/drive-member-service.ts.
 *
 * Before centralization, `pages/bulk-copy`, `pages/bulk-move`,
 * `account/handle-drive`, and `pages/tree` each rolled their own copy of the
 * same `db.select().from(driveMembers).where(and(eq(role,'ADMIN'), isNotNull
 * (acceptedAt)))` query inline. `packages/lib/src/services/drive-role-service.ts`'s
 * `checkDriveAccessForRoles` carried a fourth copy that had already silently
 * DRIFTED — it was missing the acceptedAt gate the others had. Four
 * hand-copied implementations of one predicate is exactly the shape that
 * drifts: the fix is not "add the gate to the missing one," it's "there must
 * be only one implementation to drift."
 *
 * This guard keeps that fix from eroding: any route handler that composes an
 * inline `eq(driveMembers.role, 'ADMIN' | 'OWNER')` query — the signature
 * shape of a hand-rolled owner/admin predicate — must be allow-listed below
 * with a reason, so a new one can't slip in unnoticed. Preferred fix for any
 * new offender: call `isDriveOwnerOrAdmin` / `getDriveAccessLevel` instead of
 * adding a fifth inline copy.
 *
 * This is a narrower, more targeted sibling of
 * `drive-member-gate-coverage.test.ts` (which checks the acceptedAt gate is
 * present on every driveMembers read) — this file targets a different bug
 * class: duplicated *predicate logic*, not a missing filter.
 */

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const API_DIR = join(__dirname, '..');

/** Route files that compose an inline ADMIN/OWNER role check against driveMembers. */
const INLINE_ADMIN_CHECK_EXEMPT = new Map<string, string>([
  [
    'drives/[driveId]/pages',
    'Pre-existing inline ADMIN check, out of scope for the permissions-hardening pass that introduced this guard — tracked as a follow-up to migrate onto isDriveOwnerOrAdmin.',
  ],
  [
    'drives/[driveId]/permissions-tree',
    'Pre-existing inline ADMIN check, out of scope for the permissions-hardening pass that introduced this guard — tracked as a follow-up to migrate onto isDriveOwnerOrAdmin.',
  ],
  [
    'drives/[driveId]/trash',
    'Pre-existing inline ADMIN check, out of scope for the permissions-hardening pass that introduced this guard — tracked as a follow-up to migrate onto isDriveOwnerOrAdmin.',
  ],
]);

// Matches eq(driveMembers.role, 'ADMIN') / eq(driveMembers.role, "OWNER") in
// either argument order and with either quote style — the query-builder
// signature of a hand-rolled owner/admin predicate against driveMembers.
const INLINE_ROLE_CHECK = /eq\s*\(\s*driveMembers\.role\s*,\s*['"](ADMIN|OWNER)['"]\s*\)/;

function isRouteFile(name: string): boolean {
  return name === 'route.ts' || name === 'route.tsx';
}

function allRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allRouteFiles(full));
    else if (isRouteFile(entry)) out.push(full);
  }
  return out;
}

function toLogicalPath(absolutePath: string): string {
  return absolutePath.replace(API_DIR + '/', '').replace(/\/route\.tsx?$/, '');
}

describe('Inline drive-permission-check guard', () => {
  const routeFiles = allRouteFiles(API_DIR);
  const routes = routeFiles.map((f) => ({ path: toLogicalPath(f), file: f }));

  it('found the route files (guard is actually scanning something)', () => {
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.some((r) => r.path === 'pages/bulk-copy')).toBe(true);
  });

  it('the four callsites fixed by the permissions-hardening pass no longer inline the check', () => {
    // Regression pin: these are exactly the routes migrated onto
    // isDriveOwnerOrAdmin / isUserDriveMember. If one of these reappears with
    // an inline eq(driveMembers.role, ...) check, the centralization was
    // reverted (or bypassed) — fail loudly rather than silently drifting again.
    const migrated = ['pages/bulk-copy', 'pages/bulk-move', 'account/handle-drive', 'pages/tree'];
    for (const path of migrated) {
      const route = routes.find((r) => r.path === path);
      expect(route, `expected route file for ${path} to exist`).toBeTruthy();
      const content = readFileSync(route!.file, 'utf-8');
      expect(content).not.toMatch(INLINE_ROLE_CHECK);
    }
  });

  it('every route with an inline ADMIN/OWNER role check against driveMembers is allow-listed with a reason', () => {
    const violations: string[] = [];

    for (const route of routes) {
      const content = readFileSync(route.file, 'utf-8');
      if (!INLINE_ROLE_CHECK.test(content)) continue;
      if (INLINE_ADMIN_CHECK_EXEMPT.has(route.path)) continue;
      violations.push(route.path);
    }

    expect(violations).toEqual([]);
    if (violations.length > 0) {
      console.error(
        `\nInline driveMembers ADMIN/OWNER check found in ${violations.length} route(s), not allow-listed:\n` +
          violations.map((v) => `  - ${v}`).join('\n') +
          `\n\nFix: call isDriveOwnerOrAdmin(userId, driveId) (or getDriveAccessLevel)` +
          `\n     from packages/lib/src/permissions/ instead of composing a new` +
          `\n     inline query, OR add the route to INLINE_ADMIN_CHECK_EXEMPT with` +
          `\n     a one-line justification if it is a deliberate, reviewed exception.\n`
      );
    }
  });

  it('allow-list should not contain stale entries for routes that no longer inline the check', () => {
    const stale: string[] = [];

    for (const [pattern] of INLINE_ADMIN_CHECK_EXEMPT) {
      const route = routes.find((r) => r.path === pattern);
      if (!route) {
        stale.push(`${pattern} (route file not found)`);
        continue;
      }
      const content = readFileSync(route.file, 'utf-8');
      if (!INLINE_ROLE_CHECK.test(content)) {
        stale.push(`${pattern} (no longer composes an inline ADMIN/OWNER check)`);
      }
    }

    expect(stale).toEqual([]);
    if (stale.length > 0) {
      console.error(
        `\nStale INLINE_ADMIN_CHECK_EXEMPT entries:\n` +
          stale.map((s) => `  - ${s}`).join('\n') +
          `\n\nRemove these entries from the allow-list.\n`
      );
    }
  });

  it('allow-list entries should each carry a justification (no empty reasons)', () => {
    const empty: string[] = [];
    for (const [pattern, reason] of INLINE_ADMIN_CHECK_EXEMPT) {
      if (!reason || reason.trim().length < 10) empty.push(pattern);
    }
    expect(empty).toEqual([]);
  });
});
