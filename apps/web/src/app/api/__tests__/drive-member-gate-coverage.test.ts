/**
 * Drive Member acceptedAt Gate — Route Coverage
 *
 * Locks in the Epic 1 authz hardening: any API route that reads
 * `driveMembers` for an authorization decision MUST filter on
 * `isNotNull(driveMembers.acceptedAt)` so pending invitation rows
 * (acceptedAt IS NULL) cannot exercise authority.
 *
 * Routes that intentionally surface pending rows (e.g., the member-detail
 * view used to render "Invitation pending" in the UI) or that perform
 * non-authz reads/writes (e.g., DELETE by composite key, count helpers)
 * are explicitly allow-listed below with a justification.
 *
 * Regression caught: a new authz route is added under apps/web/src/app/api/**
 * that reads `driveMembers` without the gate and without an allow-list entry —
 * the test fails and forces the author to either gate the query or document
 * why the gate is intentionally skipped.
 */

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const API_DIR = join(__dirname, '..');
// Lib-level call sites also read driveMembers for authz decisions (AI tools,
// memory discovery). Review C2 found four such sites the original API-only
// scan could not see; this directory is now part of the regression sweep.
const LIB_DIR = join(__dirname, '..', '..', '..', 'lib');

/** Files that read `driveMembers` but are intentionally exempt from the gate. */
const ACCEPTED_AT_GATE_EXEMPT = new Map<string, string>([
  [
    'drives/[driveId]/members/[userId]',
    'GET intentionally surfaces pending rows for the member-detail UI ("Invitation pending"); DELETE/PATCH operate by composite (driveId, userId) key and do not branch on acceptedAt.',
  ],
  [
    'account/drives-status',
    'Followup #4: admin lookup for drive-transfer UI should gate on acceptedAt — tracked in followup-4 (invite UX/audit hardening).',
  ],
  [
    'admin/global-prompt',
    'Followup #4: admin drive picker should hide pending invitations — tracked in followup-4.',
  ],
  [
    'channels/[pageId]/messages',
    'Followup #4: pending admins should not receive @mention broadcast — tracked in followup-4.',
  ],
]);

/**
 * Lib-level files that read `driveMembers` but are intentionally exempt.
 * The repository file is the canonical seam; all reads through it carry
 * their own gate logic specific to the operation (e.g. findActivePendingMember
 * deliberately filters acceptedAt IS NULL to surface pending rows for the
 * pending-list UI).
 */
const LIB_ACCEPTED_AT_GATE_EXEMPT = new Map<string, string>([
  [
    'repositories/drive-invite-repository.ts',
    'Repository seam — each query carries its own gate (findAdminMembership filters IS NOT NULL; findActivePendingMemberByEmail intentionally filters IS NULL to surface pending rows; createDriveMember/findExistingMember/updateDriveMemberRole operate by composite key or memberId and do not branch on acceptedAt).',
  ],
]);

const DRIVE_MEMBERS_REFERENCE = /\bdriveMembers\b/;
const ACCEPTED_AT_GATE = /isNotNull\s*\(\s*driveMembers\.acceptedAt\s*\)/;
// findActivePendingMemberByEmail intentionally filters IS NULL — that file is
// allow-listed via LIB_ACCEPTED_AT_GATE_EXEMPT, so this constant is unused
// today but documents the inverse case for future reviewers.

function collectRouteFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue;
    if (statSync(full).isDirectory()) {
      results.push(...collectRouteFiles(full));
    } else if (entry === 'route.ts') {
      results.push(full);
    }
  }
  return results;
}

function collectLibFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === '__tests__') continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
    if (statSync(full).isDirectory()) {
      results.push(...collectLibFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      results.push(full);
    }
  }
  return results;
}

function toLogicalPath(absolutePath: string): string {
  const relative = absolutePath.replace(API_DIR + '/', '');
  return relative.replace(/\/route\.ts$/, '');
}

function toLibLogicalPath(absolutePath: string): string {
  return absolutePath.replace(LIB_DIR + '/', '');
}

