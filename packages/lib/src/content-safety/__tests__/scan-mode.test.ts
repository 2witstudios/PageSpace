import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCAN_TIMEOUT_MS, resolveScanConfig, resolveScanConfigFromEnv } from '../scan-mode';

const cloud = { onPrem: false };

describe('resolveScanConfig', () => {
  it('defaults to off with no problems', () => {
    const config = resolveScanConfig({}, cloud);
    expect(config.mode).toBe('off');
    expect(config.problems).toEqual([]);
    expect(config.scannerConfigured).toBe(false);
  });

  it('reads shadow and enforce, case-insensitively', () => {
    expect(resolveScanConfig({ CONTENT_SCAN_MODE: 'shadow', HIVE_API_KEY: 'k' }, cloud).mode).toBe('shadow');
    expect(resolveScanConfig({ CONTENT_SCAN_MODE: ' ENFORCE ', HIVE_API_KEY: 'k' }, cloud).mode).toBe('enforce');
  });

  it('on-prem is always off, even when enforce and a key are set', () => {
    const config = resolveScanConfig({ CONTENT_SCAN_MODE: 'enforce', HIVE_API_KEY: 'k' }, { onPrem: true });
    expect(config).toMatchObject({ mode: 'off', scannerConfigured: false, problems: [] });
  });

  it('enforce with no key is a reported problem and no scanner (the gate fails closed)', () => {
    const config = resolveScanConfig({ CONTENT_SCAN_MODE: 'enforce', HIVE_API_KEY: '  ' }, cloud);
    expect(config).toMatchObject({ mode: 'enforce', scannerConfigured: false, problems: ['missing_key'] });
  });

  it('treats an unrecognised mode as enforce, not off', () => {
    const config = resolveScanConfig({ CONTENT_SCAN_MODE: 'enforced', HIVE_API_KEY: 'k' }, cloud);
    expect(config.mode).toBe('enforce');
    expect(config.problems).toContain('invalid_mode');
  });

  it('reads TTL, timeout, size limit and threshold, ignoring junk', () => {
    const config = resolveScanConfig(
      { CONTENT_SCAN_VERDICT_TTL_DAYS: '7', CONTENT_SCAN_TIMEOUT_MS: 'abc', CONTENT_SCAN_MAX_BYTES: '1000', CONTENT_SCAN_FLAG_THRESHOLD: '5' },
      cloud,
    );
    expect(config.verdictTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(config.timeoutMs).toBe(DEFAULT_SCAN_TIMEOUT_MS);
    expect(config.maxBytes).toBe(1000);
    expect(config.flagThreshold).toBe(1);
  });
});

describe('resolveScanConfigFromEnv', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses isOnPrem(): onprem forces off', () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'onprem');
    expect(resolveScanConfigFromEnv({ CONTENT_SCAN_MODE: 'enforce', HIVE_API_KEY: 'k' }).mode).toBe('off');
  });

  it('tenant behaves like cloud', () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'tenant');
    expect(resolveScanConfigFromEnv({ CONTENT_SCAN_MODE: 'enforce', HIVE_API_KEY: 'k' }).mode).toBe('enforce');
  });
});
