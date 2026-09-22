/**
 * Agent Signup Phase 1 leaf 3 — the agent-identity service against a REAL
 * Postgres (ADR 0007 Decisions 1, 2, 4, 14; threat model T2, T3).
 *
 * The pure decisions (secret shape, sign-in precedence) are frozen and unit
 * tested in `src/auth/agent/__tests__`. What only a database can show is the
 * adapter: that the user row, the identity row and the challenge consumption
 * commit or roll back TOGETHER, that two racing submits of one challenge
 * create one account, and that revoke actually bumps `tokenVersion`.
 *
 * Excluded from the unit run (vitest.config.ts); CI's lib integration step
 * picks it up by glob. Locally, against a migrated database:
 *   DATABASE_URL=postgresql://user:password@localhost:5433/pagespace_test \
 *     bun run --filter '@pagespace/lib' test:integration -- src/services/__tests__/agent-identities.integration.test.ts
 */
import { describe, it, expect, afterAll, vi } from 'vitest';

// Real provisioning by default; a test flips the flag to prove a failure after
// commit never swallows the one-time secret.
const homeDrive = vi.hoisted(() => ({ failNext: false }));
vi.mock('../../onboarding/home-drive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../onboarding/home-drive')>();
  return {
    ...actual,
    provisionHomeDriveIfNeeded: async (userId: string) => {
      if (homeDrive.failNext) {
        homeDrive.failNext = false;
        throw new Error('simulated home drive failure');
      }
      return actual.provisionHomeDriveIfNeeded(userId);
    },
  };
});
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray, lt } from '@pagespace/db/operators';
import { users, mcpTokens } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { agentIdentities, agentSignupChallenges } from '@pagespace/db/schema/agent-identities';
import { hashToken } from '../../auth/token-utils';
import { isAgentSecretShape } from '../../auth/agent/secret';
import { isAgentReservedEmail } from '../../auth/agent/reserved-email';
import { isEmailVerified } from '../../auth/verification-utils';
import {
  createAgentAccount,
  verifyAgentSecret,
  rotateAgentSecret,
  revokeAgent,
  getAgentIdentitySummary,
  issueAgentSignupChallenge,
  findAgentSignupChallenge,
} from '../agent-identities';

const createdUserIds: string[] = [];
const createdChallengeIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(drives).where(inArray(drives.ownerId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  if (createdChallengeIds.length > 0) {
    await db.delete(agentSignupChallenges).where(inArray(agentSignupChallenges.id, createdChallengeIds));
  }
});

async function issueChallenge(overrides?: { expiresAt?: Date; consumedAt?: Date | null }): Promise<string> {
  const [row] = await db.insert(agentSignupChallenges).values({
    challengeHash: hashToken(`challenge-${createId()}`),
    difficultyBits: 20,
    expiresAt: overrides?.expiresAt ?? new Date(Date.now() + 5 * 60_000),
    consumedAt: overrides?.consumedAt ?? null,
  }).returning({ id: agentSignupChallenges.id });
  if (!row) throw new Error('challenge insert returned nothing');
  createdChallengeIds.push(row.id);
  return row.id;
}

async function signUp(challengeId: string, now = new Date()) {
  const result = await createAgentAccount({
    name: 'Test Agent',
    source: 'claude-code',
    tosAcceptedAt: now,
    createdByIp: '203.0.113.7',
    challengeId,
    now,
  });
  if (result.ok) createdUserIds.push(result.data.userId);
  return result;
}

/** A live mcp_ key row for `userId` (the key an agent mints via POST /api/auth/mcp-tokens). */
async function mintKeyRow(userId: string): Promise<string> {
  const [row] = await db.insert(mcpTokens).values({
    userId,
    tokenHash: hashToken(`mcp_${createId()}`),
    tokenPrefix: 'mcp_test',
    name: 'agent key',
  }).returning({ id: mcpTokens.id });
  if (!row) throw new Error('mcp token insert returned nothing');
  return row.id;
}

