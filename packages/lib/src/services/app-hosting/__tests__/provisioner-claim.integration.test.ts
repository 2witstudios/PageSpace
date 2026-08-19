/**
 * The published-app CLAIM and the status CHECK constraints, against a REAL Postgres.
 *
 * The unit tests mock the driver and assert on the statements the provisioner
 * emits. That pins what we ASK the database for; it cannot show what the database
 * actually DOES — and what it does under concurrency is the entire value of the
 * claim. "The SQL looks right" is not evidence that two workers can't both take the
 * same app and provision it twice on Fly.
 *
 * Likewise for the transition rules: `provisioner-core` claims to refuse exactly
 * what the CHECK constraints refuse. That claim is only worth something if the
 * database is asked, so every case here writes the row and watches Postgres agree.
 *
 * Excluded from the unit run (see vitest.config.ts) and executed by the security
 * workflow, which has a live Postgres. Locally:
 *   docker compose -f docker-compose.test.yml up -d postgres-test
 *   DATABASE_URL=postgresql://user:password@localhost:5433/pagespace_test \
 *     bun run --filter '@pagespace/lib' test:db -- \
 *     src/services/app-hosting/__tests__/provisioner-claim.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { publishedApps, type PublishedAppStatus } from '@pagespace/db/schema/published-apps';
import {
  claimPublishedAppsForWork,
  releasePublishedAppClaim,
  transitionPublishedApp,
  type ProvisionerDeps,
} from '../provisioner';
import { checkStatusInvariants, type PublishedAppStatusColumns } from '../provisioner-core';

const userId = createId();
const driveId = createId();

/** Hosting on: these tests are about the mechanisms behind the kill switch, not the switch. */
const deps: ProvisionerDeps = {
  isEnabled: () => true,
  resolveNetwork: () => 'published-apps',
  createFlyApp: async () => {},
  deleteFlyApp: async () => {},
  mintFlyDeployToken: async () => 'unused',
};

/** Every env this file created, so a mid-suite failure cannot leak rows into the next run. */
const envIds: string[] = [];

async function seedApp(
  status: PublishedAppStatus,
  columns: Partial<PublishedAppStatusColumns> = {},
): Promise<string> {
  const envId = createId();
  const appId = createId();
  envIds.push(envId);

  await db.insert(driveEnvs).values({
    id: envId,
    driveId,
    name: `env-${envId}`,
    createdBy: userId,
    updatedAt: new Date(),
  });
  await db.insert(publishedApps).values({
    id: appId,
    envId,
    driveId,
    ownerId: userId,
    flyAppName: `pgs-app-${appId}`,
    networkName: 'published-apps',
    subdomain: `sub-${appId}`,
    status,
    imageDigest: columns.imageDigest ?? null,
    machineId: columns.machineId ?? null,
    tier: columns.tier ?? 'metered',
  });
  return appId;
}

beforeAll(async () => {
  await db.insert(users).values({
    id: userId,
    email: `app-hosting-claim-${userId}@example.test`,
    name: 'App Hosting Claim Test',
  });
  await db.insert(drives).values({
    id: driveId,
    name: 'App Hosting Claim Test',
    slug: `app-hosting-claim-${driveId}`,
    ownerId: userId,
  });
});

afterAll(async () => {
  // published_apps cascades off drive_envs; delete the envs and the apps go with them.
  if (envIds.length > 0) await db.delete(driveEnvs).where(inArray(driveEnvs.id, envIds));
  await db.delete(drives).where(eq(drives.id, driveId));
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  if (envIds.length > 0) await db.delete(driveEnvs).where(inArray(driveEnvs.id, envIds));
  envIds.length = 0;
});

