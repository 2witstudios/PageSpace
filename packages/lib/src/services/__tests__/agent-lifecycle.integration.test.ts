/**
 * Agent Signup Phase 5 leaf 3 — the lifecycle store against a REAL Postgres.
 * The orchestration is unit tested (`agent-lifecycle.test.ts`); what only a
 * database shows is that the prunes delete exactly the expired rows and the
 * candidate query returns exactly unclaimed, never-authenticated agents created
 * at or before the cutoff.
 *
 * Excluded from the unit run (vitest.config.ts); CI's lib integration step
 * picks it up by glob.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { agentClaims, agentIdentities, agentSignupChallenges } from '@pagespace/db/schema/agent-identities';
import { hashToken } from '../../auth/token-utils';
import { agentSyntheticEmail } from '../../auth/agent/reserved-email';
import { AGENT_UNAUTHENTICATED_TTL_MS } from '../../auth/agent/lifecycle-decision';
import { agentLifecycleStore, CLAIM_EXPIRED_GRACE_MS } from '../agent-lifecycle';

const userIds: string[] = [];
const challengeIds: string[] = [];

afterAll(async () => {
  if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  if (challengeIds.length > 0) await db.delete(agentSignupChallenges).where(inArray(agentSignupChallenges.id, challengeIds));
});

const NOW = new Date();
const CUTOFF = new Date(NOW.getTime() - AGENT_UNAUTHENTICATED_TTL_MS);

async function insertUser(accountType: 'human' | 'agent'): Promise<string> {
  const id = createId();
  userIds.push(id);
  await db.insert(users).values({
    id,
    name: 'lifecycle-test',
    email: accountType === 'agent' ? agentSyntheticEmail(id) : `${id}@example.com`,
    accountType,
  });
  return id;
}

async function insertAgent(fields: { createdAt: Date; lastAuthAt?: Date | null; ownerUserId?: string | null }): Promise<string> {
  const userId = await insertUser('agent');
  await db.insert(agentIdentities).values({
    userId,
    secretHash: hashToken(`secret-${userId}`),
    secretPrefix: 'ps_agent_xx',
    createdAt: fields.createdAt,
    lastAuthAt: fields.lastAuthAt ?? null,
    ownerUserId: fields.ownerUserId ?? null,
  });
  return userId;
}

describe('agentLifecycleStore (real Postgres)', () => {
  it('prunes only expired signup challenges', async () => {
    const expiredId = createId();
    const liveId = createId();
    challengeIds.push(expiredId, liveId);
    await db.insert(agentSignupChallenges).values([
      { id: expiredId, challengeHash: hashToken(`c-${expiredId}`), difficultyBits: 1, expiresAt: new Date(NOW.getTime() - 1000) },
      { id: liveId, challengeHash: hashToken(`c-${liveId}`), difficultyBits: 1, expiresAt: new Date(NOW.getTime() + 60_000) },
    ]);

    expect(await agentLifecycleStore.pruneExpiredChallenges(NOW)).toBeGreaterThanOrEqual(1);

    const left = await db.select({ id: agentSignupChallenges.id }).from(agentSignupChallenges).where(inArray(agentSignupChallenges.id, [expiredId, liveId]));
    expect(left.map((row) => row.id)).toEqual([liveId]);
  });

  it('prunes only claims expired for longer than the grace period, so a poll just after expiry still answers expired_token', async () => {
    const agentId = await insertAgent({ createdAt: NOW, lastAuthAt: NOW });
    const staleId = createId();
    const justExpiredId = createId();
    const liveId = createId();
    await db.insert(agentClaims).values([
      { id: staleId, agentUserId: agentId, claimTokenHash: hashToken(`c-${staleId}`), userCodeHash: hashToken(`u-${staleId}`), expiresAt: new Date(NOW.getTime() - CLAIM_EXPIRED_GRACE_MS - 1000) },
      { id: justExpiredId, agentUserId: agentId, claimTokenHash: hashToken(`c-${justExpiredId}`), userCodeHash: hashToken(`u-${justExpiredId}`), expiresAt: new Date(NOW.getTime() - 1000) },
      { id: liveId, agentUserId: agentId, claimTokenHash: hashToken(`c-${liveId}`), userCodeHash: hashToken(`u-${liveId}`), expiresAt: new Date(NOW.getTime() + 60_000) },
    ]);

    expect(await agentLifecycleStore.pruneExpiredClaims(NOW)).toBeGreaterThanOrEqual(1);

    const left = await db.select({ id: agentClaims.id }).from(agentClaims).where(inArray(agentClaims.id, [staleId, justExpiredId, liveId]));
    expect(left.map((row) => row.id).sort()).toEqual([justExpiredId, liveId].sort());
  });

  it('finds unclaimed, never-authenticated agents created at or before the cutoff — and nothing else', async () => {
    const owner = await insertUser('human');
    const abandoned = await insertAgent({ createdAt: CUTOFF });
    const young = await insertAgent({ createdAt: new Date(CUTOFF.getTime() + 60_000) });
    const signedIn = await insertAgent({ createdAt: CUTOFF, lastAuthAt: NOW });
    const claimed = await insertAgent({ createdAt: CUTOFF, ownerUserId: owner });

    const candidates = await agentLifecycleStore.findCandidates({ createdAtOrBefore: CUTOFF, limit: 1000, after: null });
    const ids = candidates.map((row) => row.userId);

    expect(ids).toContain(abandoned);
    expect(ids).not.toContain(young);
    expect(ids).not.toContain(signedIn);
    expect(ids).not.toContain(claimed);
  });

  it('pages by (createdAt, userId) strictly after the cursor, so a drained batch is never fetched again', async () => {
    const base = new Date(CUTOFF.getTime() - 10 * 24 * 60 * 60 * 1000);
    const first = await insertAgent({ createdAt: base });
    const second = await insertAgent({ createdAt: base });
    const third = await insertAgent({ createdAt: new Date(base.getTime() + 1000) });
    const ours = new Set([first, second, third]);
    const [tieLow, tieHigh] = [first, second].sort();

    const page = async (after: { createdAt: Date; userId: string } | null) =>
      (await agentLifecycleStore.findCandidates({ createdAtOrBefore: CUTOFF, limit: 1000, after })).map((row) => row.userId).filter((id) => ours.has(id));

    expect(await page(null)).toEqual([tieLow, tieHigh, third]);
    expect(await page({ createdAt: base, userId: tieLow as string })).toEqual([tieHigh, third]);
    expect(await page({ createdAt: base, userId: tieHigh as string })).toEqual([third]);
    expect(await page({ createdAt: new Date(base.getTime() + 1000), userId: third })).toEqual([]);
  });

  it('reads one lifecycle row fresh, and null for someone without an identity', async () => {
    const agent = await insertAgent({ createdAt: CUTOFF });
    const human = await insertUser('human');

    expect(await agentLifecycleStore.getLifecycleRow(agent)).toMatchObject({ userId: agent, ownerUserId: null, lastAuthAt: null });
    expect(await agentLifecycleStore.getLifecycleRow(human)).toBeNull();
  });
});
