/**
 * ART 15 SCOPE for the org and wallet tables, against a REAL Postgres (Spec X-2).
 *
 * B1 left `organizations`, `org_members`, `drive_join_requests`,
 * `org_member_departures`, `org_guest_holds`, `wallets`,
 * `wallet_funding_legs` and `drive_spend_overrides` excluded from the export
 * pending this leaf. This is the leaf: the collectors exist, and these cases
 * pin the boundary they draw — the subject's OWN org rows and OWN money, in
 * both directions.
 *
 * The direction that must never drift (SPEND-9, D18): one subject, one
 * org, TWO members with their own wallets and their own donations into the
 * SAME drive wallet. The export carries the subject's legs and their seat
 * allowance, and must carry NOTHING of the other member's — not their legs,
 * not their balance, not the pool's row. A collector keyed on anything wider
 * than `funderUserId`/`userId` fails here.
 *
 * Chain-mocked unit tests cannot express this: the thing under test is a
 * PREDICATE over rows whose ownership and whose visibility disagree.
 *
 * Requires a live `DATABASE_URL` with migrations applied. It does NOT skip
 * when one is missing, following `content-tags-export.integration.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { inArray } from 'drizzle-orm';
import { db } from '@pagespace/db/db';
import { drives } from '@pagespace/db/schema/core';
import {
  organizations,
  orgMembers,
  orgMemberDepartures,
} from '@pagespace/db/schema/organizations';
import { driveJoinRequests } from '@pagespace/db/schema/drive-join-requests';
import { orgGuestHolds } from '@pagespace/db/schema/org-guest-holds';
import {
  wallets,
  walletFundingLegs,
  walletConsumerCaps,
  driveSpendOverrides,
} from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import {
  collectUserDrives,
  collectUserOrganizations,
  collectUserOrgMembership,
  collectUserWallet,
} from '../gdpr-export';

type DB = Parameters<typeof collectUserDrives>[0];
const database = db as unknown as DB;

/** The data subject: a member of Northwind, once of Southwind. */
let subjectId: string;
/** Another Northwind member with their own money — the SPEND-9 boundary. */
let otherMemberId: string;
/** Owns both orgs and the org drive. */
let ownerId: string;

let orgId: string;
let leftOrgId: string;
let orgDriveId: string;
let personalDriveId: string;
let driveWalletId: string;
let poolWalletId: string;
let subjectWalletId: string;
let subjectDonationLegId: string;

const created = {
  users: [] as string[],
  drives: [] as string[],
  orgs: [] as string[],
};

