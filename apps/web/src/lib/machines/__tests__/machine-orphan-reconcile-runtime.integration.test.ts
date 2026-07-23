/**
 * Orphan-reconcile runtime + the reclaim outbox — real Postgres integration tests.
 *
 * The whole architecture rests on a claim that CANNOT be tested against a fake:
 * that a Sprite's pointer survives EVERY way its page can be destroyed. The
 * `AFTER DELETE` triggers (migration 0210) are what make that true, and they live
 * only in the database — a mocked `db` would happily "pass" while production
 * silently stranded a billing VM. So this suite deletes real rows through real
 * cascades and checks what the triggers rescued.
 *
 * Covered:
 *   • The invariant, once per destroying path: hard-deleting a PAGE (the 30-day
 *     purge, and "delete permanently" from the trash), a DRIVE, or a USER (GDPR
 *     account erasure) cascades the tracking rows away — and every `sandboxId`
 *     lands in `machine_sprite_reclaims`, a table with no foreign keys, which
 *     therefore cannot itself be cascaded away.
 *   • An already-reclaimed branch row (`spriteTornDownAt` stamped) is NOT
 *     re-enqueued — its Sprite is already confirmed dead.
 *   • The reconciler drains the outbox, and KEEPS a row (recording the failure)
 *     when the kill fails, because it is the last pointer in existence.
 *   • Tracking-row candidates require teardown INTENT: a Machine merely dragged to
 *     the trash keeps its hibernating Sprite (a trash is reversible; a kill is
 *     not), while a `deleteMachine` whose kill failed is reclaimed.
 *   • Both release writes are CAS: they refuse to fire once the page is restored,
 *     or once the sandboxId changed under us (a concurrent re-provision).
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). Skipped when no DB is reachable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq, inArray, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { machineSessions } from '@pagespace/db/schema/machine-sessions';
import { machineBranches } from '@pagespace/db/schema/machine-branches';
import { machineProjects } from '@pagespace/db/schema/machine-projects';
import { machineSpriteReclaims } from '@pagespace/db/schema/machine-sprite-reclaims';
import { reconcileOrphanSprites } from '@pagespace/lib/services/machines/machine-orphan-reconcile';
import { defaultReconcileOrphanSpritesDeps as deps } from '../machine-orphan-reconcile-runtime';

const USER_ID = 'orphan-rt-user';
const DRIVE_ID = 'orphan-rt-drive';
/** deleteMachine ran and its kills failed — the orphan we hunt. */
const TEARDOWN_PENDING = 'orphan-rt-teardown-pending';
/** Merely dragged to the trash. Nobody asked for a teardown; its disk must survive. */
const SOFT_TRASHED = 'orphan-rt-soft-trashed';
/** Not trashed at all. */
const LIVE_MACHINE = 'orphan-rt-live';
const ALL_PAGES = [TEARDOWN_PENDING, SOFT_TRASHED, LIVE_MACHINE];

/** Every sandboxId this file creates — the ONLY outbox rows it may assert on or delete. */
const OUR_SANDBOXES = [
  'sbx-pending-session',
  'sbx-pending-branch',
  'sbx-pending-project',
  'sbx-soft-session',
  'sbx-soft-branch',
  'sbx-soft-project',
  'sbx-live-session',
  'sbx-already-dead',
];

let dbAvailable = false;

