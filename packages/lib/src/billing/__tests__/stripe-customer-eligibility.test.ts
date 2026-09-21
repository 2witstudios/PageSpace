/**
 * ADR 0007 Decision 8: an agent never holds its own Stripe customer — its AI
 * spend bills its owner once claimed, and its synthetic reserved-domain address
 * could never receive an invoice. Pure.
 */
import { describe, it, expect } from 'vitest';
import {
  assertMayHoldStripeCustomer,
  AgentStripeCustomerRefusedError,
  AGENT_STRIPE_CUSTOMER_REFUSAL,
} from '../stripe-customer-eligibility';

describe('assertMayHoldStripeCustomer', () => {
  it('given a human, should not throw', () => {
    expect(() => assertMayHoldStripeCustomer({ id: 'u1', accountType: 'human' })).not.toThrow();
  });

  it('given an agent, should throw the typed refusal naming the user', () => {
    let caught: unknown;
    try {
      assertMayHoldStripeCustomer({ id: 'agent-1', accountType: 'agent' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentStripeCustomerRefusedError);
    expect(caught).toMatchObject({ userId: 'agent-1', message: AGENT_STRIPE_CUSTOMER_REFUSAL });
  });

  it('given a claimed agent, should still refuse (the owner is the Stripe customer)', () => {
    expect(() => assertMayHoldStripeCustomer({ id: 'agent-2', accountType: 'agent' })).toThrow(
      AgentStripeCustomerRefusedError,
    );
  });
});
