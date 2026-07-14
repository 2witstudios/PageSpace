/**
 * Hard-purge guard integration test (Sprites Idle-Cost Remediation).
 *
 * The guard is pure SQL — a NOT EXISTS against the two Sprite-tracking tables —
 * so the only test that proves anything is one that runs it against a real
 * Postgres. It asserts the exact failure we found in production: a trashed page
 * whose Sprite teardown never confirmed must NOT be hard-deleted, because
 * `machine_sessions.pageId` / `machine_branches.machineId` FK-cascade off
 * `pages.id` and the purge would destroy the only pointer (`sandboxId`) to a
 * live, billing microVM.
 *
 * It also pins the OTHER half of the guard, which is just as load-bearing: a
 * branch row whose Sprite was already reclaimed (`spriteTornDownAt` stamped)
 * still EXISTS — it is the user's re-creatable branch config — and must NOT hold
 * the page back. A guard keyed on row existence alone would make every
 * torn-down Machine permanently unpurgeable, silently breaking the 30-day
 * GDPR Art. 17 retention promise.
 *
 * Requires DATABASE_URL to point at a running Postgres with migrations applied
 * (see scripts/test-with-db.sh); self-skips otherwise, like the other
 * *.integration.test.ts suites here.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { machineSessions } from '@pagespace/db/schema/machine-sessions';
import { machineBranches } from '@pagespace/db/schema/machine-branches';
import { pageRepository } from '../page-repository';

const USER_ID = 'purge-guard-user';
const DRIVE_ID = 'purge-guard-drive';
const PLAIN_PAGE = 'purge-guard-plain';
const SESSION_MACHINE = 'purge-guard-session-machine';
const BRANCH_MACHINE = 'purge-guard-branch-machine';
const RECLAIMED_MACHINE = 'purge-guard-reclaimed-machine';
const TORNDOWN_BRANCH_MACHINE = 'purge-guard-torndown-branch-machine';
const ALL_PAGES = [PLAIN_PAGE, SESSION_MACHINE, BRANCH_MACHINE, RECLAIMED_MACHINE, TORNDOWN_BRANCH_MACHINE];

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
/** Trashed 40 days ago — comfortably past the 30-day purge cutoff below. */
const TRASHED_AT = new Date(NOW - 40 * DAY_MS);
const PURGE_CUTOFF = new Date(NOW - 30 * DAY_MS);

let dbAvailable = false;

