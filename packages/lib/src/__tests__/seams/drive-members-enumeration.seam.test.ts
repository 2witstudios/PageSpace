/**
 * Seam guard 3 — one membership enumeration.
 *
 * Vision principle 2 names "one membership enumeration" as a canonical primitive, and Spec
 * decision O-6 records why: channel recipients, mention search, usersShareDrive, realtime
 * rooms, notifications, and backups all enumerate drive_members rows today, and "one missed
 * call site fails open" once org membership is materialized. Every read of drive_members
 * outside packages/lib/src/services and packages/lib/src/permissions is therefore a seam
 * violation. Today's violations are measured and allowlisted below with a TODO id; a NEW
 * file fails this test, and an allowlisted file that stops violating must be removed here.
 *
 * Writes (insert/update/delete) are deliberately NOT matched: materialization of membership
 * rows is lane B4's contract, and this guard is about who may *enumerate*.
 */
import { describe, expect, it } from 'vitest';
import { describeViolations, listSourceFiles, runSeam } from './walk';

/** A read of the drive_members table: a select source, a join target, a relational query, or raw SQL. */
export const DRIVE_MEMBERS_READ =
  /\bfrom\(\s*driveMembers\s*\)|\b(?:inner|left|right|full)?[jJ]oin\(\s*driveMembers\b|\bquery\.driveMembers\.(?:findMany|findFirst)\b|\b(?:from|join)\s+drive_members\b/i;

/** The canonical homes: the membership service layer and the permission layer. */
const EXEMPT = ['packages/lib/src/services/', 'packages/lib/src/permissions/'];

/**
 * The schema definition itself, and the e2e harness that seeds rows directly. Neither is an
 * application read path.
 */
const NOT_APPLICATION_CODE = ['packages/db/', 'apps/e2e/'];

/**
 * Measured on 2026-09-15 (lane A4). Each entry is tolerated until the owning lane routes it
 * through the membership service; the TODO id is the Sequence Spec lane that owns the fix
 * (B4 membership materialization, B7 resolver integration, X-2 GDPR, X-3 backups).
 */
export const DRIVE_MEMBERS_ENUMERATION_ALLOWLIST: Readonly<Record<string, string>> = {
  "apps/web/src/app/api/account/drives-status/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/account/handle-drive/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/activity/summary/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/admin/global-prompt/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/ai/page-agents/multi-drive/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/channels/[pageId]/messages/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/commands/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/drives/[driveId]/assignees/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/drives/[driveId]/backups/[backupId]/restore/route.ts":
    "TODO(OW-X-3): backups/restore enumerate members directly; route via the membership service when X-3 lands",
  "apps/web/src/app/api/drives/[driveId]/pages/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/drives/[driveId]/permissions-tree/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/drives/[driveId]/trash/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/inbox/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/messages/threads/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/pages/[pageId]/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/pages/bulk-copy/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/pages/bulk-move/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/pages/tree/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/pulse/cron/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/pulse/generate/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/pulse/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/sidebar/badges/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/app/api/users/messageable/route.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/lib/ai/tools/activity-tools.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/lib/ai/tools/channel-tools.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/lib/ai/tools/command-tools.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/lib/auth/revoke-adapters.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/lib/memory/discovery-service.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/lib/repositories/drive-invite-repository.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/lib/repositories/page-invite-repository.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/lib/users/visibility.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/services/api/drive-backup-service.ts":
    "TODO(OW-X-3): backups/restore enumerate members directly; route via the membership service when X-3 lands",
  "apps/web/src/services/api/page-reorder-service.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/services/api/permission-management-service.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/services/api/rollback/preview.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/services/api/rollback/redo-executors.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "apps/web/src/services/api/rollback/rollback-executors.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
  "packages/lib/src/compliance/export/gdpr-export.ts":
    "TODO(OW-X-2): GDPR export enumerates members directly; route via the membership service when X-2 lands",
  "packages/lib/src/repositories/account-repository.ts":
    "TODO(OW-B4): pre-materialization read; route via the one membership enumeration when B4 lands",
};

describe('seam: drive_members is enumerated only inside packages/lib services and permissions', () => {
  const files = listSourceFiles(['apps', 'packages']).filter(
    (f) => !NOT_APPLICATION_CODE.some((p) => f.startsWith(p)),
  );
  const result = runSeam({
    files,
    pattern: DRIVE_MEMBERS_READ,
    exemptPrefixes: EXEMPT,
    allowlist: DRIVE_MEMBERS_ENUMERATION_ALLOWLIST,
  });

  it('no NEW file outside the membership seams reads drive_members', () => {
    expect(
      result.newViolations,
      `New drive_members reads outside packages/lib/src/{services,permissions}. Route them through the ` +
        `membership service, or (only for pre-existing code being moved) allowlist the path with a TODO id:\n` +
        describeViolations(result.newViolations),
    ).toEqual([]);
  });

  it('every allowlisted file still violates (the allowlist only shrinks)', () => {
    expect(
      result.staleAllowlist,
      'These allowlisted files no longer read drive_members — remove them from DRIVE_MEMBERS_ENUMERATION_ALLOWLIST',
    ).toEqual([]);
  });

  it('the pattern recognises each enumeration shape and ignores writes', () => {
    expect(DRIVE_MEMBERS_READ.test('db.select().from(driveMembers)')).toBe(true);
    expect(DRIVE_MEMBERS_READ.test('.innerJoin(driveMembers, eq(...))')).toBe(true);
    expect(DRIVE_MEMBERS_READ.test('.leftJoin( driveMembers,')).toBe(true);
    expect(DRIVE_MEMBERS_READ.test('db.query.driveMembers.findMany({')).toBe(true);
    expect(DRIVE_MEMBERS_READ.test('sql`select 1 from drive_members`')).toBe(true);
    expect(DRIVE_MEMBERS_READ.test('db.insert(driveMembers).values(')).toBe(false);
    expect(DRIVE_MEMBERS_READ.test('db.delete(driveMembers).where(')).toBe(false);
    expect(DRIVE_MEMBERS_READ.test("import { driveMembers } from '@pagespace/db/schema/members'")).toBe(false);
    expect(DRIVE_MEMBERS_READ.test("message.includes('drive_members')")).toBe(false);
    expect(DRIVE_MEMBERS_READ.test("drive_members: 'drives',")).toBe(false);
  });
});
