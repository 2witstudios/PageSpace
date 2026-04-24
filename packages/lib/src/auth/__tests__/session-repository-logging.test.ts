import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
    query: { users: {}, sessions: {} },
    insert: vi.fn(),
    delete: vi.fn(),
  },
  sessions: { tokenHash: 'tokenHash' },
  users: {},
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  isNull: vi.fn(),
  gt: vi.fn(),
  lt: vi.fn(),
}));

import { db } from '@pagespace/db/db';
import { sessionRepository } from '../session-repository';

describe('sessionRepository.touchSession error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs error to console when database write fails', async () => {
    const dbError = new Error('connection reset by peer');
    const mockWhere = vi.fn().mockRejectedValueOnce(dbError);
    const mockSet = vi.fn(() => ({ where: mockWhere }));
    vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    sessionRepository.touchSession('some-token-hash');

    // Let the microtask (catch handler) execute
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(consoleSpy).toHaveBeenCalledWith(
      '[auth] Failed to update session lastUsedAt',
      dbError,
    );

    consoleSpy.mockRestore();
  });
});