async function cleanup() {
  await db.delete(machineProjects).where(inArray(machineProjects.machineId, ALL_PAGES));
  await db.delete(machineBranches).where(inArray(machineBranches.machineId, ALL_PAGES));
  await db.delete(machineSessions).where(inArray(machineSessions.pageId, ALL_PAGES));
  await db.delete(pages).where(inArray(pages.id, ALL_PAGES));
  await db.delete(drives).where(eq(drives.id, DRIVE_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
  // Those deletes fire the triggers, so drop whatever they just rescued. Scoped
  // to our own sandboxIds — never touch a row this file did not create.
  await db.delete(machineSpriteReclaims).where(inArray(machineSpriteReclaims.sandboxId, OUR_SANDBOXES));
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

  // deleteMachine stamped its intent, then its kills failed.
  await db.insert(machineSessions).values({
    sessionKey: `${TEARDOWN_PENDING}-key`,
    pageId: TEARDOWN_PENDING,
    userId: USER_ID,
    sandboxId: 'sbx-pending-session',
    spriteInstanceId: 'inst-pending-session',
    teardownRequestedAt: new Date(),
  });
  await db.insert(machineBranches).values({
    ownerId: USER_ID,
    machineId: TEARDOWN_PENDING,
    projectName: 'repo',
    branchName: 'feature',
    sessionKey: `${TEARDOWN_PENDING}-branch-key`,
    sandboxId: 'sbx-pending-branch',
    spriteInstanceId: 'inst-pending-branch',
    teardownRequestedAt: new Date(),
  });

  // A PROMOTED project whose deleteMachine kill also failed — same tier as the
  // pending branch, third tracking table.
  await db.insert(machineProjects).values({
    id: 'orphan-rt-proj-pending',
    ownerId: USER_ID,
    machineId: TEARDOWN_PENDING,
    name: 'pending-repo',
    repoUrl: 'https://github.com/o/r.git',
    path: '/workspace/projects/pending-repo',
    sessionKey: `${TEARDOWN_PENDING}-project-key`,
    sandboxId: 'sbx-pending-project',
    spriteInstanceId: 'inst-pending-project',
    teardownRequestedAt: new Date(),
  });

  // Trashed from the page tree — NO teardown requested. Reversible.
  await db.insert(machineSessions).values({
    sessionKey: `${SOFT_TRASHED}-key`,
    pageId: SOFT_TRASHED,
    userId: USER_ID,
    sandboxId: 'sbx-soft-session',
  });
  await db.insert(machineBranches).values({
    ownerId: USER_ID,
    machineId: SOFT_TRASHED,
    projectName: 'repo',
    branchName: 'wip',
    sessionKey: `${SOFT_TRASHED}-branch-key`,
    sandboxId: 'sbx-soft-branch',
  });

  // A promoted project merely trashed (no intent) plus an UNPROMOTED one —
  // the unpromoted row has no Sprite, so no delete of it may ever enqueue.
  await db.insert(machineProjects).values({
    id: 'orphan-rt-proj-soft',
    ownerId: USER_ID,
    machineId: SOFT_TRASHED,
    name: 'soft-repo',
    repoUrl: 'https://github.com/o/s.git',
    path: '/workspace/projects/soft-repo',
    sessionKey: `${SOFT_TRASHED}-project-key`,
    sandboxId: 'sbx-soft-project',
    spriteInstanceId: 'inst-soft-project',
  });
  await db.insert(machineProjects).values({
    id: 'orphan-rt-proj-unpromoted',
    ownerId: USER_ID,
    machineId: SOFT_TRASHED,
    name: 'unpromoted-repo',
    repoUrl: 'https://github.com/o/u.git',
    path: '/workspace/projects/unpromoted-repo',
  });

  await db.insert(machineSessions).values({
    sessionKey: `${LIVE_MACHINE}-key`,
    pageId: LIVE_MACHINE,
    userId: USER_ID,
    sandboxId: 'sbx-live-session',
  });
}

async function rescuedSandboxIds(): Promise<string[]> {
  const rows = await db
    .select({ sandboxId: machineSpriteReclaims.sandboxId })
    .from(machineSpriteReclaims)
    .where(inArray(machineSpriteReclaims.sandboxId, OUR_SANDBOXES));
  return rows.map((row) => row.sandboxId).sort();
}

beforeAll(async () => {
  try {
    await db.select().from(machineSpriteReclaims).limit(1);
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

describe('the reclaim outbox — a Sprite pointer must survive EVERY way its page can die', () => {
  it('has both triggers installed — they are the entire invariant, and nothing else would notice them missing', async () => {
    if (!dbAvailable) return;
    // The triggers are hand-written SQL (migration 0210/0212), invisible to
    // drizzle's schema diff. A future migration that recreates or renames either
    // tracking table would drop them SILENTLY, and every test below would still
    // pass — while production quietly went back to stranding billing VMs.
    const rows = await db.execute(
      sql`SELECT tgname FROM pg_trigger WHERE tgname IN ('machine_sessions_sprite_reclaim', 'machine_branches_sprite_reclaim', 'machine_projects_sprite_reclaim')`,
    );
    expect(rows.rows.map((row) => row.tgname).sort()).toEqual([
      'machine_branches_sprite_reclaim',
      'machine_projects_sprite_reclaim',
      'machine_sessions_sprite_reclaim',
    ]);
  });

  it('rescues both sandboxIds when the PAGE is hard-deleted (the 30-day purge; "delete permanently")', async () => {
    if (!dbAvailable) return;

    await db.delete(pages).where(eq(pages.id, TEARDOWN_PENDING));

    // The tracking rows are gone (FK cascade) — that is the bug this exists to
    // survive. The pointers outlived them.
    expect(await rescuedSandboxIds()).toEqual([
      'sbx-pending-branch',
      'sbx-pending-project',
      'sbx-pending-session',
    ]);
  });

  it('rescues them when the DRIVE is permanently deleted (drives → pages → tracking rows)', async () => {
    if (!dbAvailable) return;

    await db.delete(drives).where(eq(drives.id, DRIVE_ID));

    expect(await rescuedSandboxIds()).toEqual(
      ['sbx-live-session', 'sbx-pending-branch', 'sbx-pending-project', 'sbx-pending-session', 'sbx-soft-branch', 'sbx-soft-project', 'sbx-soft-session'].sort(),
    );
  });

  it('rescues them on GDPR ACCOUNT ERASURE (users → drives → pages → tracking rows)', async () => {
    if (!dbAvailable) return;
    // The path a guard could never protect: Art. 17 erasure must not be blocked by
    // a Sprite we failed to kill. So we do not block the delete — we save the id.
    await db.delete(users).where(eq(users.id, USER_ID));

    expect(await rescuedSandboxIds()).toEqual(
      ['sbx-live-session', 'sbx-pending-branch', 'sbx-pending-project', 'sbx-pending-session', 'sbx-soft-branch', 'sbx-soft-project', 'sbx-soft-session'].sort(),
    );
  });

  it('never enqueues an UNPROMOTED project — it has no Sprite of its own to rescue', async () => {
    if (!dbAvailable) return;
    // The unpromoted row (sandboxId NULL) is a checkout inside the machine's own
    // Sprite; its delete must not insert a NULL-name reclaim.
    await db.delete(pages).where(eq(pages.id, SOFT_TRASHED));

    const rows = await db.select({ sandboxId: machineSpriteReclaims.sandboxId }).from(machineSpriteReclaims);
    expect(rows.map((r) => r.sandboxId)).not.toContain(null);
  });

  it('does NOT re-enqueue a branch whose Sprite is already confirmed dead (spriteTornDownAt stamped)', async () => {
    if (!dbAvailable) return;
    await db.insert(machineBranches).values({
      ownerId: USER_ID,
      machineId: TEARDOWN_PENDING,
      projectName: 'repo',
      branchName: 'done',
      sessionKey: `${TEARDOWN_PENDING}-dead-branch-key`,
      sandboxId: 'sbx-already-dead',
      spriteTornDownAt: new Date(),
    });

    await db.delete(pages).where(eq(pages.id, TEARDOWN_PENDING));

    expect(await rescuedSandboxIds()).not.toContain('sbx-already-dead');
  });
});

describe('defaultReconcileOrphanSpritesDeps.listOrphanCandidates', () => {
  it('requires teardown INTENT for a tracking row — a Machine merely trashed keeps its disk', async () => {
    if (!dbAvailable) return;
    // pageService.trashPage (generic page DELETE, bulk delete, folder cascade-trash)
    // trashes a MACHINE with no teardown. Its Sprite hibernates, and a restore is
    // expected to hand the disk back. A kill is irreversible; a trash is not.
    const { rows } = await deps.listOrphanCandidates();
    const sandboxIds = rows.map((row) => row.sandboxId);

    expect(sandboxIds).toContain('sbx-pending-session'); // teardown requested, kill failed
    expect(sandboxIds).toContain('sbx-pending-branch');
    expect(sandboxIds).toContain('sbx-pending-project'); // third tracking table, same tier
    expect(sandboxIds).not.toContain('sbx-soft-session'); // just trashed — hands off
    expect(sandboxIds).not.toContain('sbx-soft-branch');
    expect(sandboxIds).not.toContain('sbx-soft-project');
    expect(sandboxIds).not.toContain('sbx-live-session'); // not trashed at all
  });

  it('picks up whatever the triggers rescued into the outbox', async () => {
    if (!dbAvailable) return;
    await db.delete(pages).where(eq(pages.id, SOFT_TRASHED));

    const { rows } = await deps.listOrphanCandidates();
    const reclaims = rows.filter((row) => row.kind === 'reclaim').map((row) => row.sandboxId);

    // Never a candidate while its page merely sat in the trash — but the moment the
    // page is actually destroyed, nothing else points at its Sprite.
    expect(reclaims).toContain('sbx-soft-session');
    expect(reclaims).toContain('sbx-soft-branch');
  });
});

describe('reconcileOrphanSprites composed over the REAL deps', () => {
  it('drains the outbox and is idempotent — a second sweep finds nothing left', async () => {
    if (!dbAvailable) return;
    // Evidence for the "no advisory lock needed" decision: only the sprite kill is
    // faked; every DB effect is the real thing.
    await db.delete(pages).where(eq(pages.id, SOFT_TRASHED)); // strand two Sprites

    const killed: string[] = [];
    const testDeps = {
      ...deps,
      killSprite: async ({ sandboxId }: { sandboxId: string; spriteInstanceId: string | null }) => {
        killed.push(sandboxId);
        return { ok: true } as const;
      },
    };

    const first = await reconcileOrphanSprites(testDeps);
    expect(first.failed).toBe(0);
    expect(killed).toEqual(expect.arrayContaining(['sbx-soft-session', 'sbx-soft-branch']));
    expect(await rescuedSandboxIds()).toEqual([]); // outbox drained

    const killedInFirst = killed.length;
    const second = await reconcileOrphanSprites(testDeps);

    expect(second.failed).toBe(0);
    expect(killed.slice(killedInFirst).filter((id) => OUR_SANDBOXES.includes(id))).toEqual([]);
  });

  it('KEEPS a failed outbox row and records the failure — it is the last pointer in existence', async () => {
    if (!dbAvailable) return;
    await db.delete(pages).where(eq(pages.id, SOFT_TRASHED));

    const testDeps = {
      ...deps,
      killSprite: async () => ({ ok: false, error: new Error('sprite unreachable') }) as const,
    };

    const result = await reconcileOrphanSprites(testDeps);
    expect(result.failed).toBeGreaterThanOrEqual(2);

    // Still there — dropping it would strand a billing VM forever — and the failure
    // is recorded, so a Sprite that cannot be killed becomes visible.
    const [row] = await db
      .select()
      .from(machineSpriteReclaims)
      .where(eq(machineSpriteReclaims.sandboxId, 'sbx-soft-session'));
    expect(row).toBeDefined();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('unreachable');
  });
});

describe('the CAS release writes', () => {
  it('REFUSE to fire once the page has been restored', async () => {
    if (!dbAvailable) return;
    await db.update(pages).set({ isTrashed: false, trashedAt: null }).where(eq(pages.id, TEARDOWN_PENDING));

    const released = await deps.releaseSessionRow({
      sessionKey: `${TEARDOWN_PENDING}-key`,
      sandboxId: 'sbx-pending-session',
      spriteInstanceId: 'inst-pending-session',
    });

    expect(released).toBe(false);
    const rows = await db.select().from(machineSessions).where(eq(machineSessions.pageId, TEARDOWN_PENDING));
    expect(rows).toHaveLength(1);
  });

  it('REFUSE to fire when the sandboxId changed under us (a concurrent re-provision)', async () => {
    if (!dbAvailable) return;
    // Marking a LIVE, freshly-provisioned Sprite as dead would hide it from this
    // cron — the exact orphan this whole workstream exists to prevent.
    const [branch] = await db
      .select()
      .from(machineBranches)
      .where(eq(machineBranches.machineId, TEARDOWN_PENDING));
    await db
      .update(machineBranches)
      .set({ sandboxId: 'sbx-freshly-reprovisioned' })
      .where(eq(machineBranches.id, branch.id));

    const marked = await deps.markBranchTornDown({
      id: branch.id,
      sandboxId: 'sbx-pending-branch',
      spriteInstanceId: 'inst-pending-branch',
    });

    expect(marked).toBe(false);
    const [after] = await db.select().from(machineBranches).where(eq(machineBranches.id, branch.id));
    expect(after.spriteTornDownAt).toBeNull();
  });

  it('REFUSE to fire when a REPLACEMENT Sprite took the same name (the ABA that `sandboxId` cannot see)', async () => {
    if (!dbAvailable) return;
    // The orphan this whole design exists to prevent, and the one a name-keyed CAS
    // would sail straight through: `sandboxId` is our derived session key, REUSED
    // across re-creates. A Sprite re-provisioned after our kill answers to the SAME
    // sandboxId while being a physically different, LIVE VM. Only the instance id
    // can tell them apart — and if the release wrote anyway, we would delete the
    // last pointer to that live VM and it would bill forever, unreachable.
    await db
      .update(machineSessions)
      .set({ spriteInstanceId: 'inst-REPLACEMENT' }) // same sandboxId, new VM
      .where(eq(machineSessions.pageId, TEARDOWN_PENDING));

    const released = await deps.releaseSessionRow({
      sessionKey: `${TEARDOWN_PENDING}-key`,
      sandboxId: 'sbx-pending-session', // unchanged — the name is not an identity
      spriteInstanceId: 'inst-pending-session', // the VM we actually killed
    });

    expect(released).toBe(false);
    const rows = await db.select().from(machineSessions).where(eq(machineSessions.pageId, TEARDOWN_PENDING));
    expect(rows).toHaveLength(1); // the live replacement keeps its pointer
    expect(rows[0].spriteInstanceId).toBe('inst-REPLACEMENT');
  });

  it('STAMPS the branch row rather than deleting it — the row is re-creatable config', async () => {
    if (!dbAvailable) return;
    const [branch] = await db
      .select()
      .from(machineBranches)
      .where(eq(machineBranches.machineId, TEARDOWN_PENDING));

    const marked = await deps.markBranchTornDown({
      id: branch.id,
      sandboxId: 'sbx-pending-branch',
      spriteInstanceId: 'inst-pending-branch',
    });

    expect(marked).toBe(true);
    const [after] = await db.select().from(machineBranches).where(eq(machineBranches.id, branch.id));
    expect(after).toBeDefined(); // still there — its agent terminals cascade off it
    expect(after.spriteTornDownAt).toBeInstanceOf(Date);
  });
});
