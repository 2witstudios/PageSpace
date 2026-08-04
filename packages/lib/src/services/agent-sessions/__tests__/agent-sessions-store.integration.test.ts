/**
 * `agent_sessions` store — REAL Postgres.
 *
 * The unit suite drives this store's logic against an in-memory fake, which is
 * the right tool for the lifecycle races but proves nothing about the SQL: the
 * compare-and-swap predicates, the `IS NULL` semantics a JS `===` comparison
 * silently gets right and SQL does not, the PK-as-FK conflict target, and the
 * live-row guard on measurement writes are all statements this suite executes
 * for real. Its predecessor (`agent-terminals-store.integration.test.ts`) covered
 * the analogous logic; this restores that coverage for the successor.
 *
 * Excluded from the default run (no database there) — see `vitest.config.ts`.
 * Run with:
 *     bun run --filter '@pagespace/lib' test:db -- src/services/agent-sessions/__tests__/agent-sessions-store.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { conversations } from '@pagespace/db/schema/conversations';
import { agentSessions } from '@pagespace/db/schema/agent-sessions';
import { machineSpriteReclaims } from '@pagespace/db/schema/machine-sprite-reclaims';
import { createDbAgentSessionStore, type AgentSessionListFilter } from '../agent-sessions-store';

const ownerId = createId();
const driveId = createId();
const agentPageId = createId();
const conversationIds: string[] = [];
const sessionIds: string[] = [];
/**
 * Every sandbox id this file lets reach the DB, recorded AS IT IS WRITTEN.
 *
 * The AFTER-DELETE trigger on `agent_sessions` enqueues a reclaim row for each
 * live sandbox, and the outbox is FK-less by design — nothing cascades those
 * away, and a leaked one is a name the orphan cron will later try to destroy.
 *
 * Recorded at write time rather than read back at teardown because the cascade
 * test deletes its own conversation mid-run: by `afterAll` the session row is
 * already gone and its pointer is unrecoverable from the table. Teardown ALSO
 * reads the surviving rows, which is what catches ids this helper never saw
 * (`updateSpriteIdentity` swaps in new ones). Neither half is sufficient alone.
 */
const sandboxIds = new Set<string>(['sbx-integration-outbox']);

let store: Awaited<ReturnType<typeof createDbAgentSessionStore>>;

/** A session row (its own id), plus one conversation BOUND to it via conversations.sessionId. */
async function seedSession(
  over: Partial<{ sandboxId: string; spriteInstanceId: string | null; spriteTornDownAt: Date; endedAt: Date }> = {},
) {
  const sessionId = createId();
  sessionIds.push(sessionId);
  if (over.sandboxId) sandboxIds.add(over.sandboxId);
  await db.insert(agentSessions).values({
    id: sessionId,
    ownerId,
    driveId,
    sandboxId: over.sandboxId ?? null,
    spriteInstanceId: over.spriteInstanceId ?? null,
    spriteTornDownAt: over.spriteTornDownAt ?? null,
    endedAt: over.endedAt ?? null,
    updatedAt: new Date(),
  });
  const conversationId = createId();
  conversationIds.push(conversationId);
  await db.insert(conversations).values({
    id: conversationId,
    userId: ownerId,
    title: 'integration',
    type: 'page',
    contextId: agentPageId,
    sessionId,
  });
  return sessionId;
}

beforeAll(async () => {
  store = await createDbAgentSessionStore();
  await db.insert(users).values({
    id: ownerId,
    email: `agent-sessions-store-${ownerId}@example.test`,
    name: 'Agent Sessions Store Test',
  });
  await db.insert(drives).values({ id: driveId, name: 'Store Test Drive', slug: `store-${driveId}`, ownerId });
  await db.insert(pages).values({ id: agentPageId, title: 'Agent', type: 'AI_CHAT', driveId, position: 1 });
});

