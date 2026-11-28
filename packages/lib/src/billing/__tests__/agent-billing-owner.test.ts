/**
 * resolveOwnCreditsPayer — whose OWN CREDITS a call spends (ADR 0008 Decision 8,
 * Agent Signup Phase 4): the caller's, or, for a claimed agent, its owner's at
 * the owner's tier. The lookup is injected so the composition with the frozen
 * resolveBillingPayer is tested on plain values; the real lookup is covered by
 * agent-owner-pays.integration.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/operators', () => ({ and: vi.fn(), eq: vi.fn(), isNull: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));
vi.mock('@pagespace/db/schema/agent-identities', () => ({ agentIdentities: {} }));

import { resolveOwnCreditsPayer, type LookupAgentBillingOwner } from '../agent-billing-owner';

const noOwner: LookupAgentBillingOwner = async () => null;

describe('resolveOwnCreditsPayer', () => {
  it('given a principal with no owner (a human, or an unclaimed agent), should pay as itself at its own tier', async () => {
    expect(await resolveOwnCreditsPayer({ userId: 'u1', tier: 'free', lookup: noOwner })).toEqual({
      payerId: 'u1',
      tier: 'free',
      viaAgentOwner: false,
    });
  });

  it("given a claimed agent, should name the owner as payer at the OWNER's tier", async () => {
    const lookup: LookupAgentBillingOwner = async (id) => (id === 'agent-1' ? { ownerUserId: 'human-1', ownerTier: 'pro' } : null);
    expect(await resolveOwnCreditsPayer({ userId: 'agent-1', tier: 'free', lookup })).toEqual({
      payerId: 'human-1',
      tier: 'pro',
      viaAgentOwner: true,
    });
  });

  it('given an owner row whose tier is not a personal tier, should normalise it the way the gate callers do (free)', async () => {
    const lookup: LookupAgentBillingOwner = async () => ({ ownerUserId: 'human-1', ownerTier: 'something-else' });
    expect(await resolveOwnCreditsPayer({ userId: 'agent-1', tier: 'pro', lookup })).toEqual({
      payerId: 'human-1',
      tier: 'free',
      viaAgentOwner: true,
    });
  });

  it('given an owner equal to the principal itself, should not treat it as paid for by someone else', async () => {
    const lookup: LookupAgentBillingOwner = async () => ({ ownerUserId: 'agent-1', ownerTier: 'pro' });
    expect(await resolveOwnCreditsPayer({ userId: 'agent-1', tier: 'free', lookup })).toEqual({
      payerId: 'agent-1',
      tier: 'free',
      viaAgentOwner: false,
    });
  });
});
