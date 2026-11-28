import { describe, it, expect, vi } from 'vitest';

// Billing on: the pro-model gate is live (it is off on onprem/tenant).
vi.mock('@pagespace/lib/deployment-mode', () => ({ isBillingEnabled: () => true }));

import { decideCallSpend, walletLeg, ORG_ENTITLEMENT_TIER, type CallSpendInput } from '@pagespace/lib/billing/spend-target';
import { requiresProSubscription } from '@/lib/subscription/rate-limit-middleware';
import { FREE_TIER_MODELS } from '../ai-providers-config';
import { resolveGenerationAdmission } from '../generation-admission';

// A catalog model outside the free allowlist: only a paid tier may run it.
const PRO_MODEL = 'anthropic/claude-sonnet-5';

// Marcus Oyelaran (Northwind fixture) is on the free tier and a member of Product, an org drive.
const marcusInProduct = (chosen: CallSpendInput['chosen']): CallSpendInput => ({
  actor: { kind: 'person', userId: 'u-marcus', isGuest: false },
  driveWallet: walletLeg('w-product', 'active', 120_000),
  seatAllowance: walletLeg('w-northwind-pool', 'active', 900_000),
  personal: walletLeg('w-marcus', 'active', 5_000),
  driveRule: { fallback: 'refuse', guestsMaySpendDriveWallet: false },
  chosen,
  userOverride: { alwaysOwnCredits: false, alwaysOwnCreditsInDrive: false },
  reservationCents: 25,
  walletOwnerTier: ORG_ENTITLEMENT_TIER,
  consumerTier: 'free',
});

/** The admission a chat turn applies, fed the tier the resolved wallet carries (WAL-8). */
function admissionFor(chosen: CallSpendInput['chosen']) {
  const decision = decideCallSpend(marcusInProduct(chosen));
  if (decision.kind !== 'spend') throw new Error(`expected a spend, got ${decision.kind}`);
  return resolveGenerationAdmission({
    provider: 'openrouter',
    model: PRO_MODEL,
    subscriptionTier: decision.entitlementTier,
    isAdmin: false,
    requiresProSubscription,
  });
}

describe('the pro-model gate follows the wallet that pays', () => {
  it('the model under test is a paid-tier model', () => {
    expect(FREE_TIER_MODELS.has(PRO_MODEL)).toBe(false);
    expect(requiresProSubscription('openrouter', PRO_MODEL, 'free')).toBe(true);
  });

  it('WAL-8 (partial) a free-tier member spending the org drive wallet may run a paid-tier model', () => {
    expect(admissionFor('drive_wallet')).toEqual({ allowed: true });
  });

  it('WAL-8 (partial) a free-tier member on their seat on the org pool may run a paid-tier model', () => {
    expect(admissionFor('seat_allowance')).toEqual({ allowed: true });
  });

  it('WAL-8 (partial) the same member on their own credits is refused the paid-tier model', () => {
    expect(admissionFor('own_credits')).toEqual({ allowed: false, reason: 'subscription_required' });
  });
});
