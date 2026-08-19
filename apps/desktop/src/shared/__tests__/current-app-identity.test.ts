import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The selector's whole contract is that `__APP_VARIANT__` is absent outside an
 * electron-vite bundle, so `PAGESPACE_APP_VARIANT` decides. If that fallback
 * ever broke, every identity-dependent test below would silently assert against
 * PageSpace regardless of the variant it thought it was exercising.
 */
describe('APP_IDENTITY selection', () => {
  const original = process.env.PAGESPACE_APP_VARIANT;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.PAGESPACE_APP_VARIANT;
    else process.env.PAGESPACE_APP_VARIANT = original;
  });

  it('is PageSpace when neither the define nor the env var is set', async () => {
    delete process.env.PAGESPACE_APP_VARIANT;
    const { APP_IDENTITY } = await import('../current-app-identity');
    expect(APP_IDENTITY.variant).toBe('pagespace');
    expect(APP_IDENTITY.startPath).toBe('/dashboard');
  });

  it('is the coder app when PAGESPACE_APP_VARIANT selects it', async () => {
    process.env.PAGESPACE_APP_VARIANT = 'coder';
    const { APP_IDENTITY } = await import('../current-app-identity');
    expect(APP_IDENTITY.variant).toBe('coder');
    expect(APP_IDENTITY.startPath).toBe('/dashboard/agents');
    expect(APP_IDENTITY.deepLinkPrefix).toBe('pagespace-coder://');
  });

  it('falls back to PageSpace for an unrecognized variant', async () => {
    process.env.PAGESPACE_APP_VARIANT = 'nonsense';
    const { APP_IDENTITY } = await import('../current-app-identity');
    expect(APP_IDENTITY.variant).toBe('pagespace');
  });
});