afterAll(async () => {
  // Read the sandbox pointers back OUT before deleting anything. Dropping a
  // session row fires the AFTER-DELETE trigger, which enqueues a reclaim row
  // for every live sandbox — and the outbox is FK-less by design, so nothing
  // cascades those away. Reading them from the DB rather than tracking a
  // literal list is what makes this correct no matter which test wrote them
  // (`seedSession` overrides, `updateSpriteIdentity` CAS swaps, or a future
  // case not yet written). A leaked row is not cosmetic: the orphan-reconcile
  // cron picks it up and tries to destroy a Sprite name.
  if (conversationIds.length > 0) {
    const rows = await db
      .select({ sandboxId: agentSessions.sandboxId })
      .from(agentSessions)
      .where(inArray(agentSessions.id, sessionIds));
    for (const row of rows) {
      if (row.sandboxId) sandboxIds.add(row.sandboxId);
    }
    // agent_sessions cascades from conversations, but delete explicitly: the DB
    // is shared, so a leaked row is the next run's mystery, not this one's.
    await db.delete(agentSessions).where(inArray(agentSessions.id, sessionIds));
    await db.delete(conversations).where(inArray(conversations.id, conversationIds));
  }
  await db.delete(machineSpriteReclaims).where(inArray(machineSpriteReclaims.sandboxId, [...sandboxIds]));
  await db.delete(pages).where(eq(pages.id, agentPageId));
  await db.delete(drives).where(eq(drives.id, driveId));
  await db.delete(users).where(eq(users.id, ownerId));
});

beforeEach(async () => {
  await db.delete(machineSpriteReclaims).where(eq(machineSpriteReclaims.sandboxId, 'sbx-integration-outbox'));
});

describe('create + findByConversation', () => {
  it('mints a session with its own id, and two bound conversations resolve the SAME row', async () => {
    const created = await store.create({ ownerId, driveId, name: 'api refactor', now: new Date() });
    sessionIds.push(created.id);

    for (const convName of ['conv-x', 'conv-y']) {
      const conversationId = createId();
      conversationIds.push(conversationId);
      await db.insert(conversations).values({
        id: conversationId,
        userId: ownerId,
        title: convName,
        type: 'page',
        contextId: agentPageId,
        sessionId: created.id,
      });
      // The payoff of the un-conflation, proven against real Postgres: every
      // thread in a session resolves the one row whose id folds the ONE
      // Sprite key.
      const resolved = await store.findByConversation(conversationId);
      expect(resolved?.id).toBe(created.id);
    }
  });

  it('a thread with no session resolves null — never a fallback', async () => {
    const conversationId = createId();
    conversationIds.push(conversationId);
    await db.insert(conversations).values({
      id: conversationId,
      userId: ownerId,
      title: 'plain chat',
      type: 'page',
      contextId: agentPageId,
    });
    expect(await store.findByConversation(conversationId)).toBeNull();
  });

  it('deleting a session NULLs the binding and the thread survives as history', async () => {
    const sessionId = await seedSession();
    const [bound] = await db.select().from(conversations).where(eq(conversations.sessionId, sessionId));
    expect(bound).toBeDefined();

    await db.delete(agentSessions).where(eq(agentSessions.id, sessionId));

    const [after] = await db.select().from(conversations).where(eq(conversations.id, bound.id));
    expect(after).toBeDefined();
    expect(after.sessionId).toBeNull();
    expect(await store.findByConversation(bound.id)).toBeNull();
  });
});

