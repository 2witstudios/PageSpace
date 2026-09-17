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
    'The unfiltered drive_members read only builds a CANDIDATE recipient set; recipients are then filtered through getUsersWhoCanViewPage, which requires an accepted membership, so a pending admin receives no broadcast.',
  ],
  [
    'drives/[driveId]/backups/[backupId]/restore',
    'Reads driveMembers to enumerate ALL current members (including pending) for full-replacement during restore. The gate is intentionally absent here: the goal is to delete all rows so the backup state is faithfully restored — filtering on acceptedAt would silently leave pending-invite rows behind.',
  ],
  [
    'users/messageable',
    'DM-eligibility surfacing intentionally drops the gate so co-members whose driveMembers.acceptedAt is NULL (legacy rows missed by migrate-pending-invites, or transient invite states) still appear in the New Conversation picker. DM eligibility is softer than drive access; the gate is preserved everywhere a NULL row could exercise authority (page reads, member listings, broadcasts).',
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
  [
    'auth/revoke-adapters.ts',
    'findActorMembership returns raw {role, acceptedAt} so the strict "accepted OWNER/ADMIN" gate lives once in validateRevokeRequest (pure-core). Filtering acceptedAt at the SQL layer would silently NOT_FOUND a request that should FORBIDDEN, masking a wrong-role attempt.',
  ],
  [
    'repositories/page-invite-repository.ts',
    'Page-invite acceptance writes a driveMembers row (does not read for authz). Existing-member lookup gates on (driveId, userId) composite to keep the page-grant idempotent — a pending-invite row would be a different (driveId, userId) and is irrelevant here.',
  ],
]);

/**
 * apps/web/src/services/** and packages/lib/src/** were outside the original
 * sweep, and that is exactly where four ungated authz reads survived: the
 * drive-role access check (roles routes), page reorder, permission management,
 * plus the raw-SQL channel list in messages/threads. Keys are paths relative to
 * the repo root.
 */
const SERVICE_ACCEPTED_AT_GATE_EXEMPT = new Map<string, string>([
  [
    'apps/web/src/services/api/restore-permissions-service.ts',
    'Writer: deletes and inserts drive_members rows to restore a backup; it makes no access decision.',
  ],
  [
    'apps/web/src/services/api/rollback/rollback-executors.ts',
    'Writer: executes member/role rollback plans. The customRoleId read collects every holder of a role being deleted so each can be revalidated — including pending rows is the fail-safe direction.',
  ],
  [
    'apps/web/src/services/api/rollback/redo-executors.ts',
    'Writer: executes member/role redo plans. The customRoleId read collects every holder of a role being deleted so each can be revalidated — including pending rows is the fail-safe direction.',
  ],
  [
    'apps/web/src/services/api/rollback/preview.ts',
    'Conflict preview: reads the target member row (pending or not) by composite key to show its current values before a rollback; the caller is authorized separately.',
  ],
  [
    'packages/lib/src/types.ts',
    'Type declaration only (AppShell.driveMembers); no query.',
  ],
  [
    'packages/lib/src/repositories/account-repository.ts',
    'Account deletion counts every drive_members row to decide whether a drive is solo; counting pending rows makes deletion MORE conservative, never grants access.',
  ],
  [
    'packages/lib/src/permissions/share-link-service.ts',
    'Writer only: share-link redemption upserts an accepted drive_members row; it never reads one for a decision.',
  ],
  [
    'packages/lib/src/compliance/export/gdpr-export.ts',
    "GDPR subject-access export of the user's OWN membership rows; pending invitations are the subject's personal data and belong in the export.",
  ],
]);

/**
 * Raw SQL escapes the `isNotNull(driveMembers.acceptedAt)` scan entirely. A
 * file that joins drive_members in SQL must either gate on "acceptedAt" in that
 * SQL or pass the candidates through getBatchPagePermissions (which gates).
 */
