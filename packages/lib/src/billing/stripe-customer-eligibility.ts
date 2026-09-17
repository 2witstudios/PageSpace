/**
 * stripe-customer-eligibility — an agent never holds its own Stripe customer
 * (ADR 0007 Decision 8). Its AI spend bills its owner once claimed, and its
 * synthetic reserved-domain address could never receive an invoice.
 *
 * Asserted inside BOTH `getOrCreateStripeCustomer` copies (web and admin) and
 * the two routes that create a customer directly, so every path that could
 * mint a customer — subscriptions, credit top-ups, dedicated app hosting, admin
 * gifts, billing address — refuses an agent before any Stripe call.
 *
 * Pure: the account row is the input.
 *
 * @module @pagespace/lib/billing/stripe-customer-eligibility
 */

import type { AccountType } from '../auth/agent/account-type';

export const AGENT_STRIPE_CUSTOMER_REFUSAL = 'Agent accounts are billed through their owner';

export class AgentStripeCustomerRefusedError extends Error {
  readonly userId: string;

  constructor(userId: string) {
    super(AGENT_STRIPE_CUSTOMER_REFUSAL);
    this.name = 'AgentStripeCustomerRefusedError';
    this.userId = userId;
  }
}

export function assertMayHoldStripeCustomer(user: { id: string; accountType: AccountType }): void {
  if (user.accountType === 'agent') throw new AgentStripeCustomerRefusedError(user.id);
}