describe('updateSpriteIdentity — CAS on the previous pointer', () => {
  it('given the expected NULL pointer, should persist identity', async () => {
    const conversationId = await seedSession();

    const ok = await store.updateSpriteIdentity({
      sessionId: conversationId,
      previousSandboxId: null,
      sessionKey: 'pgs-ses-key',
      sandboxId: 'sbx-1',
      spriteInstanceId: 'i-1',
      egressPolicyToken: 'tok',
      stamps: {},
      now: new Date(),
    });

    expect(ok).toBe(true);
    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, conversationId));
    expect(row.sandboxId).toBe('sbx-1');
    expect(row.spriteInstanceId).toBe('i-1');
  });

  it('given a row that ALREADY holds a sandbox, should refuse a first-provision CAS', async () => {
    // The SQL must compare NULL correctly: a JS `===` gets this right for free,
    // `= NULL` in SQL never matches, and only `IS NULL` does. A wrong predicate
    // here would let a racing provisioner overwrite the winner's live VM pointer.
    const conversationId = await seedSession({ sandboxId: 'sbx-existing', spriteInstanceId: 'i-existing' });

    const ok = await store.updateSpriteIdentity({
      sessionId: conversationId,
      previousSandboxId: null,
      sessionKey: 'pgs-ses-key',
      sandboxId: 'sbx-loser',
      spriteInstanceId: 'i-loser',
      egressPolicyToken: null,
      stamps: {},
      now: new Date(),
    });

    expect(ok).toBe(false);
    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, conversationId));
    expect(row.sandboxId).toBe('sbx-existing');
  });

  it('given the matching previous pointer, should swap identity (a vanished-Sprite re-provision)', async () => {
    const conversationId = await seedSession({ sandboxId: 'sbx-old', spriteInstanceId: 'i-old' });

    const ok = await store.updateSpriteIdentity({
      sessionId: conversationId,
      previousSandboxId: 'sbx-old',
      sessionKey: 'pgs-ses-key',
      sandboxId: 'sbx-new',
      spriteInstanceId: 'i-new',
      egressPolicyToken: null,
      stamps: { spriteTornDownAt: null },
      now: new Date(),
    });

    expect(ok).toBe(true);
    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, conversationId));
    expect(row.sandboxId).toBe('sbx-new');
    expect(row.spriteTornDownAt).toBeNull();
  });
});

describe('stampSpriteTornDown — CAS on the INSTANCE', () => {
  it('given the matching instance, should stamp', async () => {
    const conversationId = await seedSession({ sandboxId: 'sbx-1', spriteInstanceId: 'i-1' });

    const ok = await store.stampSpriteTornDown({
      sessionId: conversationId,
      sandboxId: 'sbx-1',
      spriteInstanceId: 'i-1',
      stamps: { spriteTornDownAt: new Date() },
    });

    expect(ok).toBe(true);
    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, conversationId));
    expect(row.spriteTornDownAt).not.toBeNull();
  });

  it('given a DIFFERENT live instance under the same name, should refuse — never mark a live VM dead', async () => {
    const conversationId = await seedSession({ sandboxId: 'sbx-1', spriteInstanceId: 'i-new' });

    const ok = await store.stampSpriteTornDown({
      sessionId: conversationId,
      sandboxId: 'sbx-1',
      spriteInstanceId: 'i-old',
      stamps: { spriteTornDownAt: new Date() },
    });

    expect(ok).toBe(false);
    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, conversationId));
    expect(row.spriteTornDownAt).toBeNull();
  });
});

describe('countLive', () => {
  it('should count only rows with a sandbox and no teardown stamp', async () => {
    const before = await store.countLive(ownerId);
    await seedSession({ sandboxId: 'sbx-live', spriteInstanceId: 'i' });
    await seedSession({ sandboxId: 'sbx-dead', spriteInstanceId: 'i', spriteTornDownAt: new Date() });
    await seedSession(); // never provisioned

    expect(await store.countLive(ownerId)).toBe(before + 1);
  });

  it('given a row ENDED but not yet torn down, should still count it — the VM is still billing', async () => {
    // `endedAt` records the user's intent; `spriteTornDownAt` records the VM
    // actually being gone. They diverge whenever a kill fails and teardown falls
    // back to the reclaim outbox, and during that window the Sprite is still
    // running and still charging. A counter that stops at `endedAt` undercounts
    // exactly then — which is how a second count of this ceiling, derived
    // independently in the spawn pre-check, came to disagree with this one.
    const before = await store.countLive(ownerId);
    await seedSession({ sandboxId: 'sbx-ended-live', spriteInstanceId: 'i', endedAt: new Date() });

    expect(await store.countLive(ownerId)).toBe(before + 1);
  });
});

