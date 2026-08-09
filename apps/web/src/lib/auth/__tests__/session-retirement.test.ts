import { describe, it, expect, vi } from 'vitest';
import {
  retireReplacedSession,
  type SessionRetirementDeps,
} from '../session-retirement';

const makeDeps = (overrides: Partial<SessionRetirementDeps> = {}): SessionRetirementDeps => ({
  getSessionOwnerId: vi.fn().mockResolvedValue('user-1'),
  hashToken: vi.fn((t: string) => `hash(${t})`),
  graceExpireByHash: vi.fn().mockResolvedValue(undefined),
  logWarn: vi.fn(),
  ...overrides,
});

describe('retireReplacedSession', () => {
  it('returns no_session_cookie and grace-expires nothing when no old token is present', async () => {
    const deps = makeDeps();

    expect(await retireReplacedSession(null, 'user-1', deps)).toBe('no_session_cookie');
    expect(await retireReplacedSession(undefined, 'user-1', deps)).toBe('no_session_cookie');
    expect(await retireReplacedSession('', 'user-1', deps)).toBe('no_session_cookie');

    expect(deps.getSessionOwnerId).not.toHaveBeenCalled();
    expect(deps.graceExpireByHash).not.toHaveBeenCalled();
  });

  it('grace-expires the old session by hash when it belongs to the same user', async () => {
    const deps = makeDeps();

    const outcome = await retireReplacedSession('old-token', 'user-1', deps);

    expect(outcome).toBe('grace_expired');
    expect(deps.hashToken).toHaveBeenCalledWith('old-token');
    expect(deps.graceExpireByHash).toHaveBeenCalledWith('hash(old-token)');
    expect(deps.logWarn).not.toHaveBeenCalled();
  });

  it('does NOT grace-expire when the old session belongs to a different user', async () => {
    const deps = makeDeps({ getSessionOwnerId: vi.fn().mockResolvedValue('other-user') });

    const outcome = await retireReplacedSession('old-token', 'user-1', deps);

    expect(outcome).toBe('not_same_user');
    expect(deps.graceExpireByHash).not.toHaveBeenCalled();
  });

  it('does NOT grace-expire when the old session resolves to no owner (inactive/expired)', async () => {
    const deps = makeDeps({ getSessionOwnerId: vi.fn().mockResolvedValue(null) });

    const outcome = await retireReplacedSession('old-token', 'user-1', deps);

    expect(outcome).toBe('not_same_user');
    expect(deps.graceExpireByHash).not.toHaveBeenCalled();
  });

  it('swallows and logs when owner resolution throws (never fails the refresh)', async () => {
    const deps = makeDeps({
      getSessionOwnerId: vi.fn().mockRejectedValue(new Error('db down')),
    });

    const outcome = await retireReplacedSession('old-token', 'user-1', deps);

    expect(outcome).toBe('grace_expiry_failed');
    expect(deps.graceExpireByHash).not.toHaveBeenCalled();
    expect(deps.logWarn).toHaveBeenCalledWith(
      'Failed to retire replaced session on device refresh',
      expect.objectContaining({ error: 'db down' }),
    );
  });

  it('swallows and logs when the grace-expiry itself throws', async () => {
    const deps = makeDeps({
      graceExpireByHash: vi.fn().mockRejectedValue('boom'),
    });

    const outcome = await retireReplacedSession('old-token', 'user-1', deps);

    expect(outcome).toBe('grace_expiry_failed');
    expect(deps.logWarn).toHaveBeenCalledWith(
      'Failed to retire replaced session on device refresh',
      expect.objectContaining({ error: 'boom' }),
    );
  });
});
