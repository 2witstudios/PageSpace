import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsHashBlocked = vi.fn();
const mockDeleteOriginal = vi.fn();
vi.mock('@pagespace/lib/content-safety/blocklist', () => ({
  isHashBlocked: (...args: unknown[]) => mockIsHashBlocked(...args),
}));
vi.mock('../../server', () => ({
  contentStore: { deleteOriginal: (...args: unknown[]) => mockDeleteOriginal(...args) },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { security: { warn: vi.fn() } },
}));

import { deleteOriginalUnlessHeld, isHeldForTakedown } from '../takedown-guard';
import { loggers } from '@pagespace/lib/logging/logger-config';

const HASH = 'a'.repeat(64);

describe('takedown guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteOriginal.mockResolvedValue(true);
  });

  it('deletes a rejected upload whose hash is not blocked', async () => {
    mockIsHashBlocked.mockResolvedValue(false);

    expect(await deleteOriginalUnlessHeld(HASH)).toBe(true);
    expect(mockDeleteOriginal).toHaveBeenCalledWith(HASH);
  });

  it('leaves the object alone when the hash is held for a takedown: it may be the only copy', async () => {
    mockIsHashBlocked.mockResolvedValue(true);

    expect(await deleteOriginalUnlessHeld(HASH)).toBe(false);
    expect(mockDeleteOriginal).not.toHaveBeenCalled();
    expect(await isHeldForTakedown(HASH)).toBe(true);
  });

  it('does not put the hash in the log line', async () => {
    mockIsHashBlocked.mockResolvedValue(true);
    await deleteOriginalUnlessHeld(HASH);

    expect(JSON.stringify(vi.mocked(loggers.security.warn).mock.calls)).not.toContain(HASH);
  });

  it('deletes nothing when the blocklist cannot be read', async () => {
    mockIsHashBlocked.mockRejectedValue(new Error('db down'));

    await expect(deleteOriginalUnlessHeld(HASH)).rejects.toThrow('db down');
    expect(mockDeleteOriginal).not.toHaveBeenCalled();
  });
});
