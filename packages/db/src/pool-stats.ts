import type { Pool } from 'pg';

export const MAIN_POOL_NAME = 'main';

const pools = new Map<string, Pool>();

export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

export function registerPool(pool: Pool, name: string = MAIN_POOL_NAME): void {
  pools.set(name, pool);
}

export function getPoolStats(name: string = MAIN_POOL_NAME): PoolStats {
  const pool = pools.get(name);
  if (!pool) return { total: 0, idle: 0, waiting: 0 };
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}
