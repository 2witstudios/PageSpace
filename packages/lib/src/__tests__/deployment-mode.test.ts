import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('deployment-mode', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Dynamic import to pick up env changes per test
  async function loadModule() {
    vi.resetModules();
    return import('../deployment-mode');
  }

  describe('isTenantMode', () => {
    it('given DEPLOYMENT_MODE=tenant, should return true', async () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'tenant');
      const { isTenantMode } = await loadModule();
      expect(isTenantMode()).toBe(true);
    });

    it('given DEPLOYMENT_MODE=cloud, should return false', async () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      const { isTenantMode } = await loadModule();
      expect(isTenantMode()).toBe(false);
    });

    it('given DEPLOYMENT_MODE=onprem, should return false', async () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'onprem');
      const { isTenantMode } = await loadModule();
      expect(isTenantMode()).toBe(false);
    });

    it('given DEPLOYMENT_MODE is unset, should return false', async () => {
      vi.stubEnv('DEPLOYMENT_MODE', '');
      const { isTenantMode } = await loadModule();
      expect(isTenantMode()).toBe(false);
    });
  });

  describe('isCloud', () => {
    it('given DEPLOYMENT_MODE=tenant, should return false', async () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'tenant');
      const { isCloud } = await loadModule();
      expect(isCloud()).toBe(false);
    });

    it('given DEPLOYMENT_MODE=cloud, should return true', async () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      const { isCloud } = await loadModule();
      expect(isCloud()).toBe(true);
    });

    it('given DEPLOYMENT_MODE unset, should return true', async () => {
      vi.stubEnv('DEPLOYMENT_MODE', '');
      const { isCloud } = await loadModule();
      expect(isCloud()).toBe(true);
    });
  });

  describe('isOnPrem', () => {
    it('given DEPLOYMENT_MODE=onprem, should return true', async () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'onprem');
      const { isOnPrem } = await loadModule();
      expect(isOnPrem()).toBe(true);
    });

    it('given DEPLOYMENT_MODE=tenant, should return false', async () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'tenant');
      const { isOnPrem } = await loadModule();
      expect(isOnPrem()).toBe(false);
    });

    it('given DEPLOYMENT_MODE=cloud, should return false', async () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      const { isOnPrem } = await loadModule();
      expect(isOnPrem()).toBe(false);
    });

    it('given DEPLOYMENT_MODE is unset, should return false', async () => {
      vi.stubEnv('DEPLOYMENT_MODE', '');
      const { isOnPrem } = await loadModule();
      expect(isOnPrem()).toBe(false);
    });
  });

  describe('isBillingEnabled', () => {
    it('given DEPLOYMENT_MODE=tenant, should return false', async () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'tenant');
      const { isBillingEnabled } = await loadModule();
      expect(isBillingEnabled()).toBe(false);
    });

    it('given DEPLOYMENT_MODE=cloud, should return true', async () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
      const { isBillingEnabled } = await loadModule();
      expect(isBillingEnabled()).toBe(true);
    });

    it('given DEPLOYMENT_MODE=onprem, should return false', async () => {
      vi.stubEnv('DEPLOYMENT_MODE', 'onprem');
      const { isBillingEnabled } = await loadModule();
      expect(isBillingEnabled()).toBe(false);
    });
  });
});