async function keyRevokedAt(id: string): Promise<Date | null> {
  const [row] = await db.select({ revokedAt: mcpTokens.revokedAt }).from(mcpTokens).where(eq(mcpTokens.id, id));
  return row?.revokedAt ?? null;
}

describe('createAgentAccount', () => {
  it('given a fresh challenge, should create an agent user with a synthetic address, emailVerified null and the identity row, returning the secret once', async () => {
    const challengeId = await issueChallenge();

    const result = await signUp(challengeId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { userId, secret, claimToken, email } = result.data;

    expect(isAgentSecretShape(secret)).toBe(true);
    expect(isAgentReservedEmail(email)).toBe(true);
    expect(claimToken.length).toBeGreaterThan(20);

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user?.accountType).toBe('agent');
    expect(user?.provider).toBe('email');
    expect(user?.tokenVersion).toBe(1);
    expect(user?.emailVerified).toBeNull();
    expect(user?.tosAcceptedAt).toBeInstanceOf(Date);
    expect(user?.emailBidx).toMatch(/^[0-9a-f]{64}$/);

    const [identity] = await db.select().from(agentIdentities).where(eq(agentIdentities.userId, userId));
    expect(identity?.secretHash).toBe(hashToken(secret));
    expect(identity?.claimTokenHash).toBe(hashToken(claimToken));
    expect(identity?.secretVersion).toBe(1);
    expect(identity?.source).toBe('claude-code');
    expect(identity?.createdByIp).toBe('203.0.113.7');
    expect(identity?.ownerUserId).toBeNull();
    // Hash only: the plaintext never reaches a column.
    expect(JSON.stringify(identity)).not.toContain(secret);

    const [challenge] = await db.select().from(agentSignupChallenges).where(eq(agentSignupChallenges.id, challengeId));
    expect(challenge?.consumedAt).toBeInstanceOf(Date);
  });

  it('given a created agent, should provision its home drive', async () => {
    const result = await signUp(await issueChallenge());
    if (!result.ok) throw new Error('signup failed');

    const home = await db.select({ id: drives.id }).from(drives)
      .where(and(eq(drives.ownerId, result.data.userId), eq(drives.kind, 'HOME')));
    expect(home).toHaveLength(1);
  });

  it('given home drive provisioning fails after the commit, should still return the one-time secret (the account exists; provisioning is retried lazily)', async () => {
    homeDrive.failNext = true;

    const result = await signUp(await issueChallenge());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await verifyAgentSecret({ secret: result.data.secret, now: new Date() })).decision).toEqual({ status: 'ok' });
  });

  it('given a fresh agent (D-31 option A), should be refused by the isEmailVerified gate that guards DMs, invites and uploads', async () => {
    const result = await signUp(await issueChallenge());
    if (!result.ok) throw new Error('signup failed');

    expect(await isEmailVerified(result.data.userId)).toBe(false);
  });

  it('given the same challenge submitted twice concurrently, should create exactly one account', async () => {
    const challengeId = await issueChallenge();

    const results = await Promise.all([signUp(challengeId), signUp(challengeId)]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => (r.ok ? null : r.error))).toEqual(['challenge_invalid']);
  });

  it('given a consumed challenge, should refuse with challenge_invalid and create no user', async () => {
    const challengeId = await issueChallenge({ consumedAt: new Date() });
    const before = await db.select({ id: users.id }).from(users).where(eq(users.accountType, 'agent'));

    const result = await signUp(challengeId);

    expect(result).toEqual({ ok: false, error: 'challenge_invalid' });
    const after = await db.select({ id: users.id }).from(users).where(eq(users.accountType, 'agent'));
    expect(after.length).toBe(before.length);
  });

  it('given an expired challenge, should refuse with challenge_invalid and leave it unconsumed', async () => {
    const challengeId = await issueChallenge({ expiresAt: new Date(Date.now() - 1000) });

    const result = await signUp(challengeId);

    expect(result).toEqual({ ok: false, error: 'challenge_invalid' });
    const [challenge] = await db.select().from(agentSignupChallenges).where(eq(agentSignupChallenges.id, challengeId));
    expect(challenge?.consumedAt).toBeNull();
  });

  it('given an unknown challenge id, should refuse with challenge_invalid', async () => {
    expect(await signUp(createId())).toEqual({ ok: false, error: 'challenge_invalid' });
  });
});