describe('claimPublishedAppsForWork — two workers, disjoint sets, AFTER the transaction commits', () => {
  it('given two claims in succession, should hand the second worker nothing — the first claim survives its transaction', async () => {
    await seedApp('building');
    await seedApp('building');

    const first = await claimPublishedAppsForWork({ statuses: ['building'], limit: 10, deps });
    // Sequential on purpose: SKIP LOCKED alone makes CONCURRENT claims disjoint,
    // and would let this second call — issued after the first transaction has
    // committed and released every lock — take the very same rows.
    const second = await claimPublishedAppsForWork({ statuses: ['building'], limit: 10, deps });

    expect(first.apps).toHaveLength(2);
    expect(second.apps).toEqual([]);
  });

  it('given two SIMULTANEOUS claims, should split the rows with no overlap', async () => {
    await seedApp('building');
    await seedApp('building');
    await seedApp('building');
    await seedApp('building');

    const [a, b] = await Promise.all([
      claimPublishedAppsForWork({ statuses: ['building'], limit: 10, deps }),
      claimPublishedAppsForWork({ statuses: ['building'], limit: 10, deps }),
    ]);

    const aIds = a.apps.map((app) => app.id);
    const bIds = b.apps.map((app) => app.id);
    const overlap = aIds.filter((id) => bIds.includes(id));

    expect(overlap, `both workers claimed: ${overlap.join(', ')}`).toEqual([]);
    expect([...aIds, ...bIds].sort()).toHaveLength(4);
  });

  it('given a claimed row, should stamp the lease and the holder in the database', async () => {
    const appId = await seedApp('building');
    const claim = await claimPublishedAppsForWork({ statuses: ['building'], limit: 10, deps });

    const [row] = await db.select().from(publishedApps).where(eq(publishedApps.id, appId));
    expect(row.claimedBy).toBe(claim.token);
    expect(row.claimedAt).toBeInstanceOf(Date);
    expect(claim.apps[0].claimedBy).toBe(claim.token);
  });

  it('given a claim whose lease has expired, should let the next worker take the row', async () => {
    const appId = await seedApp('building');
    await claimPublishedAppsForWork({ statuses: ['building'], limit: 10, deps });

    // A worker that crashed mid-provision must cost one lease interval, not the row.
    await db
      .update(publishedApps)
      .set({ claimedAt: sql`now() - interval '1 hour'` })
      .where(eq(publishedApps.id, appId));

    const next = await claimPublishedAppsForWork({
      statuses: ['building'],
      limit: 10,
      leaseMs: 60_000,
      deps,
    });
    expect(next.apps.map((app) => app.id)).toEqual([appId]);
  });

  it('given a released claim, should be claimable again immediately', async () => {
    const appId = await seedApp('building');
    const claim = await claimPublishedAppsForWork({ statuses: ['building'], limit: 10, deps });

    expect(await releasePublishedAppClaim([appId], claim.token, deps)).toBe(1);

    const next = await claimPublishedAppsForWork({ statuses: ['building'], limit: 10, deps });
    expect(next.apps.map((app) => app.id)).toEqual([appId]);
  });

  it('given a release with the wrong token, should free nothing — a superseded worker cannot revoke the new holder', async () => {
    const appId = await seedApp('building');
    await claimPublishedAppsForWork({ statuses: ['building'], limit: 10, deps });

    expect(await releasePublishedAppClaim([appId], createId(), deps)).toBe(0);

    const next = await claimPublishedAppsForWork({ statuses: ['building'], limit: 10, deps });
    expect(next.apps).toEqual([]);
  });

  it('given a row in another status, should not be claimed', async () => {
    await seedApp('running', { imageDigest: 'sha256:abc', machineId: 'm1' });
    const claim = await claimPublishedAppsForWork({ statuses: ['building'], limit: 10, deps });
    expect(claim.apps).toEqual([]);
  });
});

/**
 * The build reconciler's premise is "this app has been building for twenty minutes,
 * so its worker is dead". That question is answered by `updatedAt` — and CLAIMING
 * WRITES THE ROW, which bumps `updatedAt` via drizzle's `$onUpdate`. A mocked test
 * can show the predicate we emit; only a real Postgres shows that the age filter is
 * evaluated against the PRE-CLAIM timestamp and that a fresh row is genuinely
 * invisible to a stale-only claim.
 */
