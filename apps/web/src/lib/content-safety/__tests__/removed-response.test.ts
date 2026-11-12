import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockIsHashBlocked = vi.fn();
vi.mock('@pagespace/lib/content-safety/blocklist', () => ({
  isHashBlocked: (...args: unknown[]) => mockIsHashBlocked(...args),
}));

import { contentRemovedResponse, refuseRemovedContent } from '../removed-response';

const HASH = 'a'.repeat(64);

describe('refuseRemovedContent', () => {
  beforeEach(() => {
    mockIsHashBlocked.mockReset();
  });

  it('returns null for a hash that is not blocked, so the caller serves the file', async () => {
    mockIsHashBlocked.mockResolvedValue(false);
    expect(await refuseRemovedContent(HASH)).toBeNull();
  });

  it('returns a 410 with a neutral message for a blocked hash', async () => {
    mockIsHashBlocked.mockResolvedValue(true);
    const response = await refuseRemovedContent(HASH);

    expect(response?.status).toBe(410);
    expect(await response?.json()).toEqual({ error: 'This file has been removed' });
    expect(response?.headers.get('cache-control')).toBe('no-store');
  });

  it('does not query for a missing hash', async () => {
    expect(await refuseRemovedContent(null)).toBeNull();
    expect(await refuseRemovedContent('')).toBeNull();
    expect(mockIsHashBlocked).not.toHaveBeenCalled();
  });

  it('lets a failed lookup propagate rather than serving the file', async () => {
    mockIsHashBlocked.mockRejectedValue(new Error('db down'));
    await expect(refuseRemovedContent(HASH)).rejects.toThrow('db down');
  });
});

describe('contentRemovedResponse', () => {
  it('says nothing about why the file is gone', async () => {
    const body = JSON.stringify(await contentRemovedResponse().json());
    expect(body).not.toMatch(/block|illegal|policy|violat|csam|malware|report/i);
  });
});
