/**
 * Orphan-reconcile runtime deps — real Postgres integration tests.
 *
 * Real-DB sibling of machine-orphan-reconcile.test.ts (which drives the pure
 * core against fakes — it proves the control flow, but none of the SQL ever
 * runs). Every guarantee this cron makes actually lives in the SQL here:
 *
 *   • `listOrphanCandidates` must pick up a `machine_sessions` row and an
 *     UNSTAMPED `machine_branches` row under a trashed page — and must NOT pick
 *     up a live page's rows or an already-stamped branch row.
 *   • `releaseSessionRow` / `markBranchTornDown` are COMPARE-AND-SWAPs whose
 *     whole purpose is to lose safely: if the page was restored, or the row's
 *     `sandboxId` changed under us (a concurrent re-provision), the write must
 *     no-op rather than record a LIVE Sprite as dead — which would hide it from
 *     this cron AND from the hard-purge guard, orphaning it forever.
 *
 * A fake can't prove any of that; a wrong `exists(...)` subquery or a dropped
 * WHERE clause would sail straight through the unit tests and silently break
 * the cron in production. So this exercises the real statements.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). Skipped when no DB is reachable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { machineSessions } from '@pagespace/db/schema/machine-sessions';
import { machineBranches } from '@pagespace/db/schema/machine-branches';
import { defaultReconcileOrphanSpritesDeps as deps } from '../machine-orphan-reconcile-runtime';

const USER_ID = 'orphan-rt-user';
const DRIVE_ID = 'orphan-rt-drive';
const TRASHED_MACHINE = 'orphan-rt-trashed';
const LIVE_MACHINE = 'orphan-rt-live';
const STAMPED_MACHINE = 'orphan-rt-stamped';
const ALL_PAGES = [TRASHED_MACHINE, LIVE_MACHINE, STAMPED_MACHINE];

let dbAvailable = false;

async function cleanup() {
  await db.delete(machineBranches).where(inArray(machineBranches.machineId, ALL_PAGES));
  await db.delete(machineSessions).where(inArray(machineSessions.pageId, ALL_PAGES));
  await db.delete(pages).where(inArray(pages.id, ALL_PAGES));
  await db.delete(drives).where(eq(drives.id, DRIVE_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
}

async function seed() {
  await db.insert(users).values({ id: USER_ID, name: 'orphan-rt', email: `${USER_ID}@example.test` });
  await db.insert(drives).values({ id: DRIVE_ID, name: 'Orphan RT', slug: USER_ID, ownerId: USER_ID });

  await db.insert(pages).values(
    ALL_PAGES.map((id, index) => ({
      id,
      title: id,
      type: 'MACHINE' as const,
      driveId: DRIVE_ID,
      position: index,
      isTrashed: id !== LIVE_MACHINE,
      trashedAt: id === LIVE_MACHINE ? null : new Date(),
    })),
  );

  // Trashed machine: own Sprite + a branch Sprite, neither confirmed dead.
  await db.insert(machineSessions).values({
    sessionKey: `${TRASHED_MACHINE}-key`,
    pageId: TRASHED_MACHINE,
    userId: USER_ID,
    sandboxId: 'sbx-trashed-session',
  });
  await db.insert(machineBranches).values({
    ownerId: USER_ID,
    machineId: TRASHED_MACHINE,
    projectName: 'repo',
    branchName: 'feature',
    sessionKey: `${TRASHED_MACHINE}-branch-key`,
    sandboxId: 'sbx-trashed-branch',
  });

  // LIVE machine: not trashed — its Sprites must never be candidates.
  await db.insert(machineSessions).values({
    sessionKey: `${LIVE_MACHINE}-key`,
    pageId: LIVE_MACHINE,
    userId: USER_ID,
    sandboxId: 'sbx-live-session',
  });
  await db.insert(machineBranches).values({
    ownerId: USER_ID,
    machineId: LIVE_MACHINE,
    projectName: 'repo',
    branchName: 'feature',
    sessionKey: `${LIVE_MACHINE}-branch-key`,
    sandboxId: 'sbx-live-branch',
  });

  // Trashed machine whose branch Sprite was ALREADY reclaimed — the row survives
  // as config, but it points at no live Sprite, so it is not a candidate.
  await db.insert(machineBranches).values({
    ownerId: USER_ID,
    machineId: STAMPED_MACHINE,
    projectName: 'repo',
    branchName: 'done',
    sessionKey: `${STAMPED_MACHINE}-branch-key`,
    sandboxId: 'sbx-already-dead',
    spriteTornDownAt: new Date(),
  });
}

beforeAll(async () => {
  try {
    await db.select().from(machineSessions).limit(1);
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await cleanup();
  await seed();
});

afterAll(async () => {
  if (dbAvailable) await cleanup();
});

async function branchRow(machineId: string) {
  const [row] = await db
    .select({ id: machineBranches.id, sandboxId: machineBranches.sandboxId, spriteTornDownAt: machineBranches.spriteTornDownAt })
    .from(machineBranches)
    .where(eq(machineBranches.machineId, machineId))
    .limit(1);
  return row;
}

describe('defaultReconcileOrphanSpritesDeps.listOrphanCandidates', () => {
  it('finds only the Sprites believed LIVE under a TRASHED page', async () => {
    if (!dbAvailable) return;

    const candidates = await deps.listOrphanCandidates();
    const mine = candidates.filter((row) => ALL_PAGES.includes(row.pageId));

    // The trashed machine's own Sprite and its unstamped branch Sprite — and
    // nothing from the live machine, nothing already stamped.
    expect(mine.map((row) => row.sandboxId).sort()).toEqual(['sbx-trashed-branch', 'sbx-trashed-session']);
    expect(mine.find((row) => row.kind === 'session')).toMatchObject({
      pageId: TRASHED_MACHINE,
      sessionKey: `${TRASHED_MACHINE}-key`,
    });
    expect(mine.find((row) => row.kind === 'branch')).toMatchObject({ pageId: TRASHED_MACHINE });
  });
});

describe('defaultReconcileOrphanSpritesDeps.isStillTrashed', () => {
  it('reports the page trash state, and treats a vanished page as trashed', async () => {
    if (!dbAvailable) return;

    expect(await deps.isStillTrashed(TRASHED_MACHINE)).toBe(true);
    expect(await deps.isStillTrashed(LIVE_MACHINE)).toBe(false);
    // Hard-purged mid-run — not restorable, so killing its Sprite is correct.
    expect(await deps.isStillTrashed('no-such-page')).toBe(true);
  });
});

describe('defaultReconcileOrphanSpritesDeps.releaseSessionRow', () => {
  it('deletes the session row when the page is still trashed and the sandboxId matches', async () => {
    if (!dbAvailable) return;

    const released = await deps.releaseSessionRow({
      sessionKey: `${TRASHED_MACHINE}-key`,
      sandboxId: 'sbx-trashed-session',
    });

    expect(released).toBe(true);
    const rows = await db.select().from(machineSessions).where(eq(machineSessions.pageId, TRASHED_MACHINE));
    expect(rows).toHaveLength(0);
  });

  it('REFUSES to delete once the page has been restored — the CAS loses safely', async () => {
    if (!dbAvailable) return;
    // The restore commits between our kill and our write.
    await db.update(pages).set({ isTrashed: false, trashedAt: null }).where(eq(pages.id, TRASHED_MACHINE));

    const released = await deps.releaseSessionRow({
      sessionKey: `${TRASHED_MACHINE}-key`,
      sandboxId: 'sbx-trashed-session',
    });

    expect(released).toBe(false);
    const rows = await db.select().from(machineSessions).where(eq(machineSessions.pageId, TRASHED_MACHINE));
    expect(rows).toHaveLength(1);
  });

  it('REFUSES to delete when the sandboxId changed under us (a concurrent re-provision)', async () => {
    if (!dbAvailable) return;
    await db
      .update(machineSessions)
      .set({ sandboxId: 'sbx-freshly-reprovisioned' })
      .where(eq(machineSessions.pageId, TRASHED_MACHINE));

    const released = await deps.releaseSessionRow({
      sessionKey: `${TRASHED_MACHINE}-key`,
      sandboxId: 'sbx-trashed-session', // the one we killed — no longer the live one
    });

    expect(released).toBe(false);
    const [row] = await db.select().from(machineSessions).where(eq(machineSessions.pageId, TRASHED_MACHINE));
    expect(row.sandboxId).toBe('sbx-freshly-reprovisioned');
  });
});

describe('defaultReconcileOrphanSpritesDeps.markBranchTornDown', () => {
  it('STAMPS the branch row rather than deleting it — the row is re-creatable config', async () => {
    if (!dbAvailable) return;
    const before = await branchRow(TRASHED_MACHINE);

    const marked = await deps.markBranchTornDown({ id: before.id, sandboxId: before.sandboxId });

    expect(marked).toBe(true);
    const after = await branchRow(TRASHED_MACHINE);
    expect(after).toBeDefined(); // still there — its agent terminals cascade off it
    expect(after.spriteTornDownAt).toBeInstanceOf(Date);
  });

  it('REFUSES to stamp once the page has been restored — the CAS loses safely', async () => {
    if (!dbAvailable) return;
    const before = await branchRow(TRASHED_MACHINE);
    await db.update(pages).set({ isTrashed: false, trashedAt: null }).where(eq(pages.id, TRASHED_MACHINE));

    const marked = await deps.markBranchTornDown({ id: before.id, sandboxId: before.sandboxId });

    expect(marked).toBe(false);
    expect((await branchRow(TRASHED_MACHINE)).spriteTornDownAt).toBeNull();
  });

  it('REFUSES to stamp a LIVE replacement Sprite written by a concurrent re-provision', async () => {
    if (!dbAvailable) return;
    // This is the race the CAS exists for: stamping here would mark a live,
    // freshly-provisioned Sprite as dead — invisible to this cron and to the
    // hard-purge guard, i.e. orphaned and billed forever.
    const before = await branchRow(TRASHED_MACHINE);
    await db
      .update(machineBranches)
      .set({ sandboxId: 'sbx-freshly-reprovisioned' })
      .where(eq(machineBranches.id, before.id));

    const marked = await deps.markBranchTornDown({ id: before.id, sandboxId: before.sandboxId });

    expect(marked).toBe(false);
    const after = await branchRow(TRASHED_MACHINE);
    expect(after.sandboxId).toBe('sbx-freshly-reprovisioned');
    expect(after.spriteTornDownAt).toBeNull();
  });
});
