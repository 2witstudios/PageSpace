import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to test the IIFE in constants.ts which runs at import time.
// Each test re-imports the module with different env/mock conditions.

describe('auth/constants', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.SESSION_IDLE_TIMEOUT_MS;
    delete process.env.DEPLOYMENT_MODE;
  });

  it('should export SESSION_DURATION_MS as 7 days', async () => {
    const { SESSION_DURATION_MS } = await import('../constants');
    expect(SESSION_DURATION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('should export BCRYPT_COST as 12', async () => {
    const { BCRYPT_COST } = await import('../constants');
    expect(BCRYPT_COST).toBe(12);
  });

  it('should return 0 for IDLE_TIMEOUT_MS in cloud mode (default)', async () => {
    delete process.env.DEPLOYMENT_MODE;
    delete process.env.SESSION_IDLE_TIMEOUT_MS;
    const { IDLE_TIMEOUT_MS } = await import('../constants');
    expect(IDLE_TIMEOUT_MS).toBe(0);
  });

  it('should return 15 minutes for IDLE_TIMEOUT_MS in on-prem mode', async () => {
    process.env.DEPLOYMENT_MODE = 'onprem';
    delete process.env.SESSION_IDLE_TIMEOUT_MS;
    const { IDLE_TIMEOUT_MS } = await import('../constants');
    expect(IDLE_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });

  it('should use SESSION_IDLE_TIMEOUT_MS env var when set to valid number', async () => {
    process.env.SESSION_IDLE_TIMEOUT_MS = '30000';
    const { IDLE_TIMEOUT_MS } = await import('../constants');
    expect(IDLE_TIMEOUT_MS).toBe(30000);
  });

  it('should use SESSION_IDLE_TIMEOUT_MS of 0 to disable idle timeout', async () => {
    process.env.SESSION_IDLE_TIMEOUT_MS = '0';
    const { IDLE_TIMEOUT_MS } = await import('../constants');
    expect(IDLE_TIMEOUT_MS).toBe(0);
  });

  it('should fall back to default when SESSION_IDLE_TIMEOUT_MS is invalid (NaN)', async () => {
    process.env.SESSION_IDLE_TIMEOUT_MS = 'notanumber';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { IDLE_TIMEOUT_MS } = await import('../constants');
    // Cloud default is 0
    expect(IDLE_TIMEOUT_MS).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid SESSION_IDLE_TIMEOUT_MS')
    );
    warnSpy.mockRestore();
  });

  it('should fall back to default when SESSION_IDLE_TIMEOUT_MS is negative', async () => {
    process.env.SESSION_IDLE_TIMEOUT_MS = '-1000';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { IDLE_TIMEOUT_MS } = await import('../constants');
    expect(IDLE_TIMEOUT_MS).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid SESSION_IDLE_TIMEOUT_MS')
    );
    warnSpy.mockRestore();
  });
});