beforeAll(async () => {
  // One transaction: the wallet-leg invariant trigger (armed by the integration
  // harness) re-checks a touched non-root wallet at COMMIT, so a wallet and its
  // funding legs must land together.
  await db.transaction(async (tx) => {
    const [subject, otherMember, owner] = await Promise.all([
      factories.createUser(),
      factories.createUser(),
      factories.createUser(),
    ]);
    subjectId = subject.id;
    otherMemberId = otherMember.id;
    ownerId = owner.id;
    created.users.push(subjectId, otherMemberId, ownerId);

    // Northwind: the org the subject still belongs to. Southwind: the one they left.
    orgId = createId();
    leftOrgId = createId();
    created.orgs.push(orgId, leftOrgId);
    await tx.insert(organizations).values([
      { id: orgId, name: 'Northwind', slug: `nw-${createId()}`, ownerId },
      { id: leftOrgId, name: 'Southwind', slug: `sw-${createId()}`, ownerId },
    ]);
    await tx.insert(orgMembers).values([
      { orgId, userId: ownerId, role: 'OWNER' },
      { orgId, userId: subjectId, role: 'MEMBER' },
      { orgId, userId: otherMemberId, role: 'MEMBER' },
      // The departed membership of the org the subject LEFT (the live membership
      // is gone; the departure record is what survived it).
      { orgId: leftOrgId, userId: ownerId, role: 'OWNER' },
    ]);
    await tx.insert(orgMemberDepartures).values({
      orgId: leftOrgId,
      userId: subjectId,
      reason: 'left',
    });

    // An org drive (with its wallet and the org pool behind it) and the
    // subject's personal drive (with a wallet the subject owner-funds).
    const orgDrive = await factories.createDrive(ownerId);
    const personalDrive = await factories.createDrive(subjectId);
    orgDriveId = orgDrive.id;
    personalDriveId = personalDrive.id;
    created.drives.push(orgDriveId, personalDriveId);
    await tx.update(drives).set({ orgId }).where(inArray(drives.id, [orgDriveId]));
    // O-6: an org member's access to an org drive is a MATERIALIZED drive_members
    // row (source 'org') — exactly what collectUserDrives reads.
    const { driveMembers } = await import('@pagespace/db/schema/members');
    await tx.insert(driveMembers).values([
      { driveId: orgDriveId, userId: subjectId, role: 'MEMBER', source: 'org', acceptedAt: new Date() },
    ]);

    [poolWalletId, driveWalletId] = [createId(), createId()];
    await tx.insert(wallets).values([
      // The org POOL: the org's money. Never the subject's, never exported.
      {
        id: poolWalletId,
        ownerType: 'org',
        orgId,
        monthlyRemainingCents: 500_000,
      },
      // The org drive's wallet, fed by the pool, holding BOTH members' donations.
      // D-OW-13 invariant: a non-root wallet's top-up equals its legs' sum.
      {
        id: driveWalletId,
        ownerType: 'org',
        orgId,
        subjectType: 'drive',
        subjectId: orgDriveId,
        parentWalletId: poolWalletId,
        topupRemainingCents: 1_200,
      },
    ]);

    // The seat allowance: a consumer cap on the pool keyed per member (WAL-7).
    // The OTHER member has one too — a wider collector would sweep it in.
    await tx.insert(walletConsumerCaps).values([
      { walletId: poolWalletId, consumerKey: `user:${subjectId}`, monthlyCapCents: 3_000 },
      { walletId: poolWalletId, consumerKey: `user:${otherMemberId}`, monthlyCapCents: 9_000 },
    ]);

    // Personal root wallets — the rows credit_balances became (X-5).
    const [subjectWallet] = await tx
      .insert(wallets)
      .values({ ownerType: 'user', userId: subjectId, monthlyRemainingCents: 1_234 })
      .returning({ id: wallets.id });
    subjectWalletId = subjectWallet.id;
    await tx
      .insert(wallets)
      .values({ ownerType: 'user', userId: otherMemberId, monthlyRemainingCents: 9_876 });

    // The legs. The subject donated 500 into the org drive wallet and
    // owner-funded their own drive's wallet for 700; the other member donated
    // 1,000 into the SAME org drive wallet — the row the subject's export must
    // never carry.
    const personalDriveWallet = createId();
    await tx.insert(wallets).values({
      id: personalDriveWallet,
      ownerType: 'user',
      userId: subjectId,
      subjectType: 'drive',
      subjectId: personalDriveId,
      parentWalletId: subjectWalletId,
      topupRemainingCents: 700,
    });
    const legs = await tx
      .insert(walletFundingLegs)
      .values([
        {
          walletId: driveWalletId,
          funderKind: 'donation',
          funderUserId: subjectId,
          originalCents: 500,
          remainingCents: 200,
          nonRefundable: true,
          sourceRef: `donation-${createId()}`,
        },
        {
          walletId: personalDriveWallet,
          funderKind: 'owner',
          funderUserId: subjectId,
          originalCents: 700,
          remainingCents: 700,
          nonRefundable: false,
          sourceRef: `topup-${createId()}`,
        },
        {
          walletId: driveWalletId,
          funderKind: 'donation',
          funderUserId: otherMemberId,
          originalCents: 1_000,
          remainingCents: 1_000,
          nonRefundable: true,
          sourceRef: `donation-${createId()}`,
        },
      ])
      .returning({ id: walletFundingLegs.id });
    subjectDonationLegId = legs[0].id;

    // The subject asked to join the org drive (Restricted) with a note; someone
    // else asked too.
    await tx.insert(driveJoinRequests).values([
      { driveId: orgDriveId, userId: subjectId, status: 'pending', message: 'please, I need in' },
      { driveId: orgDriveId, userId: otherMemberId, status: 'pending', message: 'other person asking' },
    ]);

    // A hold parked the subject's guest access on the org drive; another
    // member's hold sits beside it.
    await tx.insert(orgGuestHolds).values([
      {
        orgId,
        driveId: orgDriveId,
        userId: subjectId,
        state: 'suspended',
        origin: 'page_grant',
        request: {},
        parked: { member: { userId: subjectId, role: 'MEMBER' }, grants: [] },
      },
      {
        orgId,
        driveId: orgDriveId,
        userId: otherMemberId,
        state: 'suspended',
        origin: 'page_grant',
        request: {},
        parked: { member: { userId: otherMemberId, role: 'MEMBER' }, grants: [] },
      },
    ]);

    // SPEND-5: the subject's "always my own credits" switch in the org drive.
    await tx.insert(driveSpendOverrides).values({ userId: subjectId, driveId: orgDriveId });
  });
});

