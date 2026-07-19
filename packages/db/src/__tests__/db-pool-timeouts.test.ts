import { describe, it, expect } from 'vitest';
import { buildAppPoolOptions, pool, getAdvisoryLockPool, getMigrationPool } from '../db';

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

  it('given the migration pool (migrate.ts / migrate-pending-invites.ts), should NOT carry statement_timeout — DDL/backfills can legitimately run past 15s', () => {
    const migrationPool = getMigrationPool();
    expect(migrationPool.options.options ?? '').not.toContain('statement_timeout');
  });

  it('given the migration pool, should NOT carry lock_timeout — it can legitimately queue behind an in-flight app transaction past 5s', () => {
    const migrationPool = getMigrationPool();
    expect(migrationPool.options.options ?? '').not.toContain('lock_timeout');
  });

  it('given the migration pool, should be a distinct pool instance from both the main pool and the advisory-lock pool', () => {
    const migrationPool = getMigrationPool();
    expect(migrationPool).not.toBe(pool);
    expect(migrationPool).not.toBe(getAdvisoryLockPool());
  });

  it('given the migration pool, should be a singleton across repeated calls (lazy init, one pool)', () => {
    expect(getMigrationPool()).toBe(getMigrationPool());
  });
});