describe('recordStorageMeasurement', () => {
  it('given a live row, should persist the measurement', async () => {
    const sessionId = await seedSession({ sandboxId: 'sbx-1', spriteInstanceId: 'i' });
    const measuredAt = new Date();

    await store.recordStorageMeasurement({ sessionId, spriteInstanceId: 'i', measuredBytes: 4096, measuredAt });

    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
    expect(Number(row.storageMeasuredBytes)).toBe(4096);
    expect(row.storageMeasuredAt).not.toBeNull();
  });

  it('given a TORN-DOWN row, should not write — that filesystem no longer exists', async () => {
    const sessionId = await seedSession({
      sandboxId: 'sbx-1',
      spriteInstanceId: 'i',
      spriteTornDownAt: new Date(),
    });

    await store.recordStorageMeasurement({
      sessionId,
      spriteInstanceId: 'i',
      measuredBytes: 999,
      measuredAt: new Date(),
    });

    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
    expect(row.storageMeasuredBytes).toBeNull();
  });

  it('given the Sprite generation moved on mid-measurement, should DROP the stale write', async () => {
    // The window the liveness guard cannot close, because a re-provision REVIVES
    // the row: measure generation A (fire-and-forget) → A torn down → B minted,
    // which clears `spriteTornDownAt` and nulls the measurement columns → A's
    // `du` finally lands. Guarded only on liveness it finds a live row and
    // writes A's bytes onto B, with a fresh `storageMeasuredAt` that suppresses
    // B's own measurement for the whole throttle window while the reconcile
    // bills B's interval against A's disk.
    //
    // The name cannot arbitrate this: `sandboxId` is HMAC-derived from the
    // session, so A and B share it. Only the instance id differs.
    const sessionId = await seedSession({ sandboxId: 'sbx-stable-name', spriteInstanceId: 'instance-A' });

    await db
      .update(agentSessions)
      .set({ spriteInstanceId: 'instance-B', spriteTornDownAt: null, storageMeasuredBytes: null, storageMeasuredAt: null })
      .where(eq(agentSessions.id, sessionId));

    await store.recordStorageMeasurement({
      sessionId,
      spriteInstanceId: 'instance-A',
      measuredBytes: 5_000_000,
      measuredAt: new Date(),
    });

    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
    expect(row.storageMeasuredBytes).toBeNull();
    // The timestamp matters as much as the bytes: a stale one silences the next
    // real measurement without ever having recorded a real number.
    expect(row.storageMeasuredAt).toBeNull();
  });

  it('given the same generation still on the row, should persist despite an identical sandbox NAME', async () => {
    // The other half: the CAS must not reject a legitimate measurement just
    // because the name is reused. Same name, same instance → this is the disk
    // that was measured.
    const sessionId = await seedSession({ sandboxId: 'sbx-stable-name', spriteInstanceId: 'instance-B' });

    await store.recordStorageMeasurement({
      sessionId,
      spriteInstanceId: 'instance-B',
      measuredBytes: 777,
      measuredAt: new Date(),
    });

    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
    expect(Number(row.storageMeasuredBytes)).toBe(777);
  });

  it('given a driver that reports no instance id, should still persist against a null row', async () => {
    // Degrades to the liveness guard rather than never persisting — the most a
    // caller can know when the platform gives it no generation id.
    const sessionId = await seedSession({ sandboxId: 'sbx-no-instance', spriteInstanceId: null });

    await store.recordStorageMeasurement({
      sessionId,
      spriteInstanceId: null,
      measuredBytes: 321,
      measuredAt: new Date(),
    });

    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
    expect(Number(row.storageMeasuredBytes)).toBe(321);
  });
});

describe('enqueueReclaim', () => {
  it('given the same sandbox twice, should upsert rather than violate the PK', async () => {
    await store.enqueueReclaim({ sandboxId: 'sbx-integration-outbox', spriteInstanceId: 'i-1' });
    await expect(
      store.enqueueReclaim({ sandboxId: 'sbx-integration-outbox', spriteInstanceId: 'i-2' }),
    ).resolves.toBeUndefined();

    const rows = await db
      .select()
      .from(machineSpriteReclaims)
      .where(eq(machineSpriteReclaims.sandboxId, 'sbx-integration-outbox'));
    expect(rows).toHaveLength(1);
    // Chases the NEWEST instance — mirrors the AFTER-DELETE trigger's own insert.
    expect(rows[0].spriteInstanceId).toBe('i-2');
  });
});

