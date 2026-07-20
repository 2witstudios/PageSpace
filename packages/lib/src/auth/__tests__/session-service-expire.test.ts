import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../session-repository', () => ({
  sessionRepository: {
    findUserById: vi.fn(),
    findActiveSession: vi.fn(),
    getActiveSessionExpiry: vi.fn(),
    setExpiresAtByHash: vi.fn(),
    insertSession: vi.fn(),
    touchSession: vi.fn(),
    revokeByHash: vi.fn(),
    revokeAllForUser: vi.fn(),
    revokeWebForUser: vi.fn(),
    revokeAdminForUser: vi.fn(),
    revokeForUserDevice: vi.fn(),
    deleteExpired: vi.fn(),
  },
}));

vi.mock('../opaque-tokens', () => ({
  generateOpaqueToken: vi.fn(),
  isValidTokenFormat: vi.fn(),
}));

vi.mock('../token-utils', () => ({
  hashToken: vi.fn((t: string) => `hashed_${t}`),
}));

vi.mock('../constants', () => ({
  IDLE_TIMEOUT_MS: 0,
}));

import { SessionService, clampExpiry } from '../session-service';
import { sessionRepository } from '../session-repository';

describe('clampExpiry (pure)', () => {
  it('returns now+grace target when the current expiry is later (clamps down)', () => {
    const current = new Date('2030-01-01T01:00:00.000Z');
    const target = new Date('2030-01-01T00:01:00.000Z');
    expect(clampExpiry(current, target)).toBe(target);
  });

  it('returns the current expiry when it is already sooner (never extends)', () => {
    const current = new Date('2030-01-01T00:00:10.000Z');
    const target = new Date('2030-01-01T00:01:00.000Z');
    expect(clampExpiry(current, target)).toBe(current);
  });

  it('returns the current expiry when the two are equal (boundary, no extend)', () => {
    const current = new Date('2030-01-01T00:01:00.000Z');
    const target = new Date('2030-01-01T00:01:00.000Z');
    expect(clampExpiry(current, target)).toBe(current);
  });
});

describe('SessionService.expireSessionByHashSoon', () => {
  let service: SessionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SessionService();
  });

  it('clamps a longer-lived session down to now+grace', async () => {
    const now = Date.now();
    vi.mocked(sessionRepository.getActiveSessionExpiry).mockResolvedValue(
      new Date(now + 60 * 60 * 1000), // expires in 1h
    );

    await service.expireSessionByHashSoon('hash-1', 60_000);

    expect(sessionRepository.setExpiresAtByHash).toHaveBeenCalledTimes(1);
    const [tokenHash, clamped] = vi.mocked(sessionRepository.setExpiresAtByHash).mock.calls[0];
    expect(tokenHash).toBe('hash-1');
    // Clamped to ~now+grace, never the original 1h expiry.
    expect(clamped.getTime()).toBeGreaterThanOrEqual(now + 60_000 - 1000);
    expect(clamped.getTime()).toBeLessThanOrEqual(now + 60_000 + 1000);
  });

  it('never extends a session already expiring sooner than now+grace', async () => {
    const now = Date.now();
    vi.mocked(sessionRepository.getActiveSessionExpiry).mockResolvedValue(
      new Date(now + 5_000), // expires in 5s, sooner than the 60s grace
    );

    await service.expireSessionByHashSoon('hash-1', 60_000);

    expect(sessionRepository.setExpiresAtByHash).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no active session for the hash', async () => {
    vi.mocked(sessionRepository.getActiveSessionExpiry).mockResolvedValue(undefined);

    await expect(service.expireSessionByHashSoon('hash-missing', 60_000)).resolves.toBeUndefined();

    expect(sessionRepository.setExpiresAtByHash).not.toHaveBeenCalled();
  });
});
