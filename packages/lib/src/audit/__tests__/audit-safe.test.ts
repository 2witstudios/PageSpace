import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoggers } = vi.hoisted(() => ({
  mockLoggers: {
    security: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: mockLoggers,
}));

vi.mock('@pagespace/db', () => ({
  securityAuditLog: {},
}));

import { auditSafe } from '../audit-safe';

describe('auditSafe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given a resolved promise, should not log any warning', async () => {
    auditSafe(Promise.resolve(), 'user-1');

    await vi.waitFor(() => {
      // No warning should be logged
    });

    expect(mockLoggers.security.warn).not.toHaveBeenCalled();
  });

  it('given a rejected promise with an Error, should log the error message', async () => {
    const error = new Error('DB connection failed');
    auditSafe(Promise.reject(error), 'user-42');

    await vi.waitFor(() => {
      expect(mockLoggers.security.warn).toHaveBeenCalled();
    });

    expect(mockLoggers.security.warn).toHaveBeenCalledWith(
      '[SecurityAudit] audit log failed',
      { error: 'DB connection failed', userId: 'user-42' }
    );
  });

  it('given a rejected promise with a non-Error, should stringify it', async () => {
    auditSafe(Promise.reject('some string error'), 'user-99');

    await vi.waitFor(() => {
      expect(mockLoggers.security.warn).toHaveBeenCalled();
    });

    expect(mockLoggers.security.warn).toHaveBeenCalledWith(
      '[SecurityAudit] audit log failed',
      { error: 'some string error', userId: 'user-99' }
    );
  });

  it('given a resolved promise, should return void (fire-and-forget)', () => {
    const result = auditSafe(Promise.resolve(), 'user-1');
    expect(result).toBeUndefined();
  });
});
