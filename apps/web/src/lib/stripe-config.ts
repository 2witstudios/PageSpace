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
  priceIds: {
    pro: string;
    founder: string;
    business: string;
  };
}

const config: Record<'test' | 'live', StripeConfig> = {
  test: {
    publishableKey: 'pk_test_51S2LlZPCGvbSozobCg5nWBQeS8xHHYQqsbLZxAjzWnTL2o2BSSRtafSH36n4iaKe52Mmj2dGk2ybJtN5yLN6QCjX00JFh3a7MY',
    priceIds: {
      pro: 'price_1Sdbh6PCGvbSozob1IBfmSuv',        // $15/month
      founder: 'price_1SdbhePCGvbSozobuNjSn5j0',    // $50/month
      business: 'price_1SdbhfPCGvbSozobpTMXfqkX',   // $100/month
    },
  },
  live: {
    // TODO: Add production keys when ready to go live
    publishableKey: '',
    priceIds: {
      pro: '',
      founder: '',
      business: '',
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
