/**
 * user_builtin_agents against a REAL Postgres: a schema test cannot see whether
 * the unique index refuses a second pointer or whether the cascades fire.
 *
 * Run with a migrated test database:
 *   DATABASE_URL=postgresql://user:password@localhost:5433/pagespace_test \
 *   bun run --filter '@pagespace/db' test:integration -- user-builtin-agents
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { factories } from '../test/factories';
import { db } from '../db';
import { users } from '../schema/auth';
import { drives, pages } from '../schema/core';
import { userBuiltinAgents } from '../schema/user-builtin-agents';

/** drizzle 0.45 wraps driver errors; the Postgres SQLSTATE lives on `.cause`. */
function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const UNIQUE_VIOLATION = '23505';

describe('user_builtin_agents (real Postgres)', () => {
  const createdUsers: string[] = [];
  const createdDrives: string[] = [];

  async function seed() {
    const user = await factories.createUser();
    const drive = await factories.createDrive(user.id);
    createdUsers.push(user.id);
    createdDrives.push(drive.id);
    const page = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Imago' });
    return { user, drive, page };
  }

  afterEach(async () => {
    for (const id of createdDrives.splice(0)) await db.delete(drives).where(eq(drives.id, id)).catch(() => {});
    for (const id of createdUsers.splice(0)) await db.delete(users).where(eq(users.id, id)).catch(() => {});
  });

  it('given a user and an agent page, should store the pointer', async () => {
    const { user, page } = await seed();
    const [row] = await db.insert(userBuiltinAgents).values({ userId: user.id, key: 'imago', pageId: page.id }).returning();
    expect(row).toMatchObject({ userId: user.id, key: 'imago', pageId: page.id });
  });

  it('given an existing pointer for (userId, key), should refuse a second row', async () => {
    const { user, drive, page } = await seed();
    const other = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Imago 2' });
    await db.insert(userBuiltinAgents).values({ userId: user.id, key: 'imago', pageId: page.id });
    const second = db.insert(userBuiltinAgents).values({ userId: user.id, key: 'imago', pageId: other.id });
    await expect(second).rejects.toSatisfy((error: unknown) => pgCode(error) === UNIQUE_VIOLATION);
  });

  it('given two concurrent inserts for one (userId, key), should keep exactly one row', async () => {
    const { user, drive, page } = await seed();
    const other = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Imago 2' });
    const results = await Promise.allSettled([
      db.insert(userBuiltinAgents).values({ userId: user.id, key: 'imago-planner', pageId: page.id }),
      db.insert(userBuiltinAgents).values({ userId: user.id, key: 'imago-planner', pageId: other.id }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(pgCode(rejected?.reason)).toBe(UNIQUE_VIOLATION);
    const rows = await db.select().from(userBuiltinAgents).where(eq(userBuiltinAgents.userId, user.id));
    expect(rows).toHaveLength(1);
  });

  it('given the same key for two different users, should store both', async () => {
    const a = await seed();
    const b = await seed();
    await db.insert(userBuiltinAgents).values([
      { userId: a.user.id, key: 'imago', pageId: a.page.id },
      { userId: b.user.id, key: 'imago', pageId: b.page.id },
    ]);
    const rows = await db.select().from(userBuiltinAgents).where(eq(userBuiltinAgents.key, 'imago'));
    expect(rows.filter((row) => row.userId === a.user.id || row.userId === b.user.id)).toHaveLength(2);
  });

  it('given the agent page is deleted, should delete its pointer', async () => {
    const { user, page } = await seed();
    await db.insert(userBuiltinAgents).values({ userId: user.id, key: 'imago-researcher', pageId: page.id });
    await db.delete(pages).where(eq(pages.id, page.id));
    const rows = await db.select().from(userBuiltinAgents).where(eq(userBuiltinAgents.userId, user.id));
    expect(rows).toHaveLength(0);
  });

  it('given the user is deleted, should delete their pointers through the userId FK alone', async () => {
    // The page lives in ANOTHER user's drive, so deleting this user cannot reach
    // the pointer through drives -> pages -> pageId; only the userId cascade can.
    const owner = await seed();
    const user = await factories.createUser();
    createdUsers.push(user.id);
    await db.insert(userBuiltinAgents).values({ userId: user.id, key: 'imago', pageId: owner.page.id });
    await db.delete(users).where(eq(users.id, user.id));
    const rows = await db.select().from(userBuiltinAgents).where(eq(userBuiltinAgents.userId, user.id));
    expect(rows).toHaveLength(0);
    const [page] = await db.select().from(pages).where(eq(pages.id, owner.page.id));
    expect(page?.id).toBe(owner.page.id);
  });
});
