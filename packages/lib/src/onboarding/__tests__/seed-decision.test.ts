import { describe, expect, it } from 'vitest';
import { decideDriveSeeding } from '../seed-decision';

describe('decideDriveSeeding', () => {
  it('given an empty seed scope, seeds', () => {
    expect(decideDriveSeeding({ existingPageCount: 0 })).toEqual({ action: 'seed' });
  });

  it('given a scope that already holds seed pages, skips rather than appending a second copy', () => {
    expect(decideDriveSeeding({ existingPageCount: 1 })).toEqual({
      action: 'skip',
      reason: 'already-seeded',
    });
    expect(decideDriveSeeding({ existingPageCount: 9 }).action).toBe('skip');
  });
});
