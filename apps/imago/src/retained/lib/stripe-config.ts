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
  /** Separate portals disable plan and quantity changes; seats are application-controlled. */
  portalConfigurationIds: { personal: string; organization: string };
  /** The only purchasable personal plan (SEAT-2, A-9). */
  priceIds: { pro: string };
  /**
   * The ORGANIZATION plan's two prices (SEAT-2, A-8): the Business base (its
   * included seats) and the extra seat (per seat beyond them), billed as two
   * items of one org subscription; the amounts and seat count are the tier
   * table's (TIER_PLAN_LIMITS.business), never restated here. Ids only — every money
   * amount the product shows or grants comes from the money-model module and
   * the tier table, never from these prices (MON-5). An empty id means the
   * price does not exist in that mode yet, and org provisioning refuses to run
   * (fails closed) rather than guess.
   */
  orgPriceIds: {
    businessBase: string;
    extraSeat: string;
  };
}

const config: Record<'test' | 'live', StripeConfig> = {
  test: {
    portalConfigurationIds: {
      personal: 'bpc_1UQXAxPRnBcvXFsoYbIcbPsB',
      organization: 'bpc_1UQXAyPRnBcvXFsoHhQmOeSG',
    },
    publishableKey: 'pk_test_51S2LlQPRnBcvXFsoJEzuFyfXe7ou1YYb4F6yjL9wy5NrIXNMd0Gnya0byLpJ5ECObEAc3mr58UEG616WhktweYJL00BrhA3oVf',
    priceIds: {
      pro: 'price_1UQXAuPRnBcvXFsoA3uYJyHL',        // $15/month
    },
    orgPriceIds: {
      businessBase: 'price_1UQXAvPRnBcvXFsoeKQE6H0u', // org base (D-OW-20)
      extraSeat: 'price_1UQXAwPRnBcvXFso1TqKRFSM',    // per extra seat (D-OW-20)
    },
  },
  live: {
    portalConfigurationIds: {
      personal: 'bpc_1UQXAzPRnBcvXFsoKdnU1dUr',
      organization: 'bpc_1UQXAzPRnBcvXFsoGwqBbnSf',
    },
    publishableKey: 'pk_live_51S2LlQPRnBcvXFso7Y3yM21QcIuHM3b6Iz1VdOZ7d51aVaZvITRSs7M5KVpKF3jih2p2t59xwlR4Jr8DwIydW9Ht00KeOaUd35',
    priceIds: {
      pro: 'price_1SdfbXPRnBcvXFsoRbjnaQFS',        // $15/month
    },
    // Staged inactive in Stripe; activate during the coordinated billing cutover.
    orgPriceIds: {
      businessBase: 'price_1UQUXPPRnBcvXFsoIu4Bcxt3',
      extraSeat: 'price_1UQUXiPRnBcvXFso0992O0dz',
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
