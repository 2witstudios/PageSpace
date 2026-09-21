/**
 * Drive Member acceptedAt Gate — Query Coverage
 *
 * Locks in the Epic 1 authz hardening: every query that reads `driveMembers`
 * for an authorization decision MUST filter on
 * `isNotNull(driveMembers.acceptedAt)` so pending invitation rows
 * (acceptedAt IS NULL) cannot exercise authority.
 *
 * The check is per QUERY, not per file. A file-level check let one gated query
 * hide an ungated one beside it, and the original sweep only covered
 * apps/web/src/app/api/** and apps/web/src/lib/** — four ungated authz reads
 * survived outside it (drive-role-service, page-reorder-service,
 * permission-management-service, and the raw-SQL channel list in
 * messages/threads).
 *
 * Reads that are legitimately ungated (writers' pre-update reads, displays
 * behind a gated owner/admin check, candidate filters a canonical resolver
 * decides afterwards) are allow-listed below with the EXACT number of ungated
 * queries and a reason. A new ungated query in an allow-listed file changes
 * the count and fails the test just as it would anywhere else.
 */

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const SCAN_DIRS = [
  join(REPO_ROOT, 'apps', 'web', 'src', 'app', 'api'),
  join(REPO_ROOT, 'apps', 'web', 'src', 'lib'),
  join(REPO_ROOT, 'apps', 'web', 'src', 'services'),
  join(REPO_ROOT, 'packages', 'lib', 'src'),
];

