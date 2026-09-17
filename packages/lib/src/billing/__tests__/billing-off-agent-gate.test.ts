/**
 * ADR 0007 Decision 9 in billing-off deployments (tenant, onprem): agents get
 * no free AI. With prepaid billing off, `canConsumeAI` otherwise answers
 * `unlimited` for everyone, which would hand every signed-up agent unlimited AI
 * paid for by the customer. An unclaimed agent is refused; a claimed agent is
 * unlimited like its owner; a human is untouched. Pure.
 */
import { describe, it, expect } from 'vitest';
import { billingOffAgentGate } from '../billing-off-agent-gate';

describe('billingOffAgentGate', () => {
  it('given an unclaimed agent, should require funding', () => {
    expect(billingOffAgentGate({ accountType: 'agent', hasOwner: false })).toBe('requires_funding');
  });

  it('given a claimed agent, should allow (unlimited like its owner)', () => {
    expect(billingOffAgentGate({ accountType: 'agent', hasOwner: true })).toBe('allow');
  });

  it('given a human, should allow regardless of the owner flag', () => {
    expect(billingOffAgentGate({ accountType: 'human', hasOwner: false })).toBe('allow');
    expect(billingOffAgentGate({ accountType: 'human', hasOwner: true })).toBe('allow');
  });
});
