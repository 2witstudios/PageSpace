/**
 * Server-authored refusal copy reaches every client, the iOS app included, where
 * a purchase call to action is a Guideline 3.1.1 rejection. The copy says what
 * happened; each web surface adds its own buy/upgrade affordance beside it.
 */
import { describe, it, expect } from 'vitest';
import { creditGatePayload } from '../credit-gate-response';
import { createSubscriptionRequiredResponse } from '../rate-limit-middleware';
import { DEFAULT_ERROR_MESSAGES } from '@/lib/ai/shared/toErrorCause';

const PURCHASE_CTA = /\b(buy|purchase|upgrade|add credits)\b/i;

describe('refusal copy carries no purchase call to action', () => {
  it('given an exhausted credit balance, should not tell the user to buy or upgrade', () => {
    expect(creditGatePayload('out_of_credits').message).not.toMatch(PURCHASE_CTA);
  });

  it('given an uninitialized balance, should not tell the user to buy or upgrade', () => {
    expect(creditGatePayload('needs_init').message).not.toMatch(PURCHASE_CTA);
  });

  it('given a paid-only model, should not tell the user to upgrade', async () => {
    const body = await createSubscriptionRequiredResponse().json();
    expect(body.message).not.toMatch(PURCHASE_CTA);
  });

  it('given the client default for out_of_credits, should not tell the user to buy', () => {
    expect(DEFAULT_ERROR_MESSAGES.out_of_credits).not.toMatch(PURCHASE_CTA);
  });
});
