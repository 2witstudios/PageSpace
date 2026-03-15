import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('deployment-mode', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe('isOnPrem', () => {
    it('should return true when NEXT_PUBLIC_DEPLOYMENT_MODE is onprem', async () => {
      vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_MODE', 'onprem');
      const { isOnPrem } = await import('../deployment-mode');
      expect(isOnPrem()).toBe(true);
      vi.unstubAllEnvs();
    });

    it('should return false when NEXT_PUBLIC_DEPLOYMENT_MODE is not onprem', async () => {
      vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_MODE', 'cloud');
      const { isOnPrem } = await import('../deployment-mode');
      expect(isOnPrem()).toBe(false);
      vi.unstubAllEnvs();
    });

    it('should return false when NEXT_PUBLIC_DEPLOYMENT_MODE is not set', async () => {
      vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_MODE', '');
      const { isOnPrem } = await import('../deployment-mode');
      expect(isOnPrem()).toBe(false);
      vi.unstubAllEnvs();
    });
  });

  describe('isCloud', () => {
    it('should return true when not on-prem', async () => {
      vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_MODE', 'cloud');
      const { isCloud } = await import('../deployment-mode');
      expect(isCloud()).toBe(true);
      vi.unstubAllEnvs();
    });

    it('should return false when on-prem', async () => {
      vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_MODE', 'onprem');
      const { isCloud } = await import('../deployment-mode');
      expect(isCloud()).toBe(false);
      vi.unstubAllEnvs();
    });
  });
});