describe('reclaim trigger — every cascade path that can strand a live Sprite', () => {
  /**
   * The trigger's own doc lists the paths that reach it: deleting a
   * conversation, hard-deleting the AI_CHAT page, deleting the drive, and the
   * GDPR/account-erasure delete of the user. Only the first was covered, and
   * the others are the expensive ones — a drive delete reaches the session row
   * through TWO cascade hops, and if any link is missing the Sprite bills
   * forever with nothing left pointing at it.
   *
   * Asserted against real Postgres because that is the only place a cascade
   * chain and an AFTER-DELETE trigger actually exist; no in-memory fake can
   * tell you whether the FK path is wired.
   */
  async function seedProbe(over: {
    suffix: string;
    sandboxId: string;
    spriteTornDownAt?: Date;
    withPage: boolean;
  }) {
    const probeUserId = createId();
    const probeDriveId = createId();
    const probePageId = createId();
    const conversationId = createId();
    await db.insert(users).values({ id: probeUserId, email: `probe-${probeUserId}@example.test`, name: 'Probe' });
    await db.insert(drives).values({ id: probeDriveId, name: 'Probe', slug: `probe-${probeDriveId}`, ownerId: probeUserId });
    if (over.withPage) {
      await db.insert(pages).values({ id: probePageId, title: 'Agent', type: 'AI_CHAT', driveId: probeDriveId, position: 1 });
    }
    await db.insert(conversations).values({
      id: conversationId,
      userId: probeUserId,
      title: 'probe',
      type: over.withPage ? 'page' : 'global',
      contextId: over.withPage ? probePageId : null,
    });
    const probeSessionId = createId();
    await db.insert(agentSessions).values({
      id: probeSessionId,
      ownerId: probeUserId,
      // A drive-scoped session unless the probe wants a user-scoped one (the
      // global-assistant shape) — withPage doubles as "drive-scoped" here.
      driveId: over.withPage ? probeDriveId : null,
      sandboxId: over.sandboxId,
      spriteInstanceId: 'i',
      spriteTornDownAt: over.spriteTornDownAt ?? null,
      updatedAt: new Date(),
    });
    sandboxIds.add(over.sandboxId);
    return { probeUserId, probeDriveId, probePageId, conversationId, probeSessionId };
  }

  async function reclaimed(sandboxId: string): Promise<boolean> {
    const rows = await db
      .select()
      .from(machineSpriteReclaims)
      .where(eq(machineSpriteReclaims.sandboxId, sandboxId));
    return rows.length > 0;
  }

  it('given the AGENT PAGE is deleted, should NOT touch the session — sessions are not page-anchored', async () => {
    // The old model cascaded sessions off their agent page. A session hosts
    // many agents' conversations now, so a page delete must leave it alive.
    const probe = await seedProbe({ suffix: 'page', sandboxId: 'sbx-cascade-page', withPage: true });
    await db.delete(pages).where(eq(pages.id, probe.probePageId));
    const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, probe.probeSessionId));
    expect(rows).toHaveLength(1);
    expect(await reclaimed('sbx-cascade-page')).toBe(false);
    await db.delete(users).where(eq(users.id, probe.probeUserId));
    expect(await reclaimed('sbx-cascade-page')).toBe(true);
  });

  it('given the DRIVE is deleted, should rescue the pointer — the direct driveId cascade', async () => {
    const probe = await seedProbe({ suffix: 'drive', sandboxId: 'sbx-cascade-drive', withPage: true });
    await db.delete(drives).where(eq(drives.id, probe.probeDriveId));
    expect(await reclaimed('sbx-cascade-drive')).toBe(true);
    await db.delete(users).where(eq(users.id, probe.probeUserId));
  });

  it('given the USER is erased (GDPR/account deletion), should rescue the pointer', async () => {
    const probe = await seedProbe({ suffix: 'user', sandboxId: 'sbx-cascade-user', withPage: false });
    await db.delete(users).where(eq(users.id, probe.probeUserId));
    expect(await reclaimed('sbx-cascade-user')).toBe(true);
  });

  it('given the Sprite is ALREADY torn down, should NOT re-enqueue its name', async () => {
    // The name is reusable, so re-enqueueing a confirmed-dead one asks the
    // reconciler to destroy whatever legitimately took the name next.
    const probe = await seedProbe({
      suffix: 'dead',
      sandboxId: 'sbx-cascade-dead',
      spriteTornDownAt: new Date(),
      withPage: false,
    });
    await db.delete(users).where(eq(users.id, probe.probeUserId));
    expect(await reclaimed('sbx-cascade-dead')).toBe(false);
  });
});

