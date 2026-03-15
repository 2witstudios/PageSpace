import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db', () => ({
  db: {
    update: vi.fn(),
  },
  activityLogs: { userId: 'userId', actorEmail: 'actorEmail', actorDisplayName: 'actorDisplayName' },
  eq: vi.fn((_a, _b) => 'eq'),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { activityLogRepository } from '../activity-log-repository';
import { db } from '@pagespace/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @scaffold — ORM chain mock: db.update().set().where() */
function setupUpdateChain() {
  const whereFn = vi.fn().mockResolvedValue(undefined);
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  vi.mocked(db.update).mockReturnValue({ set: setFn } as unknown as ReturnType<typeof db.update>);
  return { setFn, whereFn };
}

// ---------------------------------------------------------------------------
// anonymizeForUser
// ---------------------------------------------------------------------------
describe('activityLogRepository.anonymizeForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success=true on successful update', async () => {
    setupUpdateChain();

    const result = await activityLogRepository.anonymizeForUser('user-1', 'deleted-user-abc123@anonymized.invalid');
    expect(result).toEqual({ success: true });
  });

  it('calls db.update with correct anonymized payload for the activityLogs table', async () => {
    const { setFn, whereFn } = setupUpdateChain();

    await activityLogRepository.anonymizeForUser('user-1', 'anon@anonymized.invalid');

    expect(db.update).toHaveBeenCalledWith({ userId: 'userId', actorEmail: 'actorEmail', actorDisplayName: 'actorDisplayName' });
    expect(setFn).toHaveBeenCalledWith({
      actorEmail: 'anon@anonymized.invalid',
      actorDisplayName: 'Deleted User',
    });
    expect(whereFn).toHaveBeenCalledTimes(1);
  });

  it('returns success=false with error message on DB error', async () => {
    const whereFn = vi.fn().mockRejectedValue(new Error('DB connection failed'));
    const setFn = vi.fn().mockReturnValue({ where: whereFn });
    vi.mocked(db.update).mockReturnValue({ set: setFn } as unknown as ReturnType<typeof db.update>);

    const result = await activityLogRepository.anonymizeForUser('user-1', 'anon@anonymized.invalid');

    expect(result.success).toBe(false);
    expect(result.error).toBe('DB connection failed');
  });

  it('returns success=false with "Unknown error" for non-Error throws', async () => {
    const whereFn = vi.fn().mockRejectedValue('string error');
    const setFn = vi.fn().mockReturnValue({ where: whereFn });
    vi.mocked(db.update).mockReturnValue({ set: setFn } as unknown as ReturnType<typeof db.update>);

    const result = await activityLogRepository.anonymizeForUser('user-1', 'anon@anonymized.invalid');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown error');
  });

  it('uses the provided anonymizedEmail exactly', async () => {
    const { setFn } = setupUpdateChain();
    const anonymizedEmail = 'custom-anon-identifier@anonymized.example.com';

    await activityLogRepository.anonymizeForUser('user-99', anonymizedEmail);

    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({ actorEmail: anonymizedEmail })
    );
  });
});
