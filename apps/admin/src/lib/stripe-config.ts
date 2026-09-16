/**
 * Stripe configuration with hardcoded public keys and price IDs.
 *
 * These values are intentionally hardcoded because:
 * 1. They're public values (visible in client bundle anyway)
 * 2. Next.js NEXT_PUBLIC_* vars require build-time inlining
 * 3. Hardcoding avoids complex Docker build arg pipelines
 *
 * To switch to production: update the 'live' config values and
 * set NODE_ENV=production in your deployment.
 */

interface StripeConfig {
  publishableKey: string;
  /** Prices a plan UI may sell today, keyed by canonical tier (SEAT-2). */
  priceIds: {
    pro: string;
    /**
     * Business is the $50 organization plan (SEAT-2). The $50 Business and
     * extra-seat prices are created in Wave C (D1); until then this is the
     * legacy $100 personal Business price, which is what existing
     * (grandfathered, A-9) Business subscribers are still billed on. When the
     * $50 price replaces it here, move this id into `grandfatheredPriceIds`.
     */
    business: string;
  };
  /**
   * Prices that are no longer sold but still resolve for the subscribers on
   * them (A-9). Never a member of TIERS — a removed tier's price lives here.
   * `founder` ($50/month) resolves to its migration target, Pro, until the
   * subscription is moved to Pro at period end by a manual Stripe dashboard
   * step ([D-OW-19]). `legacyBusiness` is the $100/month personal Business
   * price whose subscribers are grandfathered (A-9) — today the same id as
   * `priceIds.business`, which becomes the $50 org price in Wave C.
   */
  grandfatheredPriceIds: {
    founder: string;
    legacyBusiness: string;
  };
}

const config: Record<'test' | 'live', StripeConfig> = {
  test: {
    publishableKey: 'pk_test_51S2LlZPCGvbSozobCg5nWBQeS8xHHYQqsbLZxAjzWnTL2o2BSSRtafSH36n4iaKe52Mmj2dGk2ybJtN5yLN6QCjX00JFh3a7MY',
    priceIds: {
      pro: 'price_1Sdbh6PCGvbSozob1IBfmSuv',        // $15/month
      business: 'price_1SdbhfPCGvbSozobpTMXfqkX',   // legacy $100/month personal Business (see StripeConfig)
    },
    grandfatheredPriceIds: {
      founder: 'price_1SdbhePCGvbSozobuNjSn5j0',    // $50/month, removed tier (A-9)
      legacyBusiness: 'price_1SdbhfPCGvbSozobpTMXfqkX', // $100/month personal Business, grandfathered (A-9)
    },
  },
  live: {
    publishableKey: 'pk_live_51S2LlQPRnBcvXFso7Y3yM21QcIuHM3b6Iz1VdOZ7d51aVaZvITRSs7M5KVpKF3jih2p2t59xwlR4Jr8DwIydW9Ht00KeOaUd35',
    priceIds: {
      pro: 'price_1SdfbXPRnBcvXFsoRbjnaQFS',        // $15/month
      business: 'price_1SdfbePRnBcvXFsoCvpJsSxw',   // legacy $100/month personal Business (see StripeConfig)
    },
    grandfatheredPriceIds: {
      founder: 'price_1SdfbbPRnBcvXFsofn7L1leP',    // $50/month, removed tier (A-9)
      legacyBusiness: 'price_1SdfbePRnBcvXFsoCvpJsSxw', // $100/month personal Business, grandfathered (A-9)
    },
  },
};

// Determine which config to use:
// 1. If STRIPE_MODE is explicitly set, use that
// 2. Otherwise, use 'live' only if NODE_ENV=production AND live keys are configured
// 3. Default to 'test'
function getStripeMode(): 'test' | 'live' {
  const explicitMode = process.env.NEXT_PUBLIC_STRIPE_MODE as 'test' | 'live' | undefined;
  if (explicitMode === 'test' || explicitMode === 'live') {
    return explicitMode;
  }

  // Auto-detect: use live only if in production AND live keys are configured
  if (process.env.NODE_ENV === 'production' && config.live.publishableKey !== '') {
    return 'live';
  }

  return 'test';
}

export const stripeMode = getStripeMode();
export const stripeConfig = config[stripeMode];