describe('Drive Member acceptedAt Gate Coverage', () => {
  const routeFiles = collectRouteFiles(API_DIR);
  const routes = routeFiles.map((f) => ({ path: toLogicalPath(f), file: f }));

  it('given any route that reads driveMembers, should compose isNotNull(driveMembers.acceptedAt) or be explicitly allow-listed', () => {
    const violations: string[] = [];

    for (const route of routes) {
      const content = readFileSync(route.file, 'utf-8');
      if (!DRIVE_MEMBERS_REFERENCE.test(content)) continue;
      if (ACCEPTED_AT_GATE.test(content)) continue;
      if (ACCEPTED_AT_GATE_EXEMPT.has(route.path)) continue;
      violations.push(route.path);
    }

    expect(violations).toEqual([]);
    if (violations.length > 0) {
      console.error(
        `\nDrive member authz gate missing for ${violations.length} route(s):\n` +
          violations.map((v) => `  - ${v}`).join('\n') +
          `\n\nFix: Add isNotNull(driveMembers.acceptedAt) to the WHERE clause` +
          `\n     of every authz read of driveMembers, OR add the route to` +
          `\n     ACCEPTED_AT_GATE_EXEMPT with a one-line justification.\n`
      );
    }
  });

  it('allow-list should not contain stale entries for routes that no longer reference driveMembers', () => {
    const stale: string[] = [];

    for (const [pattern] of ACCEPTED_AT_GATE_EXEMPT) {
      const route = routes.find((r) => r.path === pattern);
      if (!route) {
        stale.push(`${pattern} (route file not found)`);
        continue;
      }
      const content = readFileSync(route.file, 'utf-8');
      if (!DRIVE_MEMBERS_REFERENCE.test(content)) {
        stale.push(`${pattern} (no longer references driveMembers)`);
      }
    }

    expect(stale).toEqual([]);
    if (stale.length > 0) {
      console.error(
        `\nStale ACCEPTED_AT_GATE_EXEMPT entries:\n` +
          stale.map((s) => `  - ${s}`).join('\n') +
          `\n\nRemove these entries from the allow-list.\n`
      );
    }
  });

  it('allow-list entries should each carry a justification (no empty reasons)', () => {
    const empty: string[] = [];
    for (const [pattern, reason] of ACCEPTED_AT_GATE_EXEMPT) {
      if (!reason || reason.trim().length < 10) {
        empty.push(pattern);
      }
    }
    expect(empty).toEqual([]);
  });

  it('coverage scan should discover a non-trivial number of routes (sanity check)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(50);
  });

  // Review C2: the scan now extends into apps/web/src/lib/** so AI tools and
  // memory discovery cannot silently bypass the gate. Without this sweep, four
  // lib-level read sites used to live as invisible escape hatches.
  describe('lib/** coverage (Review C2: lib-level call-site sweep)', () => {
    const libFiles = collectLibFiles(LIB_DIR);

    it('given any lib file that reads driveMembers, should compose isNotNull(driveMembers.acceptedAt) or be explicitly allow-listed', () => {
      const violations: string[] = [];

      for (const file of libFiles) {
        const content = readFileSync(file, 'utf-8');
        if (!DRIVE_MEMBERS_REFERENCE.test(content)) continue;
        if (ACCEPTED_AT_GATE.test(content)) continue;
        const logical = toLibLogicalPath(file);
        if (LIB_ACCEPTED_AT_GATE_EXEMPT.has(logical)) continue;
        violations.push(logical);
      }

      expect(violations).toEqual([]);
      if (violations.length > 0) {
        console.error(
          `\nDrive member authz gate missing for ${violations.length} lib file(s):\n` +
            violations.map((v) => `  - ${v}`).join('\n') +
            `\n\nFix: Add isNotNull(driveMembers.acceptedAt) to the WHERE clause` +
            `\n     of every authz read of driveMembers in apps/web/src/lib/**, OR` +
            `\n     add the file to LIB_ACCEPTED_AT_GATE_EXEMPT with a one-line` +
            `\n     justification.\n`
        );
      }
    });

    it('lib coverage scan should discover a non-trivial number of files (sanity check)', () => {
      expect(libFiles.length).toBeGreaterThanOrEqual(50);
    });
  });
});
