/**
 * Imago agent provisioning with a ONE-connection `@pagespace/db` pool
 * (DB_POOL_MAX=1), against a real Postgres.
 *
 * Provisioning runs inside the Home transaction, which holds the pool's only
 * connection and the user-row lock. Any read that goes through the global pool
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
});