/** An ORM read of driveMembers: `.from(driveMembers)`, a join on it, or `db.query.driveMembers.find*`. */
const ORM_READ_SITE = /(?:\.from|\.(?:left|inner|right|full)Join)\(\s*driveMembers\b|\bquery\.driveMembers\.find(?:First|Many)\(/g;
const ORM_GATE = /isNotNull\s*\(\s*driveMembers\.acceptedAt\s*\)/;
/** A raw-SQL read of drive_members. */
const SQL_READ_SITE = /\b(?:JOIN|FROM)\s+drive_members\b/g;
const SQL_GATE = /"acceptedAt"/;

/**
 * Counts ORM reads of driveMembers whose own query carries no acceptedAt gate.
 * A query spans from its read site to the end of its statement, cut short at
 * the next read site so one gated query cannot vouch for a neighbour.
 */
function countUngatedOrmReads(source: string): number {
  const sites = [...source.matchAll(ORM_READ_SITE)].map((m) => m.index ?? 0);
  return sites.filter((start, i) => {
    const semicolon = source.indexOf(';', start);
    const end = Math.min(semicolon === -1 ? source.length : semicolon, sites[i + 1] ?? source.length);
    return !ORM_GATE.test(source.slice(start, end));
  }).length;
}

/** Counts raw-SQL joins/selects on drive_members whose enclosing sql`` template has no "acceptedAt". */
function countUngatedSqlReads(source: string): number {
  return [...source.matchAll(SQL_READ_SITE)].filter((match) => {
    const index = match.index ?? 0;
    const open = source.lastIndexOf('sql`', index);
    const close = source.indexOf('`', index);
    return !SQL_GATE.test(source.slice(open === -1 ? 0 : open, close === -1 ? source.length : close));
  }).length;
}

type Exemption = { ormReads?: number; sqlReads?: number; reason: string };

/** Repo-relative path → the exact ungated query counts that file is allowed, and why. */
const EXEMPT = new Map<string, Exemption>([
  // ── apps/web/src/app/api ────────────────────────────────────────────────
  ['apps/web/src/app/api/account/drives-status/route.ts', {
    ormReads: 2,
    reason: 'Account-deletion UI: counting pending rows keeps a drive "multi-member" (the conservative direction), and the admin transfer list is display only — handle-drive refuses a pending admin as the new owner. Followup #4 tracks hiding pending admins from the list.',
  }],
  ['apps/web/src/app/api/admin/global-prompt/route.ts', {
    ormReads: 1,
    reason: 'Platform-admin debug tool that already reads any drive\'s pages with no membership check; the drive picker read grants nothing. Followup #4 tracks hiding pending invitations from the picker.',
  }],
  ['apps/web/src/app/api/drives/[driveId]/backups/[backupId]/restore/route.ts', {
    ormReads: 1,
    reason: 'Enumerates ALL current members (including pending) for full replacement during restore; filtering on acceptedAt would silently leave pending-invite rows behind.',
  }],
  // ── apps/web/src/lib ────────────────────────────────────────────────────
  ['apps/web/src/lib/repositories/drive-invite-repository.ts', {
    ormReads: 2,
    reason: 'Invite management: findExistingMember looks up a row by composite key to avoid duplicate invites, and findActivePendingMemberByEmail filters acceptedAt IS NULL on purpose to list pending rows.',
  }],
  ['apps/web/src/lib/repositories/page-invite-repository.ts', {
    ormReads: 1,
    reason: 'Page-invite acceptance reads the (driveId, userId) row to write it: it inserts a missing row or sets acceptedAt on a pending one.',
  }],
  // ── apps/web/src/services ───────────────────────────────────────────────
  ['apps/web/src/services/api/drive-backup-service.ts', {
    ormReads: 1,
    reason: 'Backup snapshot copies every drive_members row, pending included, so a restore reproduces the drive faithfully.',
  }],
  ['apps/web/src/services/api/rollback/preview.ts', {
    ormReads: 1,
    reason: 'Conflict preview shows the target member row\'s current values (pending or not) before a rollback; the caller is authorized separately.',
  }],
  ['apps/web/src/services/api/rollback/rollback-executors.ts', {
    ormReads: 1,
    reason: 'Collects every holder of a role being deleted so each can be revalidated — including pending rows is the fail-safe direction.',
  }],
  ['apps/web/src/services/api/rollback/redo-executors.ts', {
    ormReads: 1,
    reason: 'Collects every holder of a role being deleted so each can be revalidated — including pending rows is the fail-safe direction.',
  }],
  // ── packages/lib/src ────────────────────────────────────────────────────
  ['packages/lib/src/compliance/export/gdpr-export.ts', {
    ormReads: 1,
    reason: 'GDPR subject-access export of the user\'s OWN membership rows; pending invitations are the subject\'s personal data.',
  }],
  ['packages/lib/src/repositories/account-repository.ts', {
    ormReads: 2,
    reason: 'Account deletion counts every row to decide whether a drive is solo; counting pending rows makes deletion MORE conservative.',
  }],
  ['packages/lib/src/services/app-shell-service.ts', {
    ormReads: 2,
    reason: 'Both reads are scoped to the drive set resolved by the gated owned/accepted-member query: the caller\'s role/lastAccessedAt per drive, and the member list (which returns acceptedAt so the UI can show pending invitations).',
  }],
  ['packages/lib/src/services/org-membership-sync.ts', {
    ormReads: 1,
    reason: 'The org membership sync (loadExistingRows) must see EVERY row on the org\'s drives, pending included: a user holding any row gets no second insert (unique driveId+userId), and an unaccepted source=org row is repaired. It reads acceptedAt to plan that; it writes rows and grants nothing.',
  }],
  ['packages/lib/src/services/drive-member-service.ts', {
    ormReads: 3,
    reason: 'listDriveMembers and getDriveMemberDetails surface pending rows ("Invitation pending") behind the gated checkDriveAccess owner/admin check; updateMemberRole reads the old role before writing it.',
  }],
]);

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    if (statSync(full).isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      results.push(full);
    }
  }
  return results;
}

const toRepoPath = (absolutePath: string) => absolutePath.replace(REPO_ROOT + '/', '');