describe('verifyAgentSecret', () => {
  it('given the secret returned at signup, should be ok for that user and stamp lastAuthAt', async () => {
    const result = await signUp(await issueChallenge());
    if (!result.ok) throw new Error('signup failed');

    const now = new Date();
    const verified = await verifyAgentSecret({ secret: result.data.secret, now });

    expect(verified).toEqual({ decision: { status: 'ok' }, userId: result.data.userId });
    const [identity] = await db.select().from(agentIdentities).where(eq(agentIdentities.userId, result.data.userId));
    expect(identity?.lastAuthAt).toBeInstanceOf(Date);
  });

  it('given a well-shaped secret nobody holds, should be not_found', async () => {
    const verified = await verifyAgentSecret({ secret: `ps_agent_${'a'.repeat(32)}`, now: new Date() });
    expect(verified).toEqual({ decision: { status: 'not_found' }, userId: null });
  });

  it('given a malformed secret, should be not_found without a lookup', async () => {
    expect(await verifyAgentSecret({ secret: 'not-a-secret', now: new Date() }))
      .toEqual({ decision: { status: 'not_found' }, userId: null });
  });

  it('given a suspended agent, should be suspended', async () => {
    const result = await signUp(await issueChallenge());
    if (!result.ok) throw new Error('signup failed');
    await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, result.data.userId));

    const verified = await verifyAgentSecret({ secret: result.data.secret, now: new Date() });
    expect(verified.decision).toEqual({ status: 'suspended' });
  });
});

describe('rotateAgentSecret', () => {
  it('given rotation without token revocation, should retire the old secret, bump secretVersion and keep tokenVersion', async () => {
    const result = await signUp(await issueChallenge());
    if (!result.ok) throw new Error('signup failed');
    const { userId, secret: oldSecret } = result.data;

    const rotated = await rotateAgentSecret({ userId, revokeTokens: false });

    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.data.secret).not.toBe(oldSecret);
    expect((await verifyAgentSecret({ secret: oldSecret, now: new Date() })).decision).toEqual({ status: 'not_found' });
    expect((await verifyAgentSecret({ secret: rotated.data.secret, now: new Date() })).decision).toEqual({ status: 'ok' });

    const [identity] = await db.select().from(agentIdentities).where(eq(agentIdentities.userId, userId));
    expect(identity?.secretVersion).toBe(2);
    const [user] = await db.select({ tokenVersion: users.tokenVersion }).from(users).where(eq(users.id, userId));
    expect(user?.tokenVersion).toBe(1);
  });

  it('given rotation with token revocation, should bump users.tokenVersion', async () => {
    const result = await signUp(await issueChallenge());
    if (!result.ok) throw new Error('signup failed');

    await rotateAgentSecret({ userId: result.data.userId, revokeTokens: true });

    const [user] = await db.select({ tokenVersion: users.tokenVersion }).from(users).where(eq(users.id, result.data.userId));
    expect(user?.tokenVersion).toBe(2);
  });

  it('given a user that is not an agent, should be not_found', async () => {
    expect(await rotateAgentSecret({ userId: createId(), revokeTokens: false })).toEqual({ ok: false, error: 'not_found' });
  });

  it("given rotation WITH token revocation, should also revoke the agent's mcp_ keys (they carry no tokenVersion), and no one else's", async () => {
    const agent = await signUp(await issueChallenge());
    const other = await signUp(await issueChallenge());
    if (!agent.ok || !other.ok) throw new Error('signup failed');
    const agentKey = await mintKeyRow(agent.data.userId);
    const otherKey = await mintKeyRow(other.data.userId);

    await rotateAgentSecret({ userId: agent.data.userId, revokeTokens: true });

    expect(await keyRevokedAt(agentKey)).toBeInstanceOf(Date);
    expect(await keyRevokedAt(otherKey)).toBeNull();
  });

  it("given rotation WITHOUT token revocation, should leave the agent's mcp_ keys live", async () => {
    const agent = await signUp(await issueChallenge());
    if (!agent.ok) throw new Error('signup failed');
    const key = await mintKeyRow(agent.data.userId);

    await rotateAgentSecret({ userId: agent.data.userId, revokeTokens: false });

    expect(await keyRevokedAt(key)).toBeNull();
  });
});