async function cleanup() {
  await db.delete(machineBranches).where(inArray(machineBranches.machineId, ALL_PAGES));
  await db.delete(machineSessions).where(inArray(machineSessions.pageId, ALL_PAGES));
  await db.delete(pages).where(inArray(pages.id, ALL_PAGES));
  await db.delete(drives).where(eq(drives.id, DRIVE_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
}

async function seed() {
  await db.insert(users).values({ id: USER_ID, name: 'purge-guard', email: `${USER_ID}@example.test` });
  await db.insert(drives).values({ id: DRIVE_ID, name: 'Purge Guard', slug: USER_ID, ownerId: USER_ID });

  await db.insert(pages).values(
    ALL_PAGES.map((id, index) => ({
      id,
      title: id,
      type: id === PLAIN_PAGE ? ('DOCUMENT' as const) : ('MACHINE' as const),
      driveId: DRIVE_ID,
      position: index,
      isTrashed: true,
      trashedAt: TRASHED_AT,
    })),
  );

  // A Machine whose OWN Sprite teardown never confirmed — its machine_sessions
  // row still exists (the row is only removed after a confirmed kill).
  await db.insert(machineSessions).values({
    sessionKey: `${SESSION_MACHINE}-key`,
    pageId: SESSION_MACHINE,
    userId: USER_ID,
    sandboxId: 'pgs-sbx-orphan-session',
  });

  // A Machine whose BRANCH-terminal Sprite teardown never confirmed.
  await db.insert(machineBranches).values({
    ownerId: USER_ID,
    machineId: BRANCH_MACHINE,
    projectName: 'repo',
    branchName: 'feature',
    sessionKey: `${BRANCH_MACHINE}-key`,
    sandboxId: 'pgs-sbx-orphan-branch',
  });

  // A Machine whose branch Sprite WAS confirmed killed: the branch row survives
  // (it is re-creatable config, and its agent terminals cascade off it) but is
  // STAMPED, so it points at no live Sprite and must NOT block the purge — the
  // GDPR Art. 17 retention path depends on a reclaimed Machine staying purgeable.
  await db.insert(machineBranches).values({
    ownerId: USER_ID,
    machineId: TORNDOWN_BRANCH_MACHINE,
    projectName: 'repo',
    branchName: 'done',
    sessionKey: `${TORNDOWN_BRANCH_MACHINE}-key`,
    sandboxId: 'pgs-sbx-dead',
    spriteTornDownAt: new Date(NOW - 39 * DAY_MS),
  });

  // RECLAIMED_MACHINE is a Machine page whose Sprites WERE torn down and whose
  // machine_sessions row was released, so it has no tracking row at all.
}

beforeAll(async () => {
  try {
    await db.select().from(machineSessions).limit(1);
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

describe('purgeExpiredTrashedPages — Sprite-tracking guard', () => {
  beforeEach(async () => {
    if (!dbAvailable) return;
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    if (dbAvailable) await cleanup();
  });

  it(
    'purges expired pages with no Sprite-tracking row, and SKIPS the ones that still have one',
    async () => {
      if (!dbAvailable) return;
      await pageRepository.purgeExpiredTrashedPages(PURGE_CUTOFF);

      const survivors = await db
        .select({ id: pages.id })
        .from(pages)
        .where(inArray(pages.id, ALL_PAGES));
      const survivorIds = survivors.map((row) => row.id).sort();

      // Held back: killing the page would cascade-delete the only pointer to a
      // Sprite that is still running and still billing. Note TORNDOWN_BRANCH_MACHINE
      // is NOT held back — its branch row survives as config but its Sprite is
      // confirmed dead, so there is nothing left to strand.
      expect(survivorIds).toEqual([BRANCH_MACHINE, SESSION_MACHINE].sort());

      // And the tracking rows themselves survive intact — the sandboxIds the
      // reconciler needs are still on record.
      const sessions = await db
        .select({ sandboxId: machineSessions.sandboxId })
        .from(machineSessions)
        .where(eq(machineSessions.pageId, SESSION_MACHINE));
      expect(sessions).toEqual([{ sandboxId: 'pgs-sbx-orphan-session' }]);
      const branches = await db
        .select({ sandboxId: machineBranches.sandboxId })
        .from(machineBranches)
        .where(eq(machineBranches.machineId, BRANCH_MACHINE));
      expect(branches).toEqual([{ sandboxId: 'pgs-sbx-orphan-branch' }]);
    },
  );

  it(
    'purges a previously-blocked page once the reconciler has cleared its tracking row',
    async () => {
      if (!dbAvailable) return;
      // Simulate the orphan reconcile cron succeeding on the stuck session row.
      await db.delete(machineSessions).where(eq(machineSessions.pageId, SESSION_MACHINE));

      await pageRepository.purgeExpiredTrashedPages(PURGE_CUTOFF);

      const survivors = await db.select({ id: pages.id }).from(pages).where(inArray(pages.id, ALL_PAGES));
      expect(survivors.map((row) => row.id)).toEqual([BRANCH_MACHINE]);
    },
  );

  it('purges a Machine whose branch Sprite was already torn down — a stamped row never blocks erasure', async () => {
    if (!dbAvailable) return;
    // The GDPR Art. 17 counterpart of the guard: the branch row still EXISTS (it
    // is the user's config), so a guard keyed on row-existence alone would hold
    // this page back forever and silently break the 30-day retention promise.
    await pageRepository.purgeExpiredTrashedPages(PURGE_CUTOFF);

    const survivors = await db.select({ id: pages.id }).from(pages).where(inArray(pages.id, ALL_PAGES));
    expect(survivors.map((row) => row.id)).not.toContain(TORNDOWN_BRANCH_MACHINE);
  });

  it('leaves a page that is NOT yet past the purge cutoff alone', async () => {
    if (!dbAvailable) return;
    const purged = await pageRepository.purgeExpiredTrashedPages(new Date(NOW - 90 * DAY_MS));

    expect(purged).toBe(0);
    const survivors = await db.select({ id: pages.id }).from(pages).where(inArray(pages.id, ALL_PAGES));
    expect(survivors).toHaveLength(ALL_PAGES.length);
  });
});

describe('countStaleBlockedTrashedPages', () => {
  beforeEach(async () => {
    if (!dbAvailable) return;
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    if (dbAvailable) await cleanup();
  });

  it(
    'counts only the trashed pages still blocked by a tracking row past the stale cutoff',
    async () => {
      if (!dbAvailable) return;
      // Both blocked pages were trashed 40 days ago, so a 35-day-old cutoff
      // catches them and the un-blocked pages are never counted.
      const stale = await pageRepository.countStaleBlockedTrashedPages(new Date(NOW - 35 * DAY_MS));
      // The torn-down branch page is NOT counted — it is not blocked at all.
      expect(stale).toBe(2);
    },
  );

  it('counts 0 when the blocked pages are younger than the stale cutoff', async () => {
    if (!dbAvailable) return;
    const stale = await pageRepository.countStaleBlockedTrashedPages(new Date(NOW - 45 * DAY_MS));
    expect(stale).toBe(0);
  });
});
