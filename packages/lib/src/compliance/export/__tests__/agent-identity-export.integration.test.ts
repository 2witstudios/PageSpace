/**
 * Agent Signup — the Art 15 collector for an agent's own identity row, against
 * a real database (ADR 0007; Codex review on #2652).
 *
 * The non-secret facts about the subject's agent account (its owner link, claim
 * time, self-reported source, last sign-in, revocation, secret version, creating
 * IP) are subject data and are exported under `agentIdentity`. The secret and
 * claim-token hashes and prefixes are credentials and must never reach the
 * bundle — this test serialises the WHOLE export and looks for them.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { agentIdentities } from '@pagespace/db/schema/agent-identities';
import { factories } from '@pagespace/db/test/factories';
import { collectUserAgentIdentity, collectAllUserData } from '../gdpr-export';
import { AGENT_IDENTITY_EXPORTED_COLUMNS } from '../gdpr-export-coverage';

const createdUsers: string[] = [];

afterAll(async () => {
  if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers)).catch(() => {});
});

async function seedAgent(ownerUserId: string | null) {
  const agent = await factories.createUser({ accountType: 'agent', emailVerified: null });
  createdUsers.push(agent.id);
  const secretHash = `sechash-${agent.id}`;
  const claimTokenHash = `claimhash-${agent.id}`;
  await db.insert(agentIdentities).values({
    userId: agent.id,
    secretHash,
    secretPrefix: 'ps_agent_pfx',
    secretVersion: 3,
    claimTokenHash,
    claimTokenPrefix: 'ps_claim_pfx',
    source: 'claude-code',
    ownerUserId,
    claimedAt: ownerUserId ? new Date('2026-09-16T12:00:00.000Z') : null,
    createdByIp: '203.0.113.7',
    lastAuthAt: new Date('2026-09-16T13:00:00.000Z'),
  });
  return { agent, secretHash, claimTokenHash };
}

describe('collectUserAgentIdentity (real Postgres)', () => {
  it("given an agent subject, should export exactly the carried columns of its own identity row", async () => {
    const owner = await factories.createUser();
    createdUsers.push(owner.id);
    const { agent } = await seedAgent(owner.id);

    const rows = await collectUserAgentIdentity(db, agent.id);

    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual([...AGENT_IDENTITY_EXPORTED_COLUMNS].sort());
    expect(rows[0]).toMatchObject({
      userId: agent.id,
      ownerUserId: owner.id,
      source: 'claude-code',
      secretVersion: 3,
      createdByIp: '203.0.113.7',
      revokedAt: null,
    });
    expect(rows[0]?.claimedAt?.toISOString()).toBe('2026-09-16T12:00:00.000Z');
  });

  it('given a human subject, should export an empty list (never null)', async () => {
    const human = await factories.createUser();
    createdUsers.push(human.id);
    expect(await collectUserAgentIdentity(db, human.id)).toEqual([]);
  });

  it('given the full export of an agent, should land under agentIdentity and contain no secret or claim-token hash or prefix anywhere', async () => {
    const { agent, secretHash, claimTokenHash } = await seedAgent(null);

    const all = await collectAllUserData(db, agent.id);
    const serialized = JSON.stringify(all);

    expect(all?.agentIdentity.map((r) => r.userId)).toEqual([agent.id]);
    for (const needle of [secretHash, claimTokenHash, 'ps_agent_pfx', 'ps_claim_pfx', 'secretHash', 'secretPrefix', 'claimTokenHash', 'claimTokenPrefix']) {
      expect(serialized, needle).not.toContain(needle);
    }
  });
});
