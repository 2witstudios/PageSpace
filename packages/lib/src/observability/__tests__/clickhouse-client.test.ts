import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ClickHouseClient } from '@clickhouse/client';
import {
  createClickHouseRegistry,
  probeClickHouseStartup,
  type ClickHouseRegistryDeps,
} from '../clickhouse-client';
import { ClickHouseMisconfiguredError, type ClickHouseEnv } from '../clickhouse-env';

const fakeClient = {} as ClickHouseClient;

const makeDeps = (
  env: ClickHouseEnv,
  overrides: Partial<ClickHouseRegistryDeps> = {},
): ClickHouseRegistryDeps => ({
  getEnv: () => env,
  createClient: vi.fn().mockReturnValue(fakeClient),
  ...overrides,
});

const configuredEnv: ClickHouseEnv = {
  CLICKHOUSE_ENABLED: 'true',
  CLICKHOUSE_HOST: 'http://localhost:8123',
  CLICKHOUSE_USER: 'user',
  CLICKHOUSE_PASSWORD: 'password',
  CLICKHOUSE_DATABASE: 'pagespace_analytics',
};

describe('createClickHouseRegistry — lazy client shell (#890 Phase 3)', () => {
  describe('off (default) — zero behavior change', () => {
    it('given CLICKHOUSE_ENABLED unset, getClient() should return null and never construct a client', () => {
      const createClient = vi.fn();
      const registry = createClickHouseRegistry(makeDeps({}, { createClient }));

      expect(registry.getClient()).toBeNull();
      expect(createClient).not.toHaveBeenCalled();
    });

    it('given the feature off, getClient() should not throw even with all connection vars missing', () => {
      const registry = createClickHouseRegistry(makeDeps({ CLICKHOUSE_ENABLED: 'false' }));
      expect(() => registry.getClient()).not.toThrow();
    });
  });

  describe('on + configured', () => {
    it('given a configured env, getClient() should build the client from the resolved config', () => {
      const createClient = vi.fn().mockReturnValue(fakeClient);
      const registry = createClickHouseRegistry(makeDeps(configuredEnv, { createClient }));

      expect(registry.getClient()).toBe(fakeClient);
      expect(createClient).toHaveBeenCalledWith({
        url: 'http://localhost:8123',
        username: 'user',
        password: 'password',
        database: 'pagespace_analytics',
      });
    });

    it('given repeated getClient() calls, should construct the client exactly once (per-process cache)', () => {
      const createClient = vi.fn().mockReturnValue(fakeClient);
      const registry = createClickHouseRegistry(makeDeps(configuredEnv, { createClient }));

      registry.getClient();
      registry.getClient();

      expect(createClient).toHaveBeenCalledTimes(1);
    });

    it('given import/construction of the registry alone, should have no side effects (lazy init)', () => {
      const createClient = vi.fn();
      createClickHouseRegistry(makeDeps(configuredEnv, { createClient }));
      expect(createClient).not.toHaveBeenCalled();
    });
  });

  describe('on + misconfigured — fail fast, never silently drop', () => {
    it('given the flag on but connection config missing, getClient() should throw with the misconfiguration reason', () => {
      const registry = createClickHouseRegistry(makeDeps({ CLICKHOUSE_ENABLED: 'true' }));
      expect(() => registry.getClient()).toThrow(/CLICKHOUSE_HOST/);
    });

    it('given the flag on but password missing, getClient() should throw naming the missing var', () => {
      const registry = createClickHouseRegistry(
        makeDeps({ ...configuredEnv, CLICKHOUSE_PASSWORD: undefined }),
      );
      expect(() => registry.getClient()).toThrow(/CLICKHOUSE_PASSWORD/);
    });
  });

  describe('getMode() — pure observation', () => {
    it('given any env, getMode() should report the decision without constructing a client or throwing', () => {
      const createClient = vi.fn();
      const registry = createClickHouseRegistry(
        makeDeps({ CLICKHOUSE_ENABLED: 'true' }, { createClient }),
      );

      expect(registry.getMode().mode).toBe('misconfigured');
      expect(createClient).not.toHaveBeenCalled();
    });

    it('given env read lazily, getMode() should re-read env each call (late-loaded dotenv wins)', () => {
      let env: ClickHouseEnv = {};
      const registry = createClickHouseRegistry(makeDeps({}, { getEnv: () => env }));

      expect(registry.getMode().mode).toBe('disabled');
      env = configuredEnv;
      expect(registry.getMode().mode).toBe('enabled');
    });
  });
});

