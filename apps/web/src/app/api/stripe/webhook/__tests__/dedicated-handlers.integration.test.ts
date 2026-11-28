/**
 * The dedicated-hosting webhook against a real Postgres (Spec WAL-9, D-OW-64): an org's dedicated
 * subscription keeps working after the Owner or Admin who bought it deletes their account. The
 * mirror's buyer FK is SET NULL; the webhook must take the payer from that stored row, never write
 * the deleted buyer's id from Stripe metadata back (which would fail the FK and wedge every later
 * event), and the app's tier must still follow the subscription.
 *
 * REAL: the mirror read and write (findDedicatedSubscriptionByStripeId, resolveDedicatedPayer,
 * recordDedicatedSubscription) and every FK. Spied: the tier sync, which reaches Fly.
 *
 * Requires DATABASE_URL → a migrated Postgres. Deletes every row it creates.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { organizations } from '@pagespace/db/schema/organizations';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { publishedAppSubscriptions } from '@pagespace/db/schema/published-app-subscriptions';
import { factories } from '@pagespace/db/test/factories';
import type { Stripe } from '@/lib/stripe';
import { ensureTestDb } from '@/test/ensure-test-db';

const { mockSync } = vi.hoisted(() => ({ mockSync: vi.fn() }));
vi.mock('@pagespace/lib/services/app-hosting/dedicated-tier-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/app-hosting/dedicated-tier-service')>()),
  syncAppTierToSubscription: mockSync,
}));

import { handleDedicatedSubscriptionEvent } from '../dedicated-handlers';

const created = { userIds: [] as string[], orgIds: [] as string[], driveIds: [] as string[] };
const originalHosting = process.env.APP_HOSTING_ENABLED;

beforeAll(ensureTestDb);

afterEach(async () => {
  process.env.APP_HOSTING_ENABLED = originalHosting;
  if (created.driveIds.length > 0) {
    await db.delete(publishedApps).where(inArray(publishedApps.driveId, created.driveIds));
    await db.delete(driveEnvs).where(inArray(driveEnvs.driveId, created.driveIds));
    await db.delete(drives).where(inArray(drives.id, created.driveIds));
  }
  if (created.orgIds.length > 0) await db.delete(organizations).where(inArray(organizations.id, created.orgIds));
  if (created.userIds.length > 0) await db.delete(users).where(inArray(users.id, created.userIds));
  created.userIds = [];
  created.orgIds = [];
  created.driveIds = [];
});

describe('the dedicated-hosting webhook outlives the buyer', () => {
  it('WAL-9 (partial) after the org Admin who bought it deletes their account, a subscription event still succeeds — the buyer stays null, the org stays, and the tier syncs from the stored row', async () => {
    process.env.APP_HOSTING_ENABLED = 'true';
    mockSync.mockResolvedValue({ outcome: 'downgraded', publishedAppId: 'x', tierChanged: true });
    const owner = await factories.createUser({ name: 'Jono' });
    const admin = await factories.createUser({ name: 'Short-lived admin' });
    created.userIds.push(owner.id);
    const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: owner.id }).returning();
    created.orgIds.push(org.id);
    const drive = await factories.createDrive(owner.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id });
    created.driveIds.push(drive.id);
    const envId = createId();
    await db.insert(driveEnvs).values({ id: envId, driveId: drive.id, name: `env-${envId}`, createdBy: owner.id, updatedAt: new Date() } as never);
    const appId = createId();
    await db.insert(publishedApps).values({
      id: appId, envId, driveId: drive.id, ownerId: owner.id, flyAppName: `pgs-${appId}`, networkName: 'published-apps',
      subdomain: `wh-${appId}`, machineId: `m-${appId}`, status: 'running', tier: 'dedicated', imageDigest: 'sha256:abc', updatedAt: new Date(),
    } as never);
    const subId = `sub_${appId}`;
    await db.insert(publishedAppSubscriptions).values({
      publishedAppId: appId, userId: admin.id, orgId: org.id, stripeSubscriptionId: subId, stripePriceId: 'price_small',
      guestPreset: 'shared-cpu-1x-512', status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    });
    await db.delete(users).where(eq(users.id, admin.id));

    const now = Math.floor(Date.now() / 1000);
    await handleDedicatedSubscriptionEvent({
      id: subId,
      status: 'canceled',
      cancel_at_period_end: false,
      metadata: { kind: 'published_app_dedicated', publishedAppId: appId, guestPreset: 'shared-cpu-1x-512', userId: admin.id, orgId: org.id },
      items: { data: [{ price: { id: 'price_small' }, current_period_start: now, current_period_end: now + 30 * 86_400 }] },
    } as unknown as Stripe.Subscription, 'evt_deleted_buyer', now + 60);

    const [mirror] = await db.select().from(publishedAppSubscriptions).where(eq(publishedAppSubscriptions.publishedAppId, appId));
    expect(mirror).toMatchObject({ userId: null, orgId: org.id, status: 'canceled' });
    expect(mockSync).toHaveBeenCalledWith(expect.objectContaining({ publishedAppId: appId, status: 'canceled' }));
  });
});