describe('claimPublishedAppsForWork — the staleness filter is the query’s, not the caller’s', () => {
  it('given a row that has just moved, should not be claimed by a stale-only pass', async () => {
    await seedApp('building');
    const claim = await claimPublishedAppsForWork({
      statuses: ['building'],
      limit: 10,
      staleForMs: 60_000,
      deps,
    });
    expect(claim.apps).toEqual([]);
  });

  it('given a row that has sat past the horizon, should claim it', async () => {
    const appId = await seedApp('building');
    await db
      .update(publishedApps)
      .set({ updatedAt: sql`now() - interval '1 hour'` })
      .where(eq(publishedApps.id, appId));

    const claim = await claimPublishedAppsForWork({
      statuses: ['building'],
      limit: 10,
      staleForMs: 60_000,
      deps,
    });
    expect(claim.apps.map((app) => app.id)).toEqual([appId]);
  });

  it('given a claim, should bump updatedAt — which is why the filter cannot live in the caller', async () => {
    const appId = await seedApp('building');
    await db
      .update(publishedApps)
      .set({ updatedAt: sql`now() - interval '1 hour'` })
      .where(eq(publishedApps.id, appId));

    await claimPublishedAppsForWork({ statuses: ['building'], limit: 10, staleForMs: 60_000, deps });

    const [row] = await db.select().from(publishedApps).where(eq(publishedApps.id, appId));
    expect(row.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});

/**
 * `imageSizeBytes` feeds the economics dashboard's SUM. A negative value there is
 * not a small number, it is a silent credit against every other app's storage cost
 * — so the column is CHECK-constrained, and this is the test that the database
 * actually enforces it rather than the schema merely describing it.
 */
describe('published_apps.imageSizeBytes — the economics column', () => {
  it('given a negative size, should be rejected by Postgres', async () => {
    const appId = await seedApp('building');
    const error = await db
      .update(publishedApps)
      .set({ imageSizeBytes: -1 })
      .where(eq(publishedApps.id, appId))
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error, 'Postgres accepted a negative image size').not.toBe(null);
    // Drizzle wraps the driver error; the constraint name is on the cause, and
    // naming it is what makes this a test of THIS constraint rather than of any
    // failure at all.
    const cause = (error as { cause?: { constraint?: string } })?.cause;
    expect(cause?.constraint).toBe('published_apps_image_size_nonneg');
  });

  it('given a size beyond 32 bits, should round-trip — images are gigabytes', async () => {
    const appId = await seedApp('building');
    await db
      .update(publishedApps)
      .set({ imageSizeBytes: 8_000_000_000 })
      .where(eq(publishedApps.id, appId));

    const [row] = await db.select().from(publishedApps).where(eq(publishedApps.id, appId));
    expect(row.imageSizeBytes).toBe(8_000_000_000);
  });

  it('given no size, should stay null — absent is a legal answer', async () => {
    const appId = await seedApp('building');
    const [row] = await db.select().from(publishedApps).where(eq(publishedApps.id, appId));
    expect(row.imageSizeBytes).toBe(null);
  });
});

describe('transitionPublishedApp — the pure rules and the CHECK constraints agree', () => {
  /**
   * The LEAST a row must carry to exist in a given status at all — no more, so the
   * next transition is judged against a row that supplies nothing it wasn't already
   * obliged to. `deploying` therefore has an image and no machine, which is exactly
   * the state from which `running` must be refused.
   */
  function minimalColumnsFor(status: PublishedAppStatus): PublishedAppStatusColumns {
    return {
      imageDigest: status === 'running' || status === 'deploying' ? 'sha256:abc' : null,
      machineId: status === 'running' ? 'm1' : null,
      tier: 'metered',
    };
  }
  const edges: Array<[PublishedAppStatus, PublishedAppStatus]> = [
    ['provisioning', 'building'],
    ['building', 'deploying'],
    ['deploying', 'running'],
    ['running', 'stopped'],
    ['stopped', 'running'],
    ['running', 'parked'],
    ['stopped', 'parked'],
    ['parked', 'stopped'],
    ['failed', 'provisioning'],
    ['provisioning', 'destroying'],
    ['building', 'failed'],
  ];

  for (const [from, to] of edges) {
    it(`given ${from} -> ${to} on a minimally-populated row, should refuse exactly when the database would`, async () => {
      const columns = minimalColumnsFor(from);
      const appId = await seedApp(from, columns);
      const result = await transitionPublishedApp(appId, to, { deps });

      const violation = checkStatusInvariants(to, columns);
      if (violation === null) {
        expect(result, `core refused a write the database accepts`).toMatchObject({ ok: true });
        return;
      }

      // The core refused. Prove the database would have too, by attempting the raw
      // write the provisioner declined to make.
      expect(result).toEqual({ ok: false, reason: violation });
      await expect(
        db.update(publishedApps).set({ status: to }).where(eq(publishedApps.id, appId)),
      ).rejects.toThrow();
    });
  }

  it('given running with the machine id supplied in the same write, should commit', async () => {
    const appId = await seedApp('deploying', { imageDigest: 'sha256:abc' });
    const result = await transitionPublishedApp(appId, 'running', {
      patch: { machineId: 'm7' },
      deps,
    });

    expect(result.ok).toBe(true);
    const [row] = await db.select().from(publishedApps).where(eq(publishedApps.id, appId));
    expect(row.status).toBe('running');
    expect(row.machineId).toBe('m7');
  });

  it('given a dedicated app being parked, should refuse — and the database would too', async () => {
    const appId = await seedApp('running', {
      imageDigest: 'sha256:abc',
      machineId: 'm1',
      tier: 'dedicated',
    });

    expect(await transitionPublishedApp(appId, 'parked', { deps })).toEqual({
      ok: false,
      reason: 'parked_is_metered_only',
    });
    await expect(
      db.update(publishedApps).set({ status: 'parked' }).where(eq(publishedApps.id, appId)),
    ).rejects.toThrow();
  });
});