const RAW_SQL_DRIVE_MEMBERS = /\b(?:JOIN|FROM)\s+drive_members\b/;
const RAW_SQL_GATE = /"acceptedAt"|getBatchPagePermissions/;

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

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const SERVICE_DIRS = [
  join(REPO_ROOT, 'apps', 'web', 'src', 'services'),
  join(REPO_ROOT, 'packages', 'lib', 'src'),
];

function toRepoPath(absolutePath: string): string {
  return absolutePath.replace(REPO_ROOT + '/', '');
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

    it('lib allow-list should not contain stale entries for files that no longer reference driveMembers', () => {
      const stale: string[] = [];

      for (const [pattern] of LIB_ACCEPTED_AT_GATE_EXEMPT) {
        const file = libFiles.find((f) => toLibLogicalPath(f) === pattern);
        if (!file) {
          stale.push(`${pattern} (lib file not found)`);
          continue;
        }
        const content = readFileSync(file, 'utf-8');
        if (!DRIVE_MEMBERS_REFERENCE.test(content)) {
          stale.push(`${pattern} (no longer references driveMembers)`);
        }
      }

      expect(stale).toEqual([]);
    });

    it('lib allow-list entries should each carry a justification (no empty reasons)', () => {
      const empty: string[] = [];
      for (const [pattern, reason] of LIB_ACCEPTED_AT_GATE_EXEMPT) {
        if (!reason || reason.trim().length < 10) {
          empty.push(pattern);
        }
      }
      expect(empty).toEqual([]);
    });
  });

  describe('services/** and packages/lib/src/** coverage', () => {
    const serviceFiles = SERVICE_DIRS.flatMap((dir) => collectLibFiles(dir));

    it('given any service or lib-package file that reads driveMembers, should compose isNotNull(driveMembers.acceptedAt) or be explicitly allow-listed', () => {
      const violations = serviceFiles
        .filter((file) => {
          const content = readFileSync(file, 'utf-8');
          return DRIVE_MEMBERS_REFERENCE.test(content) && !ACCEPTED_AT_GATE.test(content);
        })
        .map(toRepoPath)
        .filter((path) => !SERVICE_ACCEPTED_AT_GATE_EXEMPT.has(path));

      expect(violations).toEqual([]);
    });

    it('service scan should discover both directories (sanity check)', () => {
      const repoPaths = serviceFiles.map(toRepoPath);
      expect(repoPaths.some((p) => p === 'apps/web/src/services/api/page-reorder-service.ts')).toBe(true);
      expect(repoPaths.some((p) => p === 'packages/lib/src/services/drive-role-service.ts')).toBe(true);
    });

    it('service allow-list should not contain stale entries', () => {
      const stale = [...SERVICE_ACCEPTED_AT_GATE_EXEMPT.keys()].filter((path) => {
        const file = serviceFiles.find((f) => toRepoPath(f) === path);
        return !file || !DRIVE_MEMBERS_REFERENCE.test(readFileSync(file, 'utf-8'));
      });

      expect(stale).toEqual([]);
    });
  });

  describe('raw SQL drive_members joins', () => {
    const sqlFiles = [...routeFiles, ...collectLibFiles(LIB_DIR), ...SERVICE_DIRS.flatMap((dir) => collectLibFiles(dir))];

    it('given a file that joins drive_members in raw SQL, should gate on "acceptedAt" or filter through getBatchPagePermissions', () => {
      const violations = sqlFiles
        .filter((file) => {
          const content = readFileSync(file, 'utf-8');
          return RAW_SQL_DRIVE_MEMBERS.test(content) && !RAW_SQL_GATE.test(content);
        })
        .map(toRepoPath);

      expect(violations).toEqual([]);
    });

    it('raw SQL scan should see the known candidate-filter routes (sanity check)', () => {
      const joined = sqlFiles
        .filter((file) => RAW_SQL_DRIVE_MEMBERS.test(readFileSync(file, 'utf-8')))
        .map(toRepoPath);
      expect(joined).toContain('apps/web/src/app/api/messages/threads/route.ts');
    });
  });
});
