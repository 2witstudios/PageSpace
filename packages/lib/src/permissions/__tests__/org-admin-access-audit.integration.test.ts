/**
 * ORG-4 audit dedupe against real Postgres: one authz.access.granted row per (user, PRIVATE org drive)
 * per 15-minute UTC window, however many resolver calls and whichever path makes them.
 *
 * Requires a running Postgres database with the latest migrations applied.
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/permissions/__tests__/org-admin-access-audit.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { pool } from '@pagespace/db/db';
import { resetAuditDbBindingForTests } from '../../audit/audit-db-binding';
import { resetDefaultSecurityAuditForTests, securityAudit } from '../../audit/security-audit';
import { canUserViewPage, getBatchPagePermissions, getUserAccessLevel, getUserDriveAccess, getUsersWhoCanViewPage } from '../permissions';
import { claimOrgAdminAuditWindow, orgAdminAuditClaim } from '../org-admin-access-audit';
import { checkDriveAccessForSearch, globSearchPages } from '../../services/drive-search-service';
import { getDriveAccess } from '../../services/drive-service';
import { cleanupNorthwind, northwind } from './fixtures/northwind-org-drives';

const flags = vi.hoisted(() => ({ orgsEnabled: true }));
vi.mock('../../organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));

/** Rows read through the audit service, so the query follows the same binding as the write. */
async function accessRows(userId: string, driveId: string) {
  const rows = await securityAudit.queryEvents({ eventType: 'authz.access.granted', resourceId: driveId });
  return rows.filter((r) => r.userId === userId);
}

/** Every audit write is fire-and-forget: let them all land before counting, then count once. */
async function settledCount(userId: string, driveId: string, atLeast: number) {
  await vi.waitFor(async () => {
    expect((await accessRows(userId, driveId)).length).toBeGreaterThanOrEqual(atLeast);
  }, { timeout: 10_000, interval: 100 });
  await new Promise((resolve) => setTimeout(resolve, 750));
  return (await accessRows(userId, driveId)).length;
}

describe('ORG-4 audit dedupe (integration)', () => {
  const AUDIT_ENV = ['ADMIN_DATABASE_URL', 'ADMIN_DB_BREAK_GLASS', 'AUDIT_TRUST_PLANE_REQUIRED'] as const;
  const savedAuditEnv = new Map<string, string | undefined>();
  const resetAuditBinding = () => {
    resetAuditDbBindingForTests();
    resetDefaultSecurityAuditForTests();
  };

  beforeAll(() => {
    for (const key of AUDIT_ENV) {
      savedAuditEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    resetAuditBinding();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupNorthwind();
  }, 120_000);

  afterAll(async () => {
    for (const [key, value] of savedAuditEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAuditBinding();
    await pool.end();
  });

  it('ORG-4 (partial) five resolver calls in one window write one audit row, whether they come as page views, realtime re-checks, AI tool checks, search hits or batch checks; a call in the next window writes a second', async () => {
    const f = await northwind();
    const { priya } = f.people;
    const finance = f.drives.finance.id;
    const salaries = f.pages.financePrivatePage.id;
    // Only Date is faked: Postgres sockets and the audit write's timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-03-04T09:01:00.000Z'));

    // Five resolver calls: a page view (getUserAccessLevel, also what realtime per-event auth
    // re-runs for every sensitive event), an AI tool check (canUserViewPage), a drive room join
    // (getUserDriveAccess), the drive route (getDriveAccess) and a batch check.
    expect(await getUserAccessLevel(priya.id, salaries)).toMatchObject({ canView: true });
    expect(await canUserViewPage(priya.id, salaries)).toBe(true);
    expect(await getUserDriveAccess(priya.id, finance)).toBe(true);
    expect(await getDriveAccess(finance, priya.id)).toMatchObject({ isAdmin: true });
    expect((await getBatchPagePermissions(priya.id, [salaries, f.pages.financePage.id])).get(salaries)?.canView).toBe(true);
    expect(await settledCount(priya.id, finance, 1)).toBe(1);

    // Search: the drive gate, then one resolution per hit.
    expect(await checkDriveAccessForSearch(finance, priya.id)).toMatchObject({ hasAccess: true });
    const hits = await globSearchPages(finance, priya.id, '*', null);
    expect(hits.results.map((r) => r.pageId).sort()).toEqual([f.pages.financePage.id, salaries].sort());
    // Concurrent calls in one process race past the memo to the guarded insert; one wins.
    await Promise.all(Array.from({ length: 5 }, () => getUserAccessLevel(priya.id, salaries)));
    expect(await settledCount(priya.id, finance, 1)).toBe(1);

    // A second process (web and realtime each hold their own memo) re-resolves in the same window:
    // a fresh module graph has an empty memo, so only the Postgres claim stands between it and a
    // second row.
    vi.resetModules();
    const secondProcess = await import('../permissions');
    const secondPool = (await import('@pagespace/db/db')).pool;
    try {
      expect(await secondProcess.getUserAccessLevel(priya.id, salaries)).toMatchObject({ canView: true });
      await Promise.all(Array.from({ length: 4 }, () => secondProcess.getUserDriveAccess(priya.id, finance)));
      expect(await settledCount(priya.id, finance, 1)).toBe(1);
    } finally {
      await secondPool.end();
    }

    // 09:14:59.999 is still the 09:00 window.
    vi.setSystemTime(new Date('2031-03-04T09:14:59.999Z'));
    await getUserAccessLevel(priya.id, salaries);
    expect(await settledCount(priya.id, finance, 1)).toBe(1);

    // The next UTC window is a new access.
    vi.setSystemTime(new Date('2031-03-04T09:15:00.000Z'));
    await getUserAccessLevel(priya.id, salaries);
    expect(await settledCount(priya.id, finance, 2)).toBe(2);

    // Deciding who else can see a page (the channel fan-out) is an audience, not an access by Jono.
    expect(await getUsersWhoCanViewPage(salaries, [f.people.jono.id])).toEqual(new Set([f.people.jono.id]));
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(await accessRows(f.people.jono.id, finance)).toEqual([]);

    // Another admin in the same window is their own access; org power on OPEN or through a row is none.
    await getUserAccessLevel(f.people.jono.id, salaries);
    expect(await settledCount(f.people.jono.id, finance, 1)).toBe(1);
    await getUserAccessLevel(priya.id, f.pages.productPrivatePage.id);
    await getUserAccessLevel(f.people.omar.id, salaries);
    expect(await accessRows(priya.id, f.drives.product.id)).toEqual([]);
    expect(await accessRows(f.people.omar.id, finance)).toEqual([]);
  }, 60_000);

  it('ORG-4 (partial) the claim is a unique key in Postgres, not process memory: a second process loses the same window and wins the next', async () => {
    const access = { userId: createId(), driveId: createId(), orgId: createId(), orgRole: 'ADMIN' as const };
    const window0900 = orgAdminAuditClaim(access, new Date('2031-03-04T09:01:00.000Z'));

    const racers = await Promise.all(Array.from({ length: 5 }, () => claimOrgAdminAuditWindow(window0900)));
    expect(racers.filter(Boolean)).toHaveLength(1);
    expect(await claimOrgAdminAuditWindow(orgAdminAuditClaim(access, new Date('2031-03-04T09:14:00.000Z')))).toBe(false);
    expect(await claimOrgAdminAuditWindow(orgAdminAuditClaim(access, new Date('2031-03-04T09:15:00.000Z')))).toBe(true);
  });
});
