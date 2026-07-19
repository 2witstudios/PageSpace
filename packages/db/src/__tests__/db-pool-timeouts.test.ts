import { describe, it, expect } from 'vitest';
import { buildAppPoolOptions, pool, getAdvisoryLockPool } from '../db';

describe('buildAppPoolOptions (Phase 7 — statement_timeout/lock_timeout on the main pool)', () => {
  it('should set statement_timeout to 15000ms', () => {
    expect(buildAppPoolOptions()).toContain('statement_timeout=15000');
  });

  it('should set lock_timeout to 5000ms', () => {
    expect(buildAppPoolOptions()).toContain('lock_timeout=5000');
  });

  it('should be a single "-c key=value -c key=value" PGOPTIONS-style string', () => {
    expect(buildAppPoolOptions()).toBe('-c statement_timeout=15000 -c lock_timeout=5000');
  });

  it('given the main pool (db), should carry the statement_timeout/lock_timeout options string', () => {
    expect(pool.options.options).toBe(buildAppPoolOptions());
  });

  it('given the advisory-lock pool, should NOT carry lock_timeout (it holds/waits on session-level locks for the span of a background job)', () => {
    const advisoryPool = getAdvisoryLockPool();
    expect(advisoryPool.options.options ?? '').not.toContain('lock_timeout');
  });

  it('given the advisory-lock pool, should also not inherit statement_timeout from the main pool options', () => {
    const advisoryPool = getAdvisoryLockPool();
    expect(advisoryPool.options.options ?? '').not.toContain('statement_timeout');
  });
});
