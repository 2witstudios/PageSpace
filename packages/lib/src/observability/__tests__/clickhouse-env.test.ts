import { describe, it, expect } from 'vitest';
import {
  resolveClickHouseMode,
  isClickHouseEnabledFlag,
  type ClickHouseEnv,
} from '../clickhouse-env';

const enabledEnv = (overrides: Partial<ClickHouseEnv> = {}): ClickHouseEnv => ({
  CLICKHOUSE_ENABLED: 'true',
  CLICKHOUSE_HOST: 'https://my-cluster.clickhouse.cloud:8443',
  CLICKHOUSE_USER: 'default',
  CLICKHOUSE_PASSWORD: 'secret',
  CLICKHOUSE_DATABASE: 'pagespace_analytics',
  ...overrides,
});

describe('isClickHouseEnabledFlag', () => {
  it("given the exact string 'true', should be enabled", () => {
    expect(isClickHouseEnabledFlag('true')).toBe(true);
  });

  it.each([undefined, '', 'TRUE', '1', ' true ', 'false', 'yes'])(
    'given %j, should NOT be enabled (fail-closed, exact-match only)',
    (flag) => {
      expect(isClickHouseEnabledFlag(flag)).toBe(false);
    },
  );
});

describe('resolveClickHouseMode — three-state gating (#890 Phase 3)', () => {
  describe('state 1: off (default)', () => {
    it('given CLICKHOUSE_ENABLED unset, should be disabled — never throw, never misconfigured', () => {
      const decision = resolveClickHouseMode({});
      expect(decision.mode).toBe('disabled');
    });

    it('given CLICKHOUSE_ENABLED unset but full connection config present, should STILL be disabled (flag wins)', () => {
      const decision = resolveClickHouseMode(enabledEnv({ CLICKHOUSE_ENABLED: undefined }));
      expect(decision.mode).toBe('disabled');
    });

    it("given CLICKHOUSE_ENABLED='false' with missing creds, should be disabled, NOT misconfigured", () => {
      const decision = resolveClickHouseMode({ CLICKHOUSE_ENABLED: 'false' });
      expect(decision.mode).toBe('disabled');
    });
  });

  describe('state 2: on + configured', () => {
    it('given the flag on and HOST/USER/PASSWORD/DATABASE set, should be enabled with a resolved config', () => {
      const decision = resolveClickHouseMode(enabledEnv());
      expect(decision.mode).toBe('enabled');
      if (decision.mode === 'enabled') {
        expect(decision.config).toEqual({
          url: 'https://my-cluster.clickhouse.cloud:8443',
          username: 'default',
          password: 'secret',
          database: 'pagespace_analytics',
        });
      }
    });

    it('given a bare CLICKHOUSE_HOST (no scheme), should normalize to https on the ClickHouse Cloud port 8443', () => {
      const decision = resolveClickHouseMode(
        enabledEnv({ CLICKHOUSE_HOST: 'my-cluster.clickhouse.cloud' }),
      );
      expect(decision.mode).toBe('enabled');
      if (decision.mode === 'enabled') {
        expect(decision.config.url).toBe('https://my-cluster.clickhouse.cloud:8443');
      }
    });

    it('given an http:// CLICKHOUSE_HOST (local dev container), should keep it verbatim', () => {
      const decision = resolveClickHouseMode(
        enabledEnv({ CLICKHOUSE_HOST: 'http://localhost:8123' }),
      );
      expect(decision.mode).toBe('enabled');
      if (decision.mode === 'enabled') {
        expect(decision.config.url).toBe('http://localhost:8123');
      }
    });

    it('given CLICKHOUSE_URL set, should use it directly and not require CLICKHOUSE_HOST', () => {
      const decision = resolveClickHouseMode({
        CLICKHOUSE_ENABLED: 'true',
        CLICKHOUSE_URL: 'http://localhost:8123',
        CLICKHOUSE_USER: 'user',
        CLICKHOUSE_PASSWORD: 'password',
        CLICKHOUSE_DATABASE: 'pagespace_analytics',
      });
      expect(decision.mode).toBe('enabled');
      if (decision.mode === 'enabled') {
        expect(decision.config.url).toBe('http://localhost:8123');
      }
    });
  });

  describe('state 3: on + misconfigured (fail-fast, never silently drop inserts)', () => {
    it('given the flag on with no URL and no HOST, should be misconfigured naming the missing vars', () => {
      const decision = resolveClickHouseMode({ CLICKHOUSE_ENABLED: 'true' });
      expect(decision.mode).toBe('misconfigured');
      if (decision.mode === 'misconfigured') {
        expect(decision.reason).toContain('CLICKHOUSE_HOST');
      }
    });

    it.each(['CLICKHOUSE_USER', 'CLICKHOUSE_PASSWORD', 'CLICKHOUSE_DATABASE'] as const)(
      'given the flag on with %s missing, should be misconfigured naming that var',
      (missing) => {
        const decision = resolveClickHouseMode(enabledEnv({ [missing]: undefined }));
        expect(decision.mode).toBe('misconfigured');
        if (decision.mode === 'misconfigured') {
          expect(decision.reason).toContain(missing);
        }
      },
    );

    it('given empty-string values, should treat them as unset (misconfigured)', () => {
      const decision = resolveClickHouseMode(enabledEnv({ CLICKHOUSE_PASSWORD: '' }));
      expect(decision.mode).toBe('misconfigured');
    });

    it('given a CLICKHOUSE_HOST with a non-http(s) scheme, should be misconfigured', () => {
      const decision = resolveClickHouseMode(
        enabledEnv({ CLICKHOUSE_HOST: 'tcp://localhost:9000' }),
      );
      expect(decision.mode).toBe('misconfigured');
    });

    it('given a CLICKHOUSE_URL with a non-http(s) scheme, should be misconfigured', () => {
      const decision = resolveClickHouseMode({
        CLICKHOUSE_ENABLED: 'true',
        CLICKHOUSE_URL: 'tcp://localhost:9000',
        CLICKHOUSE_USER: 'user',
        CLICKHOUSE_PASSWORD: 'password',
        CLICKHOUSE_DATABASE: 'pagespace_analytics',
      });
      expect(decision.mode).toBe('misconfigured');
    });
  });
});
