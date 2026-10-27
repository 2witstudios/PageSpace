/**
 * Shell tests for the adminDb connection registry (#890 Phase 1).
 *
 * createAdminDbRegistry is a factory with explicit deps — tests inject fakes
 * for pool construction, the main db, pool-stats registration, and alerting,
 * so no test ever touches process.env or opens a connection.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  createAdminDbRegistry,
  ADMIN_POOL_NAME,
  type AdminDatabase,
  type AdminDbDeps,
} from '../admin-db';

const DEDICATED_ENV = {
  ADMIN_DATABASE_URL: 'postgresql://admin:pw@host:5432/pagespace_admin',
};
const BREAK_GLASS_ENV = { ADMIN_DB_BREAK_GLASS: 'true' };
// Unconfigured trust plane, no enforcement flag → silent main-db default.
const MAIN_DB_ENV = {};
// Enforcement declared but not configured → fail-fast.
const FAIL_ENV = { AUDIT_TRUST_PLANE_REQUIRED: 'true' };

const makeFakePool = () => ({ on: vi.fn() }) as unknown as Pool;

const makeDeps = (overrides: Partial<AdminDbDeps> = {}) => {
  const fakePool = makeFakePool();
  const fakeMainDb = { fake: 'main-db' } as unknown as AdminDatabase;
  const deps: AdminDbDeps = {
    getEnv: () => DEDICATED_ENV,
    getMainDb: vi.fn(() => fakeMainDb),
    createPool: vi.fn(() => fakePool),
    registerPool: vi.fn(),
    alert: vi.fn(),
    ...overrides,
  };
  return { deps, fakePool, fakeMainDb };
};

describe('createAdminDbRegistry', () => {
  describe('dedicated mode (ADMIN_DATABASE_URL set)', () => {
    it('should construct the pool from the resolved config', () => {
      const { deps } = makeDeps();
      createAdminDbRegistry(deps).getAdminDb();
      expect(deps.createPool).toHaveBeenCalledTimes(1);
      expect(deps.createPool).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionString: DEDICATED_ENV.ADMIN_DATABASE_URL,
          max: 10,
          keepAlive: true,
        }),
      );
    });

    it('should register the pool with pool-stats under the admin name', () => {
      const { deps, fakePool } = makeDeps();
      createAdminDbRegistry(deps).getAdminDb();
      expect(deps.registerPool).toHaveBeenCalledTimes(1);
      expect(deps.registerPool).toHaveBeenCalledWith(fakePool, ADMIN_POOL_NAME);
    });

    it('should attach the error-swallow handler like the main pool', () => {
      const { deps, fakePool } = makeDeps();
      createAdminDbRegistry(deps).getAdminDb();
      expect(fakePool.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should return a drizzle client bound to the dedicated pool', () => {
      const { deps } = makeDeps();
      const adminDb = createAdminDbRegistry(deps).getAdminDb();
      expect(typeof adminDb.execute).toBe('function');
    });

    it('should bind the admin schema barrel — query API exposes the trust-plane tables', () => {
      const { deps } = makeDeps();
      const adminDb = createAdminDbRegistry(deps).getAdminDb();
      expect(adminDb.query.securityAuditLog).toBeDefined();
      expect(adminDb.query.siemDeliveryCursors).toBeDefined();
      expect(adminDb.query.siemDeliveryReceipts).toBeDefined();
    });

    it('should never touch the ambient main db or alert in the dedicated path', () => {
      const { deps } = makeDeps();
      createAdminDbRegistry(deps).getAdminDb();
      expect(deps.getMainDb).not.toHaveBeenCalled();
      expect(deps.alert).not.toHaveBeenCalled();
    });

    it('should be a single instance per registry (lazy init, one pool)', () => {
      const { deps } = makeDeps();
      const registry = createAdminDbRegistry(deps);
      const first = registry.getAdminDb();
      const second = registry.getAdminDb();
      expect(second).toBe(first);
      expect(deps.createPool).toHaveBeenCalledTimes(1);
    });

    it('should not construct any pool at registry-creation time (no connection at import time)', () => {
      const { deps } = makeDeps();
      createAdminDbRegistry(deps);
      expect(deps.createPool).not.toHaveBeenCalled();
    });
  });

  describe('break-glass mode (URL unset, flag exactly true)', () => {
    it('should return the main db itself (adminDb === db)', () => {
      const { deps, fakeMainDb } = makeDeps({ getEnv: () => BREAK_GLASS_ENV });
      const adminDb = createAdminDbRegistry(deps).getAdminDb();
      expect(adminDb).toBe(fakeMainDb);
    });

    it('should fire a loud alert naming break-glass and the missing ADMIN_DATABASE_URL', () => {
      const { deps } = makeDeps({ getEnv: () => BREAK_GLASS_ENV });
      createAdminDbRegistry(deps).getAdminDb();
      expect(deps.alert).toHaveBeenCalledTimes(1);
      const message = vi.mocked(deps.alert).mock.calls[0][0];
      expect(message).toContain('BREAK-GLASS');
      expect(message).toContain('ADMIN_DATABASE_URL');
    });

    it('should not construct a dedicated pool', () => {
      const { deps } = makeDeps({ getEnv: () => BREAK_GLASS_ENV });
      createAdminDbRegistry(deps).getAdminDb();
      expect(deps.createPool).not.toHaveBeenCalled();
      expect(deps.registerPool).not.toHaveBeenCalled();
    });

    it('should alert on every init — a fresh registry (new process) alerts again', () => {
      const { deps } = makeDeps({ getEnv: () => BREAK_GLASS_ENV });
      const registry = createAdminDbRegistry(deps);
      registry.getAdminDb();
      registry.getAdminDb(); // cached — same init, no second alert
      expect(deps.alert).toHaveBeenCalledTimes(1);

      createAdminDbRegistry(deps).getAdminDb(); // new init — alerts again
      expect(deps.alert).toHaveBeenCalledTimes(2);
    });
  });

  describe('main-db mode (URL unset, no armed flag — THE incident fix)', () => {
    it('should return the main db itself, SILENTLY (adminDb === db, no alert)', () => {
      const { deps, fakeMainDb } = makeDeps({ getEnv: () => MAIN_DB_ENV });
      const adminDb = createAdminDbRegistry(deps).getAdminDb();
      expect(adminDb).toBe(fakeMainDb);
      expect(deps.alert).not.toHaveBeenCalled();
    });

    it('should not throw and not construct a dedicated pool', () => {
      const { deps } = makeDeps({ getEnv: () => MAIN_DB_ENV });
      const registry = createAdminDbRegistry(deps);
      expect(() => registry.getAdminDb()).not.toThrow();
      expect(deps.createPool).not.toHaveBeenCalled();
      expect(deps.registerPool).not.toHaveBeenCalled();
    });

    it("given a non-'true' break-glass value, should resolve main-db silently (flag not armed)", () => {
      const { deps, fakeMainDb } = makeDeps({
        getEnv: () => ({ ADMIN_DB_BREAK_GLASS: 'TRUE' }),
      });
      const adminDb = createAdminDbRegistry(deps).getAdminDb();
      expect(adminDb).toBe(fakeMainDb);
      expect(deps.alert).not.toHaveBeenCalled();
    });
  });

  describe('fail-fast mode (AUDIT_TRUST_PLANE_REQUIRED armed, no URL)', () => {
    it('should throw an actionable error naming ADMIN_DATABASE_URL and AUDIT_TRUST_PLANE_REQUIRED', () => {
      const { deps } = makeDeps({ getEnv: () => FAIL_ENV });
      const registry = createAdminDbRegistry(deps);
      expect(() => registry.getAdminDb()).toThrowError(/ADMIN_DATABASE_URL/);
      expect(() => registry.getAdminDb()).toThrowError(/AUDIT_TRUST_PLANE_REQUIRED/);
    });

    it('should throw on every call, not just the first', () => {
      const { deps } = makeDeps({ getEnv: () => FAIL_ENV });
      const registry = createAdminDbRegistry(deps);
      expect(() => registry.getAdminDb()).toThrow();
      expect(() => registry.getAdminDb()).toThrow();
    });

    it('should not touch the main db or any pool before throwing', () => {
      const { deps } = makeDeps({ getEnv: () => FAIL_ENV });
      expect(() => createAdminDbRegistry(deps).getAdminDb()).toThrow();
      expect(deps.getMainDb).not.toHaveBeenCalled();
      expect(deps.createPool).not.toHaveBeenCalled();
    });
  });

  describe('getMode() — resolved-mode readback for the audit bind point (#890 Phase 2, leaf 5)', () => {
    it('given a dedicated env, should report dedicated without constructing a pool or alerting', () => {
      const { deps } = makeDeps();
      const decision = createAdminDbRegistry(deps).getMode();
      expect(decision.mode).toBe('dedicated');
      expect(deps.createPool).not.toHaveBeenCalled();
      expect(deps.getMainDb).not.toHaveBeenCalled();
      expect(deps.alert).not.toHaveBeenCalled();
    });

    it('given a break-glass env, should report break-glass WITHOUT firing the banner (observation, not activation)', () => {
      const { deps } = makeDeps({ getEnv: () => BREAK_GLASS_ENV });
      const decision = createAdminDbRegistry(deps).getMode();
      expect(decision.mode).toBe('break-glass');
      expect(deps.alert).not.toHaveBeenCalled();
      expect(deps.getMainDb).not.toHaveBeenCalled();
    });

    it('given a main-db env (unconfigured), should report main-db without alerting or touching the main db', () => {
      const { deps } = makeDeps({ getEnv: () => MAIN_DB_ENV });
      const decision = createAdminDbRegistry(deps).getMode();
      expect(decision.mode).toBe('main-db');
      expect(deps.alert).not.toHaveBeenCalled();
      expect(deps.getMainDb).not.toHaveBeenCalled();
    });

    it('given a fail env (enforcement declared, unconfigured), should report fail with the actionable reason instead of throwing', () => {
      const { deps } = makeDeps({ getEnv: () => FAIL_ENV });
      const decision = createAdminDbRegistry(deps).getMode();
      expect(decision.mode).toBe('fail');
      expect(decision.reason).toMatch(/ADMIN_DATABASE_URL/);
    });

    it('should re-read env on every call (late-loaded dotenv wins, no caching)', () => {
      let env: Record<string, string> = { ...FAIL_ENV };
      const { deps } = makeDeps({ getEnv: () => env });
      const registry = createAdminDbRegistry(deps);
      expect(registry.getMode().mode).toBe('fail');
      env = { ...DEDICATED_ENV };
      expect(registry.getMode().mode).toBe('dedicated');
    });
  });
});
