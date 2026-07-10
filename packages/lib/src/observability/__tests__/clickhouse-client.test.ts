import { describe, it, expect, vi } from 'vitest';
import type { ClickHouseClient } from '@clickhouse/client';
import {
  createClickHouseRegistry,
  type ClickHouseRegistryDeps,
} from '../clickhouse-client';
import type { ClickHouseEnv } from '../clickhouse-env';

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