describe('conversation delete', () => {
  it('given a bound conversation is deleted, should leave the session ALIVE — threads do not own workspaces', async () => {
    // The inversion of the old PK-is-the-FK design: a session hosts many
    // threads, so one thread's deletion says nothing about the workspace.
    const sessionId = await seedSession({ sandboxId: 'sbx-conv-delete', spriteInstanceId: 'i' });
    const [bound] = await db.select().from(conversations).where(eq(conversations.sessionId, sessionId));

    await db.delete(conversations).where(eq(conversations.id, bound.id));

    const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
    expect(rows).toHaveLength(1);
    expect(await reclaimedOutside('sbx-conv-delete')).toBe(false);
  });
});

/** Outbox lookup usable outside the cascade describe's closure. */
async function reclaimedOutside(sandboxId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(machineSpriteReclaims)
    .where(eq(machineSpriteReclaims.sandboxId, sandboxId));
  return rows.length > 0;
}

describe('list bounds and ordering (review M3/M4)', () => {
  it('excludes ENDED sessions — retained rows are lifecycle facts, not listings', async () => {
    const active = await seedSession();
    const ended = await seedSession({ endedAt: new Date() });

    const listed = await store.list({ ownerId });
    const ids = listed.map((row) => row.id);
    expect(ids).toContain(active);
    expect(ids).not.toContain(ended);
  });

  it('orders newest activity first, nulls last — a poll must not reshuffle between refreshes', async () => {
    const older = await seedSession();
    const newer = await seedSession();
    const never = await seedSession();
    await db.update(agentSessions).set({ lastActiveAt: new Date(Date.now() - 60_000) }).where(eq(agentSessions.id, older));
    await db.update(agentSessions).set({ lastActiveAt: new Date() }).where(eq(agentSessions.id, newer));
    await db.update(agentSessions).set({ lastActiveAt: null }).where(eq(agentSessions.id, never));

    const listed = await store.list({ ownerId });
    const ids = listed.map((row) => row.id).filter((id) => [older, newer, never].includes(id));
    expect(ids).toEqual([newer, older, never]);
  });

  it('countActive counts NOT-ENDED rows — the spawn ceiling input, distinct from live sandboxes', async () => {
    const before = await store.countActive(ownerId);
    await seedSession(); // active, never provisioned (not "live")
    await seedSession({ endedAt: new Date() }); // ended — excluded
    const after = await store.countActive(ownerId);
    expect(after).toBe(before + 1);
  });
});

