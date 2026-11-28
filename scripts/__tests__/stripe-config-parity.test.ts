import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); });

it.each(['test', 'live'] as const)('web, admin and Imago use the same %s account/catalog and separate portal identities', async mode => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_STRIPE_MODE', mode);
  const apps = await Promise.all([
    import('../../apps/web/src/lib/stripe-config'),
    import('../../apps/admin/src/lib/stripe-config'),
    import('../../apps/imago/src/retained/lib/stripe-config'),
  ]);
  for (const app of apps) {
    expect(app.stripeMode).toBe(mode);
    expect(app.stripeConfig).toEqual(apps[0].stripeConfig);
    expect(app.stripeConfig.publishableKey).toMatch(new RegExp(`^pk_${mode}_51S2LlQPRnBcvXFso`));
    expect(app.stripeConfig.portalConfigurationIds.personal).not.toBe(app.stripeConfig.portalConfigurationIds.organization);
    expect(app.stripeConfig.priceIds.pro).not.toBe(app.stripeConfig.orgPriceIds.businessBase);
  }
});
