/**
 * Agent Signup Phase 1 leaf 1 — `users.accountType` and the three agent
 * identity tables, proven against a REAL Postgres (a schema file cannot show
 * that a default fills existing rows, that a unique index refuses a duplicate
 * hash, or that a consumed challenge stays consumed).
 *
 * Run with a migrated test database:
 *   DATABASE_URL=postgresql://user:password@localhost:5433/pagespace_test \
 *   bun run --filter '@pagespace/db' test:integration -- agent-identities
 */
import { describe, it, expect, afterEach } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '../test/factories';
import { db } from '../db';
import { users } from '../schema/auth';
import { agentIdentities, agentClaims, agentSignupChallenges } from '../schema/agent-identities';

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

describe('agent identity schema (real Postgres)', () => {
  const createdUsers: string[] = [];
  const createdChallenges: string[] = [];

  async function seedUser(overrides?: Partial<typeof users.$inferInsert>) {
    const user = await factories.createUser(overrides);
    createdUsers.push(user.id);
    return user;
  }

  afterEach(async () => {
    for (const id of createdChallenges.splice(0)) {
      await db.delete(agentSignupChallenges).where(eq(agentSignupChallenges.id, id)).catch(() => {});
    }
    for (const id of createdUsers.splice(0)) {
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
  });

  it('given a user inserted without accountType, should read as human (existing rows need no backfill)', async () => {
    const user = await seedUser();
    const [row] = await db.select({ accountType: users.accountType }).from(users).where(eq(users.id, user.id));
    expect(row?.accountType).toBe('human');
  });

  it('given accountType agent, should persist it', async () => {
    const user = await seedUser({ accountType: 'agent', emailVerified: null });
    const [row] = await db.select({ accountType: users.accountType }).from(users).where(eq(users.id, user.id));
    expect(row?.accountType).toBe('agent');
  });

  it('given an agent identity whose user is deleted, should cascade the identity away', async () => {
    const agent = await seedUser({ accountType: 'agent' });
    await db.insert(agentIdentities).values({ userId: agent.id, secretHash: `h-${createId()}`, secretPrefix: 'ps_agent_abc' });

    await db.delete(users).where(eq(users.id, agent.id));

    const rows = await db.select().from(agentIdentities).where(eq(agentIdentities.userId, agent.id));
    expect(rows).toHaveLength(0);
  });

  it('given an owner who is deleted, should null ownerUserId and keep the agent identity', async () => {
    const agent = await seedUser({ accountType: 'agent' });
    const owner = await seedUser();
    await db.insert(agentIdentities).values({
      userId: agent.id,
      secretHash: `h-${createId()}`,
      secretPrefix: 'ps_agent_abc',
      ownerUserId: owner.id,
      claimedAt: new Date(),
    });

    await db.delete(users).where(eq(users.id, owner.id));

    const [row] = await db.select().from(agentIdentities).where(eq(agentIdentities.userId, agent.id));
    expect(row?.ownerUserId).toBeNull();
    expect(row?.secretVersion).toBe(1);
  });

  it('given two identities with the same secretHash, should refuse the second with unique_violation 23505', async () => {
    const a = await seedUser({ accountType: 'agent' });
    const b = await seedUser({ accountType: 'agent' });
    const secretHash = `h-${createId()}`;
    await db.insert(agentIdentities).values({ userId: a.id, secretHash, secretPrefix: 'ps_agent_abc' });

    let code: string | undefined;
    try {
      await db.insert(agentIdentities).values({ userId: b.id, secretHash, secretPrefix: 'ps_agent_abc' });
    } catch (error) {
      code = pgCode(error);
    }
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('given a claim, should default pollIntervalSeconds to 5 and cascade with the agent', async () => {
    const agent = await seedUser({ accountType: 'agent' });
    const [claim] = await db.insert(agentClaims).values({
      agentUserId: agent.id,
      userCodeHash: `u-${createId()}`,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    }).returning();
    expect(claim?.pollIntervalSeconds).toBe(5);
    expect(claim?.ownerUserId).toBeNull();

    await db.delete(users).where(eq(users.id, agent.id));
    const rows = await db.select().from(agentClaims).where(eq(agentClaims.agentUserId, agent.id));
    expect(rows).toHaveLength(0);
  });

  it('given a challenge consumed twice with UPDATE … WHERE consumedAt IS NULL RETURNING, should return the row exactly once', async () => {
    const [challenge] = await db.insert(agentSignupChallenges).values({
      challengeHash: `c-${createId()}`,
      difficultyBits: 20,
      expiresAt: new Date(Date.now() + 5 * 60_000),
    }).returning();
    if (!challenge) throw new Error('challenge insert returned nothing');
    createdChallenges.push(challenge.id);

    const consume = () =>
      db.update(agentSignupChallenges)
        .set({ consumedAt: sql`(now() at time zone 'utc')` })
        .where(and(eq(agentSignupChallenges.id, challenge.id), isNull(agentSignupChallenges.consumedAt)))
        .returning({ id: agentSignupChallenges.id });

    const results = await Promise.all([consume(), consume()]);
    expect(results.map((r) => r.length).sort()).toEqual([0, 1]);
  });
});