describe('list — driveId filter also includes the caller\'s own global sessions', () => {
  it('includes a null-driveId (global-assistant) session for the same owner', async () => {
    const globalSessionId = createId();
    sessionIds.push(globalSessionId);
    await db.insert(agentSessions).values({
      id: globalSessionId,
      ownerId,
      driveId: null,
      updatedAt: new Date(),
    });

    const listed = await store.list({ driveId, ownerId });
    expect(listed.map((row) => row.id)).toContain(globalSessionId);
  });

  it('still excludes a null-driveId session belonging to a DIFFERENT owner', async () => {
    const otherOwnerId = createId();
    await db.insert(users).values({
      id: otherOwnerId,
      email: `agent-sessions-store-other-${otherOwnerId}@example.test`,
      name: 'Other Owner',
    });
    const otherGlobalSessionId = createId();
    await db.insert(agentSessions).values({
      id: otherGlobalSessionId,
      ownerId: otherOwnerId,
      driveId: null,
      updatedAt: new Date(),
    });

    try {
      const listed = await store.list({ driveId, ownerId });
      expect(listed.map((row) => row.id)).not.toContain(otherGlobalSessionId);
    } finally {
      await db.delete(agentSessions).where(eq(agentSessions.id, otherGlobalSessionId));
      await db.delete(users).where(eq(users.id, otherOwnerId));
    }
  });

  it('given an OWNERLESS driveId filter, excludes every global session — no owner to scope the union to (review: Codex P1 on #2325)', async () => {
    // `{ driveId }` alone is the admin "every session in this drive, any
    // owner" shape (`agent-sessions.test.ts`'s `listAgentSessions` "given a
    // drive filter" case). Without an owner in the filter, unioning in
    // `driveId IS NULL` would return every user's global-assistant sessions
    // across the whole deployment, not just sessions relevant to this drive.
    const otherOwnerId = createId();
    await db.insert(users).values({
      id: otherOwnerId,
      email: `agent-sessions-store-ownerless-${otherOwnerId}@example.test`,
      name: 'Ownerless Probe Owner',
    });
    const otherGlobalSessionId = createId();
    await db.insert(agentSessions).values({
      id: otherGlobalSessionId,
      ownerId: otherOwnerId,
      driveId: null,
      updatedAt: new Date(),
    });
    const driveScoped = await seedSession();

    try {
      const listed = await store.list({ driveId });
      const ids = listed.map((row) => row.id);
      expect(ids).toContain(driveScoped);
      expect(ids).not.toContain(otherGlobalSessionId);
    } finally {
      await db.delete(agentSessions).where(eq(agentSessions.id, otherGlobalSessionId));
      await db.delete(users).where(eq(users.id, otherOwnerId));
    }
  });

  it('given driveId with an explicitly-undefined ownerId, behaves as ownerless against real Postgres (review: CodeRabbit)', async () => {
    // `AgentSessionListFilter` no longer has a variant shaped like this — the
    // cast pins the runtime guard against a value that reaches here some
    // other way (a bypassed cast, a loosely-typed caller upstream), proving
    // the SQL itself (not just the type system) refuses to treat a
    // present-but-unset ownerId as "owned".
    const otherOwnerId = createId();
    await db.insert(users).values({
      id: otherOwnerId,
      email: `agent-sessions-store-undef-owner-${otherOwnerId}@example.test`,
      name: 'Undefined-Owner Probe Owner',
    });
    const otherGlobalSessionId = createId();
    await db.insert(agentSessions).values({
      id: otherGlobalSessionId,
      ownerId: otherOwnerId,
      driveId: null,
      updatedAt: new Date(),
    });
    const driveScoped = await seedSession();
    const filter = { driveId, ownerId: undefined } as unknown as AgentSessionListFilter;

    try {
      const listed = await store.list(filter);
      const ids = listed.map((row) => row.id);
      expect(ids).toContain(driveScoped);
      expect(ids).not.toContain(otherGlobalSessionId);
    } finally {
      await db.delete(agentSessions).where(eq(agentSessions.id, otherGlobalSessionId));
      await db.delete(users).where(eq(users.id, otherOwnerId));
    }
  });
});

describe('createIfUnderLimit — the spawn ceiling made atomic (review #2261/2)', () => {
  it('given the owner is under the ceiling, should mint a session', async () => {
    const result = await store.createIfUnderLimit({
      ownerId,
      driveId,
      name: 'ceiling test',
      now: new Date(),
      maxActive: 1_000_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    sessionIds.push(result.session.id);
    expect(result.session.ownerId).toBe(ownerId);
  });

  it('given the owner is AT the ceiling, should refuse without inserting', async () => {
    const before = await store.countActive(ownerId);
    const result = await store.createIfUnderLimit({ ownerId, driveId, name: null, now: new Date(), maxActive: before });
    expect(result).toEqual({ ok: false, reason: 'limit_reached' });
    expect(await store.countActive(ownerId)).toBe(before);
  });

  it('given N concurrent spawns racing the SAME ceiling, should mint EXACTLY the remaining allowance — not N (the TOCTOU a count-then-insert pre-check left open)', async () => {
    const before = await store.countActive(ownerId);
    const allowance = 3;
    const maxActive = before + allowance;
    const attempts = 10;

    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        store.createIfUnderLimit({ ownerId, driveId, name: null, now: new Date(), maxActive }),
      ),
    );
    const minted = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
    for (const r of minted) sessionIds.push(r.session.id);

    expect(minted).toHaveLength(allowance);
    expect(await store.countActive(ownerId)).toBe(maxActive);
  });
});
