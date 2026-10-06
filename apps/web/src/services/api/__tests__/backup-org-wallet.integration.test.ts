/**
 * Backups and restore preserve orgId, visibility and wallet rows, against a
 * REAL Postgres (Spec X-3).
 *
 * What existed before this leaf: the snapshot recorded pages, permissions,
 * members, roles and files — and NOTHING about the drive's org context; the
 * restore wrote only pages/ACLs/members/roles, so nothing ever disturbed
 * drives.orgId, drives.orgVisibility or the wallet rows, but nothing PROVED
 * it either. #2762's POL-2 admission guards (a restore putting an outsider
 * back is gated) were wired into the route and are proven in
 * guest-policy-reentry.integration.test.ts; this file pins the OTHER half of
 * X-3 — the round-trip itself:
 *
 *   1. a snapshot RECORDS the drive's orgId and orgVisibility (new columns);
 *   2. a restore never writes those (possibly stale) values back: a drive
 *      that moved orgs since its backup stays where it moved to;
 *   3. a drive wallet's row survives a restore unchanged — the backup does
 *      not carry wallets and the restore must not need to.
 *
 * Requires a live `DATABASE_URL` with migrations applied; fails loudly
 * without one (requireDb).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { eq, inArray } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { drives, pages } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { wallets, walletFundingLegs } from '@pagespace/db/schema/wallets';
import { driveBackups } from '@pagespace/db/schema/versioning';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
// The move of pages logs activity fire-and-forget; not what these tests assert.
vi.mock('@pagespace/lib/monitoring/activity-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/monitoring/activity-logger')>()),
  logPageActivity: vi.fn(),
  getActorInfo: vi.fn(async () => ({ actorEmail: 'a@x', actorDisplayName: 'A' })),
}));
// Blob storage is not configured here; only the version-service EDGE is faked:
// `createPageVersion` still inserts a REAL `page_versions` row (the backup's
// `pageVersionId` is a real FK into that table, and the restore diff reads its
// `stateHash` back) but stores its content behind a fake ref instead of S3.
// This scenario's diff produces no create/overwrite ops, so nothing ever reads
// the fake ref back.
vi.mock('@pagespace/lib/services/page-version-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-version-service')>()),
  createPageVersion: vi.fn(async (
    input: { pageId: string; driveId: string; createdBy?: string | null; source: string; label?: string | null; reason?: string | null; content: string; contentFormat?: string; pageRevision: number; stateHash?: string | null; changeGroupId?: string | null; changeGroupType?: string | null; metadata?: Record<string, unknown> },
    options?: { tx?: unknown },
  ) => {
    const { pageVersions } = await import('@pagespace/db/schema/versioning');
    const database = (options?.tx ?? (await import('@pagespace/db/db')).db) as { insert: (t: unknown) => { values: (v: unknown) => { returning: (s: unknown) => Promise<{ id: string }[]> } } };
    const ref = `${input.contentFormat ?? 'markdown'}:test-${input.content.length}`;
    const [created] = await database.insert(pageVersions).values({
      pageId: input.pageId,
      driveId: input.driveId,
      createdBy: input.createdBy ?? null,
      source: input.source,
      label: input.label,
      reason: input.reason,
      changeGroupId: input.changeGroupId,
      changeGroupType: input.changeGroupType,
      contentRef: ref,
      contentFormat: input.contentFormat ?? 'markdown',
      contentSize: input.content.length,
      stateHash: input.stateHash,
      pageRevision: input.pageRevision,
      metadata: input.metadata,
    }).returning({ id: pageVersions.id });
    return {
      id: created.id,
      contentRef: ref,
      contentSize: input.content.length,
      compressed: false,
      storedSize: input.content.length,
      compressionRatio: 1,
    };
  }),
}));

import { createDriveBackup } from '../drive-backup-service';
import { fetchAndComputeRestoreDiff } from '../restore-diff-service';
import { planPageRestoreOps, applyPageRestoreOps } from '../restore-pages-service';
import {
  planPermissionRestoreOps,
  planMemberRestoreOps,
  planRoleRestoreOps,
  applyPermRestoreOps,
  type RestoreAdmission,
} from '../restore-permissions-service';
import { admitReentry } from '@pagespace/lib/permissions/guest-holds';
import { guardDriveAccess } from '@pagespace/lib/permissions/org-lapse-guard';
import { guardOpenRoleFloor } from '@pagespace/lib/organizations/open-role-floor';
import { createChangeGroupId, inferChangeGroupType } from '@pagespace/lib/monitoring/change-group';

const created = { userIds: [] as string[], driveIds: [] as string[], orgIds: [] as string[] };

let dbAvailable = false;

interface World {
  ownerId: string;
  orgId: string;
  movedOrgId: string;
  orgDriveId: string;
  keptPageId: string;
  laterPageId: string;
  driveWalletId: string;
  walletBefore: typeof wallets.$inferSelect | null;
}
let w: World;

async function buildWorld() {
  const owner = await factories.createUser();
  created.userIds.push(owner.id);

  const orgId = createId();
  const movedOrgId = createId();
  created.orgIds.push(orgId, movedOrgId);
  await db.insert(organizations).values([
    { id: orgId, name: 'Northwind', slug: `nw-${createId()}`, ownerId: owner.id },
    { id: movedOrgId, name: 'Southwind', slug: `sw-${createId()}`, ownerId: owner.id },
  ]);
  // Paid orgs: the lapsed-org restore guard ([D-OW-33]) reads the subscription.
  await factories.createOrgSubscription(orgId, { status: 'active' });
  await factories.createOrgSubscription(movedOrgId, { status: 'active' });
  await db.insert(orgMembers).values([
    { orgId, userId: owner.id, role: 'OWNER' },
    { orgId: movedOrgId, userId: owner.id, role: 'OWNER' },
  ]);

  const orgDrive = await factories.createDrive(owner.id);
  created.driveIds.push(orgDrive.id);
  await db.update(drives).set({ orgId, orgVisibility: 'RESTRICTED' }).where(eq(drives.id, orgDrive.id));
  const kept = await factories.createPage(orgDrive.id);
  // A FIXED state hash, so the backup's diff reads the page as unchanged and
  // the restore has only the post-backup page to deal with (this file's
  // subject is org/wallet preservation, not content round-trips).
  await db.update(pages).set({ stateHash: 'fixed-state-hash' }).where(eq(pages.id, kept.id));

  // One transaction: the wallet-leg invariant trigger (armed by lib's
  // integration harness — and, un-armed, by nothing) re-checks a touched
  // non-root wallet at COMMIT, so the wallet and its leg land together.
  await db.transaction(async (tx) => {
    const [poolWallet] = await tx
      .insert(wallets)
      .values({ ownerType: 'org', orgId, monthlyRemainingCents: 400_000 })
      .returning({ id: wallets.id });
    const [driveWallet] = await tx
      .insert(wallets)
      .values({
        ownerType: 'org',
        orgId,
        subjectType: 'drive',
        subjectId: orgDrive.id,
        parentWalletId: poolWallet.id,
        topupRemainingCents: 300,
      })
      .returning({ id: wallets.id });
    await tx.insert(walletFundingLegs).values({
      walletId: driveWallet.id,
      funderKind: 'owner',
      funderOrgId: orgId,
      originalCents: 300,
      remainingCents: 300,
      nonRefundable: false,
      sourceRef: `topup-${createId()}`,
    });
    w = {
      ownerId: owner.id,
      orgId,
      movedOrgId,
      orgDriveId: orgDrive.id,
      keptPageId: kept.id,
      laterPageId: '',
      driveWalletId: driveWallet.id,
      walletBefore: null,
    };
  });
}

/**
 * The restore, exactly as the route runs it: one transaction — diff, page ops,
 * then the ACL/member/role half behind the org lapse guard, the Open-role
 * floor and the POL-2 admission gate.
 */