describe('getGdprClient() — reaches CH wherever subject data COULD live (#890 Phase 3 FIX)', () => {
  it('given no CH env at all, should return null and never construct', () => {
    const createClient = vi.fn();
    const registry = createClickHouseRegistry(makeDeps({}, { createClient }));

    expect(registry.getGdprClient()).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('given full config with the flag OFF (rollback window), should STILL return a client', () => {
    const createClient = vi.fn().mockReturnValue(fakeClient);
    const registry = createClickHouseRegistry(
      makeDeps({ ...configuredEnv, CLICKHOUSE_ENABLED: undefined }, { createClient }),
    );

    expect(registry.getGdprClient()).toBe(fakeClient);
  });

  it('given partial config, should throw ClickHouseMisconfiguredError (fail-closed for GDPR)', () => {
    const registry = createClickHouseRegistry(
      makeDeps({ CLICKHOUSE_HOST: 'my-cluster.clickhouse.cloud' }),
    );

    expect(() => registry.getGdprClient()).toThrow(ClickHouseMisconfiguredError);
  });

  it('given the flag on and configured, getClient() and getGdprClient() should share one instance', () => {
    const createClient = vi.fn().mockReturnValue(fakeClient);
    const registry = createClickHouseRegistry(makeDeps(configuredEnv, { createClient }));

    expect(registry.getClient()).toBe(registry.getGdprClient());
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});

describe('misconfigured throws are typed (#890 Phase 3 FIX — adapters must distinguish them from flush failures)', () => {
  it('given flag on + config missing, getClient() should throw ClickHouseMisconfiguredError', () => {
    const registry = createClickHouseRegistry(makeDeps({ CLICKHOUSE_ENABLED: 'true' }));
    expect(() => registry.getClient()).toThrow(ClickHouseMisconfiguredError);
  });
});

describe('probeClickHouseStartup() — composition-root fail-fast (#890 Phase 3 FIX)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('given a half-configured deploy (flag on, no creds), should THROW so the process crashes at startup', () => {
    vi.stubEnv('CLICKHOUSE_ENABLED', 'true');
    vi.stubEnv('CLICKHOUSE_URL', '');
    vi.stubEnv('CLICKHOUSE_HOST', '');
    vi.stubEnv('CLICKHOUSE_USER', '');
    vi.stubEnv('CLICKHOUSE_PASSWORD', '');
    vi.stubEnv('CLICKHOUSE_DATABASE', '');

    expect(() => probeClickHouseStartup()).toThrow(ClickHouseMisconfiguredError);
  });

  it('given the tier off, should return the disabled decision without throwing', () => {
    vi.stubEnv('CLICKHOUSE_ENABLED', '');

    expect(probeClickHouseStartup().mode).toBe('disabled');
  });

  it('given the tier on and configured, should return the enabled decision (no client construction)', () => {
    vi.stubEnv('CLICKHOUSE_ENABLED', 'true');
    vi.stubEnv('CLICKHOUSE_URL', 'http://localhost:8123');
    vi.stubEnv('CLICKHOUSE_USER', 'user');
    vi.stubEnv('CLICKHOUSE_PASSWORD', 'password');
    vi.stubEnv('CLICKHOUSE_DATABASE', 'pagespace_analytics');

    expect(probeClickHouseStartup().mode).toBe('enabled');
  });
});