afterAll(async () => {
  // Children before parents; users last.
  if (created.drives.length) await db.delete(drives).where(inArray(drives.id, created.drives));
  if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs));
  if (created.users.length) {
    const { users } = await import('@pagespace/db/schema/auth');
    await db.delete(users).where(inArray(users.id, created.users));
  }
  const { pool } = await import('@pagespace/db/db');
  await pool.end();
});

describe('GDPR export org + wallet scope (X-2 partial, real PG)', () => {
  it('X-2 (partial) exports the orgs the subject OWNS, and only those', async () => {
    expect(await collectUserOrganizations(database, subjectId)).toEqual([]);
    const owned = await collectUserOrganizations(database, ownerId);
    expect(owned.map((org) => org.id).sort()).toEqual([orgId, leftOrgId].sort());
    for (const org of owned) {
      // The org row's identity travels; its policies, billing and domains do not.
      expect(Object.keys(org).sort()).toEqual(['createdAt', 'id', 'name', 'slug']);
    }
  });

  it('X-2 (partial) exports the subject\'s membership with THEIR seat allowance — not the pool balance, not the other member\'s allowance', async () => {
    const file = await collectUserOrgMembership(database, subjectId);
    expect(file.memberships).toHaveLength(1);
    expect(file.memberships[0]).toMatchObject({
      orgId,
      orgName: 'Northwind',
      role: 'MEMBER',
      seatAllowanceCents: 3_000,
    });
    // The pool's balance (500_000) appears nowhere in the membership file.
    expect(JSON.stringify(file.memberships)).not.toContain('500000');
    // The other member's 9_000 allowance is theirs.
    expect(JSON.stringify(file.memberships)).not.toContain('9000');
  });

  it('X-2 (partial) exports the subject\'s departures, join requests (with their own note) and guest holds — only their own', async () => {
    const file = await collectUserOrgMembership(database, subjectId);

    expect(file.departures).toHaveLength(1);
    expect(file.departures[0]).toMatchObject({ orgId: leftOrgId, orgName: 'Southwind', reason: 'left' });

    expect(file.joinRequests).toHaveLength(1);
    expect(file.joinRequests[0]).toMatchObject({
      driveId: orgDriveId,
      driveName: orgDriveId && (await db.select({ name: drives.name }).from(drives).where(inArray(drives.id, [orgDriveId])))[0].name,
      status: 'pending',
      message: 'please, I need in',
    });
    expect(JSON.stringify(file.joinRequests)).not.toContain('other person asking');

    expect(file.guestHolds).toHaveLength(1);
    expect(file.guestHolds[0]).toMatchObject({ driveId: orgDriveId, state: 'suspended', origin: 'page_grant' });
    // The parked snapshot is the subject's own member row.
    expect(JSON.stringify(file.guestHolds[0].parked)).toContain(subjectId);
    expect(JSON.stringify(file.guestHolds)).not.toContain(otherMemberId);
  });

  it('X-2 (partial) exports the personal root wallet and BOTH legs the subject funded — never the pool, never the other member\'s donation (SPEND-9/D18)', async () => {
    const walletFile = await collectUserWallet(database, subjectId);

    expect(walletFile.wallet).toMatchObject({ id: subjectWalletId, monthlyRemainingCents: 1_234 });

    expect(walletFile.fundingLegs).toHaveLength(2);
    const donation = walletFile.fundingLegs.find((leg) => leg.id === subjectDonationLegId);
    expect(donation).toMatchObject({
      walletId: driveWalletId,
      walletOwnerType: 'org',
      walletSubjectType: 'drive',
      funderKind: 'donation',
      originalCents: 500,
      remainingCents: 200,
      nonRefundable: true,
    });
    // The destination is named readably: the drive's NAME rides along.
    expect(donation?.walletSubjectDriveName).toBeTruthy();
    // The other member's 1,000-credit donation is in the same wallet and is
    // not here — not its amounts, not its id.
    const serialized = JSON.stringify(walletFile);
    expect(serialized).not.toContain('1000,"remainingCents":1000');
    expect(walletFile.fundingLegs.map((leg) => leg.originalCents).sort()).toEqual([500, 700]);

    // The org pool's row never enters the wallet file in any form.
    expect(serialized).not.toContain(poolWalletId);

    expect(walletFile.spendOverrides).toEqual([{ driveId: orgDriveId, createdAt: expect.any(Date) }]);
  });

  it('X-2 (partial) names the org on every drive row it exports — org drives and personal drives are distinguishable in the subject\'s own bundle', async () => {
    const drivesExport = await collectUserDrives(database, subjectId);
    const byId = new Map(drivesExport.map((drive) => [drive.id, drive]));
    expect(byId.get(orgDriveId)?.orgId).toBe(orgId);
    expect(byId.get(personalDriveId)?.orgId).toBeNull();
  });
});
