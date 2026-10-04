/**
 * A drive wallet write and its org audit event belong to the drive's org AT COMMIT (AUD-1), even when the
 * drive moves into or out of an org at the same moment. Real Postgres; the move runs on its own
 * connection while the wallet write is in flight.
 *
 * Every row is deleted in dependency order (wallets, drives, members, org, users last).
 *
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/services/__tests__/drive-wallet-attribution.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { wallets } from '@pagespace/db/schema/wallets';
import { createDriveWallet, donateToDrive, updateDriveWallet } from '../drive-wallet-service';
import { moveDriveOutOfOrg, type OrgDriveServiceDeps } from '../org-drive-service';
import { orgDriveServiceDeps } from '../org-drive-service-deps';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

const audit = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../../audit/org-audit', () => ({
  recordOrgAuditEvent: vi.fn(async () => {}),
  recordOrgAuditEventAfterCommit: vi.fn(async (event: Record<string, unknown>) => {
    audit.events.push(event);
    return true;
  }),
}));

const deps: OrgDriveServiceDeps = { ...orgDriveServiceDeps, syncOrgMembership: async () => async () => {} };
const HOLD_MS = 400;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const created = { orgs: [] as string[], users: [] as string[] };
const originalMode = process.env.DEPLOYMENT_MODE;

async function northwind() {
  const [jono, marcus] = await Promise.all(['Jono', 'Marcus Oyelaran'].map((name) => factories.createUser({ name, subscriptionTier: 'free' })));
  created.users.push(jono.id, marcus.id);
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(jono.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, monthlyRemainingCents: 900_000 });
  // Marcus's own credits, so he can donate.
  await db.insert(wallets).values({ userId: marcus.id, monthlyRemainingCents: 5_000, monthlyPeriodStart: new Date(), monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000) });
  expect(await createDriveWallet(jono.id, product.id, { allocationCents: 10_000 }, 'session')).toMatchObject({ ok: true });
  await updateDriveWallet(jono.id, product.id, { donationsEnabled: true }, 'session');
  audit.events.length = 0;
  return { orgId: org.id, jono, marcus, driveId: product.id };
}

const walletOf = async (driveId: string) =>
  (await db.select().from(wallets).where(eq(wallets.subjectId, driveId)))[0];
const walletEvents = () => audit.events.filter((e) => String(e.eventType).startsWith('org.wallet.'));

describe('drive wallet events follow the drive\'s org at commit', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
    } catch (error) {
      requireDb('drive-wallet-attribution.integration.test.ts', error);
    }
    process.env.DEPLOYMENT_MODE = 'cloud';
  });

  afterEach(async () => {
    const orgIds = created.orgs.splice(0);
    const userIds = created.users.splice(0);
    if (orgIds.length > 0) {
      const driveIds = (await db.select({ id: drives.id }).from(drives).where(inArray(drives.ownerId, userIds))).map((d) => d.id);
      if (driveIds.length > 0) {
        await db.delete(wallets).where(inArray(wallets.subjectId, driveIds));
        await db.delete(drives).where(inArray(drives.id, driveIds));
      }
      await db.delete(wallets).where(inArray(wallets.orgId, orgIds));
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    if (userIds.length > 0) {
      await db.delete(wallets).where(inArray(wallets.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    audit.events.length = 0;
  });

  afterAll(() => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
  });

  it('AUD-1 (partial) a move that lands between the access decision and the write refuses the write: nothing changes, and no event is filed under the org the drive left', async () => {
    const w = await northwind();
    const result = await updateDriveWallet(w.jono.id, w.driveId, { paused: true }, 'session', {
      afterAccess: async () => {
        expect((await moveDriveOutOfOrg(w.jono.id, w.driveId, { implicitMembers: 'keep' }, deps)).ok).toBe(true);
      },
    });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'drive_moved' });
    expect((await walletOf(w.driveId)).status).toBe('active');
    expect(walletEvents()).toEqual([]);
  });

  it('AUD-1 (partial) a move contending with an in-flight write waits for it (separate connections): the write commits under the org the drive is in, then the drive moves', async () => {
    const w = await northwind();
    let moveSettled = false;
    let move: Promise<unknown> = Promise.resolve();
    let movedWhileHeld = true;
    const result = await updateDriveWallet(w.jono.id, w.driveId, { paused: true }, 'session', {
      afterDriveLock: async () => {
        move = moveDriveOutOfOrg(w.jono.id, w.driveId, { implicitMembers: 'keep' }, deps).finally(() => { moveSettled = true; });
        await sleep(HOLD_MS);
        movedWhileHeld = moveSettled;
      },
    });
    expect(movedWhileHeld).toBe(false);
    expect(result).toMatchObject({ ok: true });
    await move;
    expect((await db.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, w.driveId)))[0].orgId).toBeNull();
    expect(walletEvents()).toEqual([expect.objectContaining({ eventType: 'org.wallet.allocation_changed', orgId: w.orgId, driveId: w.driveId })]);
  });

  it('AUD-1 (partial) a donation is held to the same rule: a move in between refuses it and moves no money', async () => {
    const w = await northwind();
    const before = await walletOf(w.driveId);
    const result = await donateToDrive(w.marcus.id, w.driveId, { amountCents: 100, idempotencyKey: createId() }, 'session', {
      afterAccess: async () => {
        expect((await moveDriveOutOfOrg(w.jono.id, w.driveId, { implicitMembers: 'keep' }, deps)).ok).toBe(true);
      },
    });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'drive_moved' });
    expect((await walletOf(w.driveId)).topupRemainingCents).toBe(before.topupRemainingCents);
    expect(walletEvents()).toEqual([]);
  });
});
