/**
 * ADR 0005 Decision 8 — owner pays. The ONE seam that names who pays for an
 * agent's AI spend; Phase 4 wires it at canConsumeAI / consumeCredits /
 * releaseHold and injects the DB lookup. Pure here.
 */
import { describe, it, expect } from 'vitest';
import { resolveBillingPayer } from '../agent-payer';

describe('resolveBillingPayer', () => {
  it('names the owner when the agent has one, and says so', () => {
    expect(resolveBillingPayer({ userId: 'agent-1', ownerUserId: 'human-1' })).toEqual({
      payerId: 'human-1',
      viaAgentOwner: true,
    });
  });

  it('names the user itself when there is no owner (a human, or an unclaimed agent)', () => {
    expect(resolveBillingPayer({ userId: 'user-1', ownerUserId: null })).toEqual({
      payerId: 'user-1',
      viaAgentOwner: false,
    });
  });

  it('treats an empty-string owner as no owner (fail toward the user, never an empty payer id)', () => {
    expect(resolveBillingPayer({ userId: 'agent-1', ownerUserId: '' })).toEqual({
      payerId: 'agent-1',
      viaAgentOwner: false,
    });
  });

  it('an owner equal to the user itself is not a delegation', () => {
    expect(resolveBillingPayer({ userId: 'u', ownerUserId: 'u' })).toEqual({ payerId: 'u', viaAgentOwner: false });
  });
});
