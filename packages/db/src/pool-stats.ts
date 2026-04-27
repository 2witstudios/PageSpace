import type { Pool } from 'pg';

let _pool: Pool | null = null;

export function registerPool(pool: Pool): void {
  _pool = pool;
}

export function getPoolStats(): { total: number; idle: number; waiting: number } {
  if (!_pool) return { total: 0, idle: 0, waiting: 0 };
  return {
    total: _pool.totalCount,
    idle: _pool.idleCount,
    waiting: _pool.waitingCount,
  };
}
