/**
 * ACCOUNT DELETION accounts for org membership, wallets and donations, against
 * a REAL Postgres (Spec X-2, deletion half).
 *
 * The pieces this walks through already existed one lane at a time: ORG-6's
 * refusal (leave.ts decideLeave), the leave cascade (leaveAllOrganizations),
 * the automation flag (D-OW-36), the suppression record (D-OW-27), and two FK
 * behaviours on the wallet schema — `wallets.userId` cascades the personal
 * root wallet while `wallet_funding_legs.funderUserId` SET NULLs. Nobody had
 * walked an account through ALL of it in one deletion. This is that walk.
 *
 * The invariant under test (X-2): deletion removes the PERSON, never the ORG
 * and never the org's money. A donation leg is the org's audit trail for money
 * that was given to it — it must survive with its amounts intact and its
 * donor's identity dropped, exactly like every other identifying column the
 * eraser nulls.
 *
 * Requires a live `DATABASE_URL` with migrations applied; fails loudly without
 * one (requireDb), following the erasure suite's integration tests.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@pagespace/db/db';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { driveMembers } from '@pagespace/db/schema/members';
import {
  organizations,
  orgMembers,
  orgMemberDepartures,
  orgDepartureSuppressions,
} from '@pagespace/db/schema/organizations';
import {
  wallets,
  walletFundingLegs,
  walletConsumerCaps,
} from '@pagespace/db/schema/wallets';
import { workflows } from '@pagespace/db/schema/workflows';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { accountRepository } from '../../../repositories/account-repository';
import { LeaveOrganizationRefusedError } from '../../../organizations/leave';

const created = {
  userIds: [] as string[],
  driveIds: [] as string[],
  orgIds: [] as string[],
};

let dbAvailable = false;

interface World {
  ownerId: string;
  memberId: string;
  orgId: string;
  orgDriveId: string;
  poolWalletId: string;
  driveWalletId: string;
  donationLegId: string;
  workflowId: string;
}
let w: World;

async function buildWorld() {
  // One transaction: the wallet-leg invariant trigger (armed by the integration
  // harness) re-checks a touched non-root wallet at COMMIT, so the wallet and
  // its funding legs must land together.
  await db.transaction(async (tx) => {
    await buildWorldIn(tx);
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function buildWorldIn(tx: Tx) {
  const owner = await factories.createUser();
  const member = await factories.createUser();
  created.userIds.push(owner.id, member.id);

  const orgId = createId();
  created.orgIds.push(orgId);
  await tx.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `nw-${createId()}`, ownerId: owner.id });
  await tx.insert(orgMembers).values([
    { orgId, userId: owner.id, role: 'OWNER' },
    { orgId, userId: member.id, role: 'MEMBER' },
  ]);

  const orgDrive = await factories.createDrive(owner.id);
  created.driveIds.push(orgDrive.id);
  await tx.update(drives).set({ orgId }).where(eq(drives.id, orgDrive.id));
  await tx.insert(driveMembers).values([
    { driveId: orgDrive.id, userId: member.id, role: 'MEMBER', source: 'org', acceptedAt: new Date() },
  ]);

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
      // D-OW-13 invariant: a non-root wallet's top-up equals its legs' sum.
      topupRemainingCents: 300,
    })
    .returning({ id: wallets.id });

  // The member donates 500 into the org drive's wallet: the org's audit trail
  // for money that was given to it.
  const [leg] = await tx
    .insert(walletFundingLegs)
    .values({
      walletId: driveWallet.id,
      funderKind: 'donation',
      funderUserId: member.id,
      originalCents: 500,
      remainingCents: 300,
      nonRefundable: true,
      sourceRef: `donation-${createId()}`,
    })
    .returning({ id: walletFundingLegs.id });

  // The member's own money: their personal root wallet and their seat cap.
  await tx.insert(wallets).values({ ownerType: 'user', userId: member.id, monthlyRemainingCents: 777 });
  await tx.insert(walletConsumerCaps).values({
    walletId: poolWallet.id,
    consumerKey: `user:${member.id}`,
    monthlyCapCents: 3_000,
  });

  // [D-OW-36] An automation the member made in the org drive.
  const [workflow] = await tx
    .insert(workflows)
    .values({ driveId: orgDrive.id, createdBy: member.id, name: 'Nightly digest', prompt: '' })
    .returning({ id: workflows.id });

  w = {
    ownerId: owner.id,
    memberId: member.id,
    orgId,
    orgDriveId: orgDrive.id,
    poolWalletId: poolWallet.id,
    driveWalletId: driveWallet.id,
    donationLegId: leg.id,
    workflowId: workflow.id,
  };
}

async function cleanup() {
  if (created.driveIds.length) await db.delete(drives).where(inArray(drives.id, created.driveIds));
  if (created.orgIds.length) await db.delete(organizations).where(inArray(organizations.id, created.orgIds));
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
    requireDb('account-deletion-orgs.integration.test.ts', error);
  }
});

beforeEach(async () => {
  if (dbAvailable) await buildWorld();
});

afterEach(async () => {
  if (dbAvailable) await cleanup();
});

afterAll(async () => {
  if (!dbAvailable) return;
  const { pool } = await import('@pagespace/db/db');
  await pool.end();
});

describe('account deletion in an org (X-2 (partial), real PG)', () => {
  it('X-2 (partial) deletes the member, not the org: org, owner membership and drive survive; the membership and its departure record go; the org keeps only the keyed suppression', async () => {
    await accountRepository.deleteUser(w.memberId);

    const [org] = await db.select().from(organizations).where(eq(organizations.id, w.orgId));
    expect(org).toBeDefined();
    const memberships = await db.select().from(orgMembers).where(eq(orgMembers.orgId, w.orgId));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ userId: w.ownerId, role: 'OWNER' });
    // Their materialized drive_members row went with the leave.
    const driveRows = await db.select().from(driveMembers).where(and(eq(driveMembers.driveId, w.orgDriveId), eq(driveMembers.userId, w.memberId)));
    expect(driveRows).toEqual([]);
    // The departure row cascaded with the account…
    const departures = await db.select().from(orgMemberDepartures).where(eq(orgMemberDepartures.userId, w.memberId));
    expect(departures).toEqual([]);
    // …and [D-OW-27] left the org the keyed suppression (a blind index, never the address).
    const suppressions = await db.select().from(orgDepartureSuppressions).where(eq(orgDepartureSuppressions.orgId, w.orgId));
    expect(suppressions).toHaveLength(1);
    for (const suppression of suppressions) {
      expect(suppression.emailHash).not.toContain('@');
    }
  });

  it('X-2 (partial) the donation leg survives the donor: amounts intact for the org\'s audit, donor identity dropped', async () => {
    await accountRepository.deleteUser(w.memberId);

    const [leg] = await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.id, w.donationLegId));
    expect(leg).toBeDefined();
    expect(leg.funderKind).toBe('donation');
    // The money the org was given does not leave with the donor.
    expect(leg.originalCents).toBe(500);
    expect(leg.remainingCents).toBe(300);
    // The donor does not ride along with it.
    expect(leg.funderUserId).toBeNull();
  });

  it('X-2 (partial) the personal root wallet goes with the account; the org\'s drive wallet and pool are untouched', async () => {
    await accountRepository.deleteUser(w.memberId);

    // The personal root wallet cascades, exactly as their credit_balances row did.
    const personalWallets = await db
      .select()
      .from(wallets)
      .where(and(eq(wallets.userId, w.memberId)));
    expect(personalWallets).toEqual([]);

    // The org's money is exactly where it was.
    const [driveWallet] = await db.select().from(wallets).where(eq(wallets.id, w.driveWalletId));
    expect(driveWallet).toBeDefined();
    expect(driveWallet.topupRemainingCents).toBe(300);
    const [pool] = await db.select().from(wallets).where(eq(wallets.id, w.poolWalletId));
    expect(pool).toBeDefined();
    expect(pool.monthlyRemainingCents).toBe(400_000);
    // Their seat cap on the pool went with the membership (a re-join starts fresh).
    const caps = await db.select().from(walletConsumerCaps).where(eq(walletConsumerCaps.walletId, w.poolWalletId));
    expect(caps).toEqual([]);
  });

  it('X-2 (partial) [D-OW-36] their org-drive automation is disabled and flagged owner-left, never deleted', async () => {
    await accountRepository.deleteUser(w.memberId);

    const [workflow] = await db.select().from(workflows).where(eq(workflows.id, w.workflowId));
    expect(workflow).toBeDefined();
    expect(workflow.isEnabled).toBe(false);
    expect(workflow.ownerLeftAt).not.toBeNull();
    // The creator column was cleared by the users cascade: nothing of theirs remains.
    expect(workflow.createdBy).toBeNull();
  });

  it('X-2 (partial) ORG-6: deleting an org Owner is refused and changes nothing', async () => {
    await expect(accountRepository.deleteUser(w.ownerId)).rejects.toBeInstanceOf(LeaveOrganizationRefusedError);

    const [org] = await db.select().from(organizations).where(eq(organizations.id, w.orgId));
    expect(org).toBeDefined();
    const [owner] = await db.select().from(users).where(eq(users.id, w.ownerId));
    expect(owner).toBeDefined();
    const memberships = await db.select().from(orgMembers).where(eq(orgMembers.orgId, w.orgId));
    expect(memberships).toHaveLength(2);
    const legs = await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.id, w.donationLegId));
    expect(legs[0].funderUserId).toBe(w.memberId);
  });
});
