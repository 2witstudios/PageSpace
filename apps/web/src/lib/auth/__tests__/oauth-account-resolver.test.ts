import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserByGoogleId: vi.fn(),
    findUserByAppleId: vi.fn(),
    findUserByEmail: vi.fn(),
  },
}));

import { resolveOAuthAccount } from '../oauth-account-resolver';
import { authRepository } from '@/lib/repositories/auth-repository';

const subUser = { id: 'sub-user', email: 'a@example.com', googleId: 'g-1', appleId: null } as never;
const emailUser = { id: 'email-user', email: 'a@example.com', googleId: null, appleId: null } as never;

describe('resolveOAuthAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authRepository.findUserByGoogleId).mockResolvedValue(null);
    vi.mocked(authRepository.findUserByAppleId).mockResolvedValue(null);
    vi.mocked(authRepository.findUserByEmail).mockResolvedValue(null);
  });

  it('returns use-sub and the subject account when the provider id matches (Google)', async () => {
    vi.mocked(authRepository.findUserByGoogleId).mockResolvedValue(subUser);
    const res = await resolveOAuthAccount({ provider: 'google', providerId: 'g-1', email: 'a@example.com', emailVerified: false });
    expect(res.decision).toBe('use-sub');
    expect(res.user).toBe(subUser);
    expect(authRepository.findUserByGoogleId).toHaveBeenCalledWith('g-1');
    expect(authRepository.findUserByAppleId).not.toHaveBeenCalled();
  });

  it('returns use-email when only a verified email matches', async () => {
    vi.mocked(authRepository.findUserByEmail).mockResolvedValue(emailUser);
    const res = await resolveOAuthAccount({ provider: 'google', providerId: 'g-x', email: 'a@example.com', emailVerified: true });
    expect(res.decision).toBe('use-email');
    expect(res.user).toBe(emailUser);
  });

  it('returns reject (and exposes the email match for auditing) when an unverified email collides', async () => {
    vi.mocked(authRepository.findUserByEmail).mockResolvedValue(emailUser);
    const res = await resolveOAuthAccount({ provider: 'google', providerId: 'g-x', email: 'a@example.com', emailVerified: false });
    expect(res.decision).toBe('reject');
    expect(res.user).toBeNull();
    expect(res.emailMatch).toBe(emailUser);
  });

  it('returns create-new when nothing matches', async () => {
    const res = await resolveOAuthAccount({ provider: 'google', providerId: 'g-x', email: 'new@example.com', emailVerified: false });
    expect(res.decision).toBe('create-new');
    expect(res.user).toBeNull();
  });

  it('uses the Apple subject lookup for the apple provider', async () => {
    vi.mocked(authRepository.findUserByAppleId).mockResolvedValue(subUser);
    const res = await resolveOAuthAccount({ provider: 'apple', providerId: 'ap-1', email: 'a@example.com', emailVerified: false });
    expect(res.decision).toBe('use-sub');
    expect(authRepository.findUserByAppleId).toHaveBeenCalledWith('ap-1');
    expect(authRepository.findUserByGoogleId).not.toHaveBeenCalled();
  });
});