async function restoreBackup(backupId: string) {
  const changeGroupId = createChangeGroupId();
  const changeGroupType = inferChangeGroupType({ isAiGenerated: false });
  return db.transaction(async (tx) => {
    const diffResult = await fetchAndComputeRestoreDiff(backupId, w.orgDriveId, tx as never);
    if (!diffResult.ok) throw new Error(`Failed to compute diff: ${diffResult.reason}`);
    const { diff, backupPageMap } = diffResult;
    const affectedPageIds = [
      ...diff.toCreate.map(p => p.pageId),
      ...diff.toOverwrite.map(p => p.pageId),
      ...diff.toOrphan.map(p => p.pageId),
      ...diff.unchanged.map(p => p.pageId),
    ];

    const ops = planPageRestoreOps(diff, backupPageMap);
    await applyPageRestoreOps(ops, w.orgDriveId, w.ownerId, backupId, changeGroupId, changeGroupType, tx as never);

    const admit: RestoreAdmission = async ({ userId, member, grants }) =>
      (await admitReentry(tx, { driveId: w.orgDriveId, userId, member, grants, requestedBy: w.ownerId })).outcome;

    return guardDriveAccess(tx, w.orgDriveId, {}, (sp) =>
      guardOpenRoleFloor(sp, w.orgDriveId, () => applyPermRestoreOps(
        planPermissionRestoreOps([], [], affectedPageIds),
        planMemberRestoreOps([], []),
        planRoleRestoreOps([], []),
        w.orgDriveId,
        sp as never,
        admit,
      )));
  });
}

