import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { registerPool, getPoolStats } from './pool-stats';

const makePool = (totalCount: number, idleCount: number, waitingCount: number) =>
  ({ totalCount, idleCount, waitingCount } as unknown as Pool);

describe('pool-stats', () => {
  describe('getPoolStats', () => {
    it('returns pool counts from the registered pool', () => {
      registerPool(makePool(5, 3, 1));
      expect(getPoolStats()).toEqual({ total: 5, idle: 3, waiting: 1 });
    });

    it('reflects current pool state on each call', () => {
      registerPool(makePool(2, 1, 0));
      expect(getPoolStats()).toEqual({ total: 2, idle: 1, waiting: 0 });

      registerPool(makePool(3, 0, 2));
      expect(getPoolStats()).toEqual({ total: 3, idle: 0, waiting: 2 });
    });
  });

  describe('named pools', () => {
    it('given an admin pool registered under its own name, should not clobber the default pool stats', () => {
      registerPool(makePool(5, 3, 1));
      registerPool(makePool(2, 2, 0), 'admin');
      expect(getPoolStats()).toEqual({ total: 5, idle: 3, waiting: 1 });
      expect(getPoolStats('admin')).toEqual({ total: 2, idle: 2, waiting: 0 });
    });

    it('given an unknown pool name, should return zeros', () => {
      expect(getPoolStats('nonexistent')).toEqual({ total: 0, idle: 0, waiting: 0 });
    });
  });

  describe('registerPool', () => {
    it('returns total from pool.totalCount', () => {
      registerPool(makePool(7, 3, 2));
      expect(getPoolStats().total).toBe(7);
    });

    it('returns idle from pool.idleCount', () => {
      registerPool(makePool(4, 2, 0));
      expect(getPoolStats().idle).toBe(2);
    });

    it('returns waiting from pool.waitingCount', () => {
      registerPool(makePool(4, 0, 3));
      expect(getPoolStats().waiting).toBe(3);
    });
  });
});