describe('revokeAgent', () => {
  it('given a live agent, should set revokedAt, bump tokenVersion, and make its secret revoked', async () => {
    const result = await signUp(await issueChallenge());
    if (!result.ok) throw new Error('signup failed');
    const { userId, secret } = result.data;

    expect(await revokeAgent({ userId, now: new Date() })).toEqual({ revoked: true });

    const [identity] = await db.select().from(agentIdentities).where(eq(agentIdentities.userId, userId));
    expect(identity?.revokedAt).toBeInstanceOf(Date);
    const [user] = await db.select({ tokenVersion: users.tokenVersion }).from(users).where(eq(users.id, userId));
    expect(user?.tokenVersion).toBe(2);
    expect((await verifyAgentSecret({ secret, now: new Date() })).decision).toEqual({ status: 'revoked' });
  });

  it("given a live agent with mcp_ keys, should revoke every one of them in the same transaction, and no one else's", async () => {
    const agent = await signUp(await issueChallenge());
    const other = await signUp(await issueChallenge());
    if (!agent.ok || !other.ok) throw new Error('signup failed');
    const keys = [await mintKeyRow(agent.data.userId), await mintKeyRow(agent.data.userId)];
    const otherKey = await mintKeyRow(other.data.userId);
    const now = new Date();

    await revokeAgent({ userId: agent.data.userId, now });

    for (const key of keys) expect(await keyRevokedAt(key)).toEqual(now);
    expect(await keyRevokedAt(otherKey)).toBeNull();
  });

  it('given an already revoked agent, should report revoked:false and not bump tokenVersion again', async () => {
    const result = await signUp(await issueChallenge());
    if (!result.ok) throw new Error('signup failed');
    await revokeAgent({ userId: result.data.userId, now: new Date() });

    expect(await revokeAgent({ userId: result.data.userId, now: new Date() })).toEqual({ revoked: false });
    const [user] = await db.select({ tokenVersion: users.tokenVersion }).from(users).where(eq(users.id, result.data.userId));
    expect(user?.tokenVersion).toBe(2);
  });
});

describe('getAgentIdentitySummary', () => {
  it('given an agent, should return its owner, claim time and source; given a human, null', async () => {
    const result = await signUp(await issueChallenge());
    if (!result.ok) throw new Error('signup failed');

    expect(await getAgentIdentitySummary(result.data.userId)).toEqual({ ownerUserId: null, claimedAt: null, source: 'claude-code' });
    expect(await getAgentIdentitySummary(createId())).toBeNull();
  });
});