async function cleanup() {
  if (created.driveIds.length) await db.delete(drives).where(inArray(drives.id, created.driveIds));
  if (created.orgIds.length) {
    // The subscription RESTRICTs the org delete (billing must end first).
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, created.orgIds));
    await db.delete(organizations).where(inArray(organizations.id, created.orgIds));
  }
  if (created.userIds.length) await db.delete(users).where(inArray(users.id, created.userIds));
  created.userIds = [];
  created.driveIds = [];
  created.orgIds = [];
}

beforeAll(async () => {
  try {
    await db.select({ id: organizations.id }).from(organizations).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('backup-org-wallet.integration.test.ts', error);
  }
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await buildWorld();
});

afterEach(async () => {
  if (dbAvailable) await cleanup();
});

afterAll(async () => {
  if (!dbAvailable) return;
  const { pool } = await import('@pagespace/db/db');
  await pool.end();
});

describe('backups and restore preserve org context and wallet rows (X-3 (partial), real PG)', () => {
  it('X-3 (partial) a snapshot records the drive\'s orgId and orgVisibility; a personal drive\'s records nulls', async () => {
    const result = await createDriveBackup(w.orgDriveId, w.ownerId, { source: 'manual' });
    expect(result.success).toBe(true);

    const [backup] = await db.select().from(driveBackups).where(eq(driveBackups.id, result.backupId!));
    expect(backup.orgId).toBe(w.orgId);
    expect(backup.orgVisibility).toBe('RESTRICTED');

    // A personal drive's snapshot records no org; its visibility column has
    // its (meaningless here) NOT NULL default.
    const personalDrive = await factories.createDrive(w.ownerId);
    created.driveIds.push(personalDrive.id);
    const personal = await createDriveBackup(personalDrive.id, w.ownerId, { source: 'manual' });
    const [personalBackup] = await db.select().from(driveBackups).where(eq(driveBackups.id, personal.backupId!));
    expect(personalBackup.orgId).toBeNull();
    expect(personalBackup.orgVisibility).toBe('OPEN');
  });

  it('X-3 (partial) a restore never writes the snapshot\'s org context back: a drive that moved orgs after its backup stays where it moved', async () => {
    const backup = await createDriveBackup(w.orgDriveId, w.ownerId, { source: 'manual' });
    expect(backup.success).toBe(true);

    // The drive leaves Northwind for Southwind AFTER the snapshot was taken.
    await db.update(drives).set({ orgId: w.movedOrgId, orgVisibility: 'OPEN' }).where(eq(drives.id, w.orgDriveId));
    // A page created after the backup gives the restore real work (an orphan to remove).
    const later = await factories.createPage(w.orgDriveId);
    w.laterPageId = later.id;

    const counts = await restoreBackup(backup.backupId!);
    expect(counts.skippedMembers).toEqual([]);

    const [drive] = await db.select().from(drives).where(eq(drives.id, w.orgDriveId));
    // The restore put the pages back — the orphan is gone.
    const [orphan] = await db.select().from(pages).where(eq(pages.id, w.laterPageId));
    expect(orphan.isTrashed).toBe(true);
    // …and did NOT pull the drive back to the snapshot's org.
    expect(drive.orgId).toBe(w.movedOrgId);
    expect(drive.orgVisibility).toBe('OPEN');
    // The snapshot itself still says where the drive stood when it was taken.
    const [backupRow] = await db.select().from(driveBackups).where(eq(driveBackups.id, backup.backupId!));
    expect(backupRow.orgId).toBe(w.orgId);
    expect(backupRow.orgVisibility).toBe('RESTRICTED');
  });

  it('X-3 (partial) a drive wallet\'s row survives a restore round-trip byte-identical', async () => {
    // The WHOLE row, not a cherry-picked subset: comparing a few hand-picked
    // columns would let a restore that reset `spentCents` (free money), the
    // status, the period fields or the allowance pass unnoticed. Every column
    // the wallets table carries is compared; a difference must show here.
    const [before] = await db.select().from(wallets).where(eq(wallets.id, w.driveWalletId));
    w.walletBefore = before;
    const [legBefore] = await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, w.driveWalletId));

    const backup = await createDriveBackup(w.orgDriveId, w.ownerId, { source: 'manual' });
    await restoreBackup(backup.backupId!);

    const [after] = await db.select().from(wallets).where(eq(wallets.id, w.driveWalletId));
    expect(after).toEqual(before);
    // The leg behind it too — its whole row, not just the balance: the
    // restore's ACL writes never moved money.
    const legs = await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, w.driveWalletId));
    expect(legs).toHaveLength(1);
    expect(legs[0]).toEqual(legBefore);
  });
});