describe('Drive Member acceptedAt Gate Coverage', () => {
  describe('query scanner', () => {
    it('given one gated and one ungated query in the same file, should count the ungated one', () => {
      const source = `
        const gated = await db.select().from(driveMembers)
          .where(and(eq(driveMembers.userId, userId), isNotNull(driveMembers.acceptedAt)));
        const ungated = await db.select().from(driveMembers)
          .where(eq(driveMembers.userId, userId));
      `;
      expect(countUngatedOrmReads(source)).toBe(1);
    });

    it('given a gated query followed immediately by another read in the same statement, should not let the first vouch for the second', () => {
      const source = `
        const [a, b] = await Promise.all([
          db.query.driveMembers.findFirst({ where: and(eq(driveMembers.userId, u), isNotNull(driveMembers.acceptedAt)) }),
          db.query.driveMembers.findMany({ where: eq(driveMembers.driveId, d) }),
        ]);
      `;
      expect(countUngatedOrmReads(source)).toBe(1);
    });

    it('given gated reads, joins and findFirst calls, should count nothing', () => {
      const source = `
        await db.query.driveMembers.findFirst({ where: and(eq(driveMembers.driveId, d), isNotNull(driveMembers.acceptedAt)) });
        await db.select().from(pages).leftJoin(driveMembers, and(eq(driveMembers.driveId, pages.driveId), isNotNull(driveMembers.acceptedAt)));
        await tx.delete(driveMembers).where(eq(driveMembers.driveId, d));
      `;
      expect(countUngatedOrmReads(source)).toBe(0);
    });

    it('given one gated and one ungated sql template, should count the ungated one', () => {
      const source = [
        'await db.execute(sql`SELECT 1 FROM pages p LEFT JOIN drive_members dm ON dm."driveId" = p."driveId" AND dm."acceptedAt" IS NOT NULL`);',
        'await db.execute(sql`SELECT 1 FROM pages p LEFT JOIN drive_members dm ON dm."driveId" = p."driveId"`);',
      ].join('\n');
      expect(countUngatedSqlReads(source)).toBe(1);
    });
  });

  describe('repository sweep', () => {
    const files = SCAN_DIRS.flatMap(collectSourceFiles);
    const repoPaths = new Set(files.map(toRepoPath));

    it('given any file that reads drive members, should gate every query or match its allow-listed count exactly', () => {
      const mismatches: string[] = [];
      for (const file of files) {
        const source = readFileSync(file, 'utf-8');
        const actual = { ormReads: countUngatedOrmReads(source), sqlReads: countUngatedSqlReads(source) };
        const path = toRepoPath(file);
        const exemption = EXEMPT.get(path);
        const allowed = { ormReads: exemption?.ormReads ?? 0, sqlReads: exemption?.sqlReads ?? 0 };
        if (actual.ormReads !== allowed.ormReads || actual.sqlReads !== allowed.sqlReads) {
          mismatches.push(`${path}: ungated ${JSON.stringify(actual)}, allowed ${JSON.stringify(allowed)}`);
        }
      }

      expect(mismatches).toEqual([]);
      if (mismatches.length > 0) {
        console.error(
          `\nDrive member acceptedAt gate mismatch:\n` +
            mismatches.map((m) => `  - ${m}`).join('\n') +
            `\n\nFix: add isNotNull(driveMembers.acceptedAt) (or "acceptedAt" in raw SQL)` +
            `\n     to the query, route the decision through a canonical permission` +
            `\n     function, or — only for a legitimately ungated read — update the` +
            `\n     EXEMPT count and reason.\n`
        );
      }
    });

    it('allow-list should not name files that no longer exist', () => {
      expect([...EXEMPT.keys()].filter((path) => !repoPaths.has(path))).toEqual([]);
    });

    it('allow-list entries should each carry a justification (no empty reasons)', () => {
      expect([...EXEMPT].filter(([, { reason }]) => reason.trim().length < 10).map(([path]) => path)).toEqual([]);
    });

    it('sweep should cover routes, web lib, web services and the lib package (sanity check)', () => {
      expect(files.length).toBeGreaterThanOrEqual(500);
      for (const path of [
        'apps/web/src/app/api/pages/tree/route.ts',
        'apps/web/src/lib/users/visibility.ts',
        'apps/web/src/services/api/page-reorder-service.ts',
        'packages/lib/src/services/drive-role-service.ts',
      ]) {
        expect(repoPaths.has(path)).toBe(true);
      }
    });
  });
});
