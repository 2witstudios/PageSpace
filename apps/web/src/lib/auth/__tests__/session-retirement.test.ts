import { describe, it, expect, vi } from 'vitest';
import {
  retireReplacedSession,
  REPLACED_BY_REFRESH_REASON,
  type SessionRetirementDeps,
} from '../session-retirement';

const makeDeps = (overrides: Partial<SessionRetirementDeps> = {}): SessionRetirementDeps => ({
  getSessionOwnerId: vi.fn().mockResolvedValue('user-1'),
  hashToken: vi.fn((t: string) => `hash(${t})`),
  revokeByHash: vi.fn().mockResolvedValue(undefined),
  logWarn: vi.fn(),
  ...overrides,
});

describe('retireReplacedSession', () => {
  it('returns no_session_cookie and revokes nothing when no old token is present', async () => {
    const deps = makeDeps();

    expect(await retireReplacedSession(null, 'user-1', deps)).toBe('no_session_cookie');
    expect(await retireReplacedSession(undefined, 'user-1', deps)).toBe('no_session_cookie');
    expect(await retireReplacedSession('', 'user-1', deps)).toBe('no_session_cookie');

    expect(deps.getSessionOwnerId).not.toHaveBeenCalled();
    expect(deps.revokeByHash).not.toHaveBeenCalled();
  });

  it('revokes the old session by hash with replaced_by_refresh when it belongs to the same user', async () => {
    const deps = makeDeps();

    const outcome = await retireReplacedSession('old-token', 'user-1', deps);

    expect(outcome).toBe('revoked');
    expect(deps.hashToken).toHaveBeenCalledWith('old-token');
    expect(deps.revokeByHash).toHaveBeenCalledWith('hash(old-token)', REPLACED_BY_REFRESH_REASON);
    expect(deps.logWarn).not.toHaveBeenCalled();
  });

  it('does NOT revoke when the old session belongs to a different user', async () => {
    const deps = makeDeps({ getSessionOwnerId: vi.fn().mockResolvedValue('other-user') });

    const outcome = await retireReplacedSession('old-token', 'user-1', deps);

    expect(outcome).toBe('not_same_user');
    expect(deps.revokeByHash).not.toHaveBeenCalled();
  });

  it('does NOT revoke when the old session resolves to no owner (inactive/expired)', async () => {
    const deps = makeDeps({ getSessionOwnerId: vi.fn().mockResolvedValue(null) });

    const outcome = await retireReplacedSession('old-token', 'user-1', deps);

    expect(outcome).toBe('not_same_user');
    expect(deps.revokeByHash).not.toHaveBeenCalled();
  });

  it('swallows and logs when owner resolution throws (never fails the refresh)', async () => {
    const deps = makeDeps({
      getSessionOwnerId: vi.fn().mockRejectedValue(new Error('db down')),
    });

    const outcome = await retireReplacedSession('old-token', 'user-1', deps);

    expect(outcome).toBe('revoke_failed');
    expect(deps.revokeByHash).not.toHaveBeenCalled();
    expect(deps.logWarn).toHaveBeenCalledWith(
      'Failed to retire replaced session on device refresh',
      expect.objectContaining({ error: 'db down' }),
    );
  });

  it('swallows and logs when the revoke itself throws', async () => {
    const deps = makeDeps({
      revokeByHash: vi.fn().mockRejectedValue('boom'),
    });

    const outcome = await retireReplacedSession('old-token', 'user-1', deps);

    expect(outcome).toBe('revoke_failed');
    expect(deps.logWarn).toHaveBeenCalledWith(
      'Failed to retire replaced session on device refresh',
      expect.objectContaining({ error: 'boom' }),
    );
  });
});
