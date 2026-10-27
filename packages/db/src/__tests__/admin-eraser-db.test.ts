/**
 * Unit tests for the GDPR eraser connection to the Admin PG (#890 Phase 2,
 * leaf 6). Pure mode decision + lazy registry wiring — no real connections.
 *
 * The eraser identity (admin_gdpr_eraser_user → admin_gdpr_eraser template,
 * column-scoped UPDATE on exactly the 6 PII columns) is deliberately NOT part
 * of the AdminDb registry: it must never fall back to the main DB or to the
 * admin_app connection — an unavailable eraser refuses, it never degrades.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  resolveAdminEraserDbMode,
  createAdminEraserDbRegistry,
  ADMIN_ERASER_POOL_MAX,
  ADMIN_ERASER_POOL_NAME,
  type AdminEraserDbEnv,
} from '../admin-eraser-db';
import type { AdminPoolConfig } from '../admin-db-mode';

const ENV_OK: AdminEraserDbEnv = {
  ADMIN_ERASER_DATABASE_URL: 'postgresql://admin_gdpr_eraser_user:pw@host:5432/pagespace_admin',
};

describe('resolveAdminEraserDbMode', () => {
  it('given a valid postgres URL, should be available', () => {
    expect(resolveAdminEraserDbMode(ENV_OK)).toEqual({
      mode: 'available',
      reason: 'ADMIN_ERASER_DATABASE_URL is set',
    });
  });

  it('given an unset URL, should be unavailable with an actionable reason (provision the eraser login, set the env)', () => {
    const decision = resolveAdminEraserDbMode({});
    expect(decision.mode).toBe('unavailable');
    expect(decision.reason).toContain('ADMIN_ERASER_DATABASE_URL');
    expect(decision.reason).toContain('admin_gdpr_eraser_user');
  });

  it('given an empty string, should treat it as unset', () => {
    expect(resolveAdminEraserDbMode({ ADMIN_ERASER_DATABASE_URL: '' }).mode).toBe('unavailable');
  });

  it('given a non-postgres URL, should be unavailable and say the value is invalid (never used as-is)', () => {
    const decision = resolveAdminEraserDbMode({ ADMIN_ERASER_DATABASE_URL: 'mysql://nope' });
    expect(decision.mode).toBe('unavailable');
    expect(decision.reason).toContain('not a postgres');
  });
});

describe('createAdminEraserDbRegistry', () => {
  const makeDeps = (env: AdminEraserDbEnv) => {
    const pool = { on: vi.fn() } as unknown as Pool;
    const deps = {
      getEnv: vi.fn(() => env),
      createPool: vi.fn((_config: AdminPoolConfig) => pool),
      registerPool: vi.fn(),
    };
    return { deps, pool };
  };

  it('given an available env, should lazily build ONE pool, register it, and reuse the instance', () => {
    const { deps } = makeDeps(ENV_OK);
    const registry = createAdminEraserDbRegistry(deps);

    expect(deps.createPool).not.toHaveBeenCalled(); // lazy — no pool on construction

    const first = registry.getAdminEraserDb();
    const second = registry.getAdminEraserDb();
    expect(second).toBe(first);
    expect(deps.createPool).toHaveBeenCalledTimes(1);
    expect(deps.registerPool).toHaveBeenCalledWith(expect.anything(), ADMIN_ERASER_POOL_NAME);
  });

  it('given the pool config, should use the eraser URL, a small dedicated pool, and the shared SSL semantics', () => {
    const { deps } = makeDeps({ ...ENV_OK, ADMIN_DATABASE_SSL: 'true' });
    createAdminEraserDbRegistry(deps).getAdminEraserDb();

    const config = deps.createPool.mock.calls[0]![0];
    expect(config.connectionString).toBe(ENV_OK.ADMIN_ERASER_DATABASE_URL);
    expect(config.max).toBe(ADMIN_ERASER_POOL_MAX);
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('given an unavailable env, should THROW with the reason — the eraser never falls back to another identity', () => {
    const { deps } = makeDeps({});
    const registry = createAdminEraserDbRegistry(deps);
    expect(() => registry.getAdminEraserDb()).toThrow(/ADMIN_ERASER_DATABASE_URL/);
    expect(deps.createPool).not.toHaveBeenCalled();
  });

  it('getMode should be a pure readback — no pool, no throw, re-reads env each call', () => {
    const env: AdminEraserDbEnv = {};
    const { deps } = makeDeps(env);
    const registry = createAdminEraserDbRegistry({
      ...deps,
      getEnv: () => env,
    });

    expect(registry.getMode().mode).toBe('unavailable');
    env.ADMIN_ERASER_DATABASE_URL = ENV_OK.ADMIN_ERASER_DATABASE_URL;
    expect(registry.getMode().mode).toBe('available');
    expect(deps.createPool).not.toHaveBeenCalled();
  });
});