describe('issueAgentSignupChallenge / findAgentSignupChallenge', () => {
  it('given an issued challenge, should store only its hash with the IP and difficulty, and find it by the plaintext', async () => {
    const now = new Date();
    const issued = await issueAgentSignupChallenge({ difficultyBits: 12, ttlMs: 5 * 60_000, issuedToIp: '198.51.100.20', now });
    const found = await findAgentSignupChallenge({ challenge: issued.challenge, now });
    expect(found).toMatchObject({ found: true, expired: false, consumed: false, difficultyBits: 12 });
    if (!found.found) return;
    createdChallengeIds.push(found.id);

    const [row] = await db.select().from(agentSignupChallenges).where(eq(agentSignupChallenges.id, found.id));
    expect(row?.challengeHash).toBe(hashToken(issued.challenge));
    expect(row?.issuedToIp).toBe('198.51.100.20');
    expect(JSON.stringify(row)).not.toContain(issued.challenge);
  });

  it('given a challenge at its expiry instant, should report it expired (the same boundary createAgentAccount consumes against)', async () => {
    const now = new Date();
    const issued = await issueAgentSignupChallenge({ difficultyBits: 12, ttlMs: 60_000, issuedToIp: null, now });
    const found = await findAgentSignupChallenge({ challenge: issued.challenge, now: issued.expiresAt });
    if (found.found) createdChallengeIds.push(found.id);
    expect(found).toMatchObject({ found: true, expired: true });
  });

  it('given an unknown challenge, should report not found', async () => {
    expect(await findAgentSignupChallenge({ challenge: `ps_pow_${createId()}`, now: new Date() })).toMatchObject({ found: false, id: null });
  });

  it('given expired challenges in the table, should prune them when issuing a new one, and keep live ones', async () => {
    const expiredId = await issueChallenge({ expiresAt: new Date(Date.now() - 60_000) });
    const liveId = await issueChallenge();

    await issueAgentSignupChallenge({ difficultyBits: 12, ttlMs: 5 * 60_000, issuedToIp: null, now: new Date() })
      .then(async (issued) => {
        const found = await findAgentSignupChallenge({ challenge: issued.challenge, now: new Date() });
        if (found.found) createdChallengeIds.push(found.id);
      });

    const remaining = await db.select({ id: agentSignupChallenges.id }).from(agentSignupChallenges)
      .where(inArray(agentSignupChallenges.id, [expiredId, liveId]));
    expect(remaining.map((r) => r.id)).toEqual([liveId]);
  });

  it('given a concurrent prune holding the oldest batch, should prune the NEXT batch instead of blocking or re-selecting it (SKIP LOCKED)', async () => {
    const base = Date.now() - 10 * 60_000;
    const rows = Array.from({ length: 200 }, (_, i) => ({
      challengeHash: hashToken(`skip-locked-${createId()}`),
      difficultyBits: 12,
      expiresAt: new Date(base + i * 1000),
    }));
    const inserted = await db.insert(agentSignupChallenges).values(rows).returning({ id: agentSignupChallenges.id, expiresAt: agentSignupChallenges.expiresAt });
    inserted.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
    const ids = inserted.map((r) => r.id);
    createdChallengeIds.push(...ids);
    // Other tests' expired rows may be older; lock whatever the prune would take first.
    const oldest = await db.select({ id: agentSignupChallenges.id }).from(agentSignupChallenges)
      .where(lt(agentSignupChallenges.expiresAt, new Date())).orderBy(agentSignupChallenges.expiresAt).limit(100);
    const lockedIds = oldest.map((r) => r.id);

    let pending: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      await tx.select({ id: agentSignupChallenges.id }).from(agentSignupChallenges)
        .where(inArray(agentSignupChallenges.id, lockedIds)).for('update');
      pending = issueAgentSignupChallenge({ difficultyBits: 12, ttlMs: 5 * 60_000, issuedToIp: null, now: new Date() })
        .then(async (issued) => {
          const found = await findAgentSignupChallenge({ challenge: issued.challenge, now: new Date() });
          if (found.found) createdChallengeIds.push(found.id);
        });
      const outcome = await Promise.race([
        pending.then(() => 'finished'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 3000)),
      ]);
      expect(outcome).toBe('finished');
    });
    await pending;

    const survivors = new Set((await db.select({ id: agentSignupChallenges.id }).from(agentSignupChallenges)
      .where(inArray(agentSignupChallenges.id, ids))).map((r) => r.id));
    // The locked batch survived; a further 100 expired rows were pruned past it.
    for (const id of lockedIds.filter((id) => ids.includes(id))) expect(survivors.has(id)).toBe(true);
    expect(ids.filter((id) => !survivors.has(id)).length).toBeGreaterThan(0);
    expect(ids.filter((id) => !lockedIds.includes(id) && survivors.has(id))).toEqual(ids.filter((id) => !lockedIds.includes(id)).slice(100));
  }, 15_000);
});
