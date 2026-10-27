import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { releaseAppPool } from '../release-app-pool';

const fakePool = (ending: boolean) => ({ ending, end: vi.fn().mockResolvedValue(undefined) });

describe('releaseAppPool', () => {
  it('given a live pool, should end it so the next integration file does not inherit its connections', async () => {
    const pool = fakePool(false);

    await releaseAppPool(pool);

    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('given a suite that mocks @pagespace/db/db without a pool, should do nothing', async () => {
    await expect(releaseAppPool(undefined)).resolves.toBeUndefined();
  });

  it('given a pool the suite already ended itself, should not end it twice', async () => {
    const pool = fakePool(true);

    await releaseAppPool(pool);

    expect(pool.end).not.toHaveBeenCalled();
  });
});

describe('vitest.integration.config.ts', () => {
  // Each integration file runs isolated with its own @pagespace/db pool (10
  // connections, 10-minute idle timeout). Without a per-file release they pile
  // up across ~40 files until Postgres answers 53300 "too many clients".
  it('should release the app pool after every integration file', () => {
    const config = readFileSync(join(__dirname, '../../../vitest.integration.config.ts'), 'utf8');

    expect(config).toContain('./src/test/integration-db-teardown.ts');
  });
});
