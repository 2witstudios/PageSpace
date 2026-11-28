/**
 * Settings → Agents, the owner's side (Agent Signup Phase 4; ADR 0008
 * Decisions 8, 14) — against a REAL Postgres.
 *
 * listOwnedAgents shows only the caller's agents with name, source and last
 * activity; unlinkAgent releases an agent only for its owner, returns it to the
 * unclaimed state (no owner, emailVerified cleared per D-31) and hands back a
 * fresh claim token so it can be claimed again; revoking (the existing
 * revokeAgent) kills every live token and key.
 *
 * Excluded from the unit run (vitest.config.ts); CI's lib integration step
 * picks it up by glob.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { agentIdentities } from '@pagespace/db/schema/agent-identities';
import { oauthAccessTokens, oauthClients } from '@pagespace/db/schema/oauth';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { hashToken } from '../../auth/token-utils';
import { listOwnedAgents, unlinkAgent } from '../agent-ownership';

let dbAvailable = false;
const createdUserIds: string[] = [];

beforeAll(async () => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('agent-ownership.integration.test.ts', error);
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (!dbAvailable || createdUserIds.length === 0) return;
  await db.delete(users).where(inArray(users.id, createdUserIds));
});

async function seedHuman(name: string) {
  const user = await factories.createUser({ name, accountType: 'human' });
  createdUserIds.push(user.id);
  return user.id;
}

async function seedAgent(name: string, ownerUserId: string | null, extra: { source?: string; lastAuthAt?: Date } = {}) {
  const agent = await factories.createUser({ name, accountType: 'agent', emailVerified: ownerUserId ? new Date() : null });
  createdUserIds.push(agent.id);
  await db.insert(agentIdentities).values({
    userId: agent.id,
    secretHash: `test-hash-${agent.id}`,
    secretPrefix: 'ps_agent_tst',
    ownerUserId,
    claimedAt: ownerUserId ? new Date() : null,
    source: extra.source ?? null,
    lastAuthAt: extra.lastAuthAt ?? null,
  });
  return agent.id;
}

describe('agent ownership — real Postgres', () => {
  it("lists only the caller's agents, with name, source and last activity (latest of sign-in and token issuance)", async () => {
    if (!dbAvailable) return;
    const owner = await seedHuman('Olive');
    const other = await seedHuman('Oscar');
    const signedIn = new Date('2026-10-01T00:00:00Z');
    const mine = await seedAgent('Mine', owner, { source: 'codex', lastAuthAt: signedIn });
    await seedAgent('Theirs', other);
    await seedAgent('Unclaimed', null);

    // A later access token is later activity than the last sign-in.
    await db.insert(oauthClients)
      .values({ clientId: 'pagespace-agent', name: 'PageSpace Agent', clientType: 'public', redirectUris: [], isFirstParty: false })
      .onConflictDoNothing({ target: oauthClients.clientId });
    const [client] = await db.select({ id: oauthClients.id }).from(oauthClients).where(eq(oauthClients.clientId, 'pagespace-agent')).limit(1);
    if (!client) throw new Error('pagespace-agent oauth client row missing');
    const tokenAt = new Date('2026-11-01T00:00:00Z');
    {
      await db.insert(oauthAccessTokens).values({
        tokenHash: hashToken(`ps_at_ownership_${mine}`),
        tokenPrefix: 'ps_at_owner',
        familyId: `family-${mine}`,
        clientId: client.id,
        userId: mine,
        scopes: ['account'],
        tokenVersion: 1,
        expiresAt: new Date(tokenAt.getTime() + 900_000),
        createdAt: tokenAt,
      });
    }

    const listed = await listOwnedAgents(owner);
    expect(listed.map((a) => a.agentUserId)).toEqual([mine]);
    expect(listed[0]).toMatchObject({ name: 'Mine', source: 'codex', revokedAt: null });
    expect(listed[0].lastActiveAt?.toISOString()).toBe(tokenAt.toISOString());
  });

  it('unlinks only for the owner: no owner, emailVerified cleared, and a fresh claim token that starts a new claim', async () => {
    if (!dbAvailable) return;
    const owner = await seedHuman('Uma');
    const stranger = await seedHuman('Stan');
    const agent = await seedAgent('Leaving', owner);

    expect(await unlinkAgent({ ownerUserId: stranger, agentUserId: agent, now: new Date() })).toEqual({ ok: false });
    const [still] = await db.select({ ownerUserId: agentIdentities.ownerUserId }).from(agentIdentities).where(eq(agentIdentities.userId, agent));
    expect(still.ownerUserId).toBe(owner);

    const unlinked = await unlinkAgent({ ownerUserId: owner, agentUserId: agent, now: new Date() });
    expect(unlinked.ok).toBe(true);
    if (!unlinked.ok) return;
    expect(unlinked.claimToken.startsWith('ps_claim_')).toBe(true);

    const [row] = await db
      .select({ ownerUserId: agentIdentities.ownerUserId, claimedAt: agentIdentities.claimedAt, claimTokenHash: agentIdentities.claimTokenHash, emailVerified: users.emailVerified })
      .from(agentIdentities)
      .innerJoin(users, eq(users.id, agentIdentities.userId))
      .where(eq(agentIdentities.userId, agent));
    expect(row).toEqual({ ownerUserId: null, claimedAt: null, claimTokenHash: hashToken(unlinked.claimToken), emailVerified: null });
    expect(await listOwnedAgents(owner)).toEqual([]);

    // A second unlink is not the owner's any more.
    expect(await unlinkAgent({ ownerUserId: owner, agentUserId: agent, now: new Date() })).toEqual({ ok: false });
  });
});
