/**
 * Imago agent provisioning with a ONE-connection `@pagespace/db` pool
 * (DB_POOL_MAX=1), against a real Postgres.
 *
 * Provisioning runs in its own transaction (after the Home transaction
 * commits), which holds the pool's only connection and the user-row lock. Any read that goes through the global pool
 * instead of the transaction waits for a second connection that cannot come
 * until the transaction ends: the pool's 10 s connection timeout, then a
 * fallback. In production (pool 10) the same stall needs only ten concurrent
 * provisions on one instance. This file proves every read stays on the
 * transaction: a new user's Home provisioning completes promptly, and the
 * audit rows name the real actor rather than 'unknown@system'.
 *
 * Its own file because the pool size is read once, when `@pagespace/db/db` is
 * first imported; vitest re-evaluates modules per file.
 *
 * Requires DATABASE_URL → a migrated Postgres. FAILS LOUDLY when none is
 * reachable; local runs without a database opt out with ALLOW_SKIP_DB_TESTS=1.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

const previousPoolMax = vi.hoisted(() => {
  const previous = process.env.DB_POOL_MAX;
  process.env.DB_POOL_MAX = '1';
  return previous;
});

import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { userBuiltinAgents } from '@pagespace/db/schema/user-builtin-agents';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { BUILTIN_AGENT_KEYS } from '../builtin-agents';
import { provisionHomeDriveIfNeeded } from '../../onboarding/home-drive';

// The pool has been built by the imports above. Restore the variable so it
// cannot shrink the pool of a later file in the same long-lived fork.
if (previousPoolMax === undefined) delete process.env.DB_POOL_MAX;
else process.env.DB_POOL_MAX = previousPoolMax;

/** Far below the pool's 10 s connection timeout, far above a real run (~100 ms). */
const PROMPT_MS = 3000;

let dbAvailable = false;

beforeAll(async () => {
  try {
    await db.select().from(pages).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('provision-imago-agents-single-connection.integration.test.ts', error);
    dbAvailable = false;
  }
});

describe('Imago agent provisioning on a single-connection pool (real Postgres)', () => {
  it('given DB_POOL_MAX=1, should provision a new user promptly with the real actor on every create row', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser();

    const started = Date.now();
    await provisionHomeDriveIfNeeded(user.id);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(PROMPT_MS);

    const pointers = await db.select().from(userBuiltinAgents).where(eq(userBuiltinAgents.userId, user.id));
    expect(pointers).toHaveLength(BUILTIN_AGENT_KEYS.length);
    const logs = await db
      .select({ actorEmail: activityLogs.actorEmail, pageId: activityLogs.pageId })
      .from(activityLogs)
      .where(and(eq(activityLogs.operation, 'create'), inArray(activityLogs.pageId, pointers.map((p) => p.pageId))));
    expect(logs).toHaveLength(BUILTIN_AGENT_KEYS.length);
    for (const log of logs) expect(log.actorEmail).toBe(user.email);
  }, 20_000);

  it('given DB_POOL_MAX=1 and a pre-10.10 user, should clean up promptly on the transaction, with the real actor on every row', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser();
    const owned = await factories.createDrive(user.id, { name: 'Owned' });
    await provisionHomeDriveIfNeeded(user.id);
    const [pointer] = await db.select().from(userBuiltinAgents).where(eq(userBuiltinAgents.userId, user.id));
    const [imago] = await db.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, pointer.pageId));
    // The earlier model's state: acting through memberships, a retired agent, a drive grant.
    await db.update(pages).set({ userScopedAccess: false }).where(eq(pages.id, pointer.pageId));
    const retired = await factories.createPage(imago.driveId, { title: 'Imago Planner', type: 'AI_CHAT' });
    await db.insert(userBuiltinAgents).values({ userId: user.id, key: 'imago-planner', pageId: retired.id });
    await db.insert(driveAgentMembers).values({ driveId: owned.id, agentPageId: pointer.pageId, role: 'MEMBER', addedBy: user.id });

    // Every read the cleanup makes must ride the transaction: through the
    // global pool it would wait 10 s for the pool's only connection.
    const started = Date.now();
    await provisionHomeDriveIfNeeded(user.id);
    expect(Date.now() - started).toBeLessThan(PROMPT_MS);

    const grants = await db.select().from(driveAgentMembers).where(eq(driveAgentMembers.driveId, owned.id));
    expect(grants).toEqual([]);
    const [page] = await db.select({ userScopedAccess: pages.userScopedAccess }).from(pages).where(eq(pages.id, pointer.pageId));
    expect(page.userScopedAccess).toBe(true);
    const logs = await db
      .select({ actorEmail: activityLogs.actorEmail })
      .from(activityLogs)
      .where(and(inArray(activityLogs.operation, ['update', 'trash']), inArray(activityLogs.pageId, [pointer.pageId, retired.id])));
    expect(logs).toHaveLength(2);
    for (const log of logs) expect(log.actorEmail).toBe(user.email);
  }, 20_000);
});
