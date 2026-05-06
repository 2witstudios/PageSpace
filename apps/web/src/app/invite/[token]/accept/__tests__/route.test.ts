import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/lib/repositories/drive-invite-repository', () => ({
  driveInviteRepository: {
    findUserVerificationStatusById: vi.fn(),
  },
}));

vi.mock('@/lib/auth/invite-acceptance', () => ({
  acceptInviteForExistingUser: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { GET } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { acceptInviteForExistingUser } from '@/lib/auth/invite-acceptance';

const buildGet = (token: string) =>
  new Request(`https://app.example.com/invite/${token}/accept`);

const ctx = (token: string) => ({ params: Promise.resolve({ token }) });

const session = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess_1',
  role: 'user',
  adminRoleVersion: 0,
});

const authError: AuthError = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(driveInviteRepository.findUserVerificationStatusById).mockResolvedValue({
    email: 'invitee@example.com',
    emailVerified: new Date('2025-01-01'),
    suspendedAt: null,
  } as never);
});

describe('GET /invite/[token]/accept', () => {
  it('given no session, redirects to /auth/signin with invite + next params (303 see-other)', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(authError);

    const response = await GET(buildGet('ps_invite_abc'), ctx('ps_invite_abc'));

    expect(response.status).toBe(303);
    const location = response.headers.get('Location') ?? '';
    expect(location).toContain('/auth/signin?invite=ps_invite_abc');
    expect(location).toContain('next=');
    // next= is URL-encoded so the consuming flow can round-trip it.
    expect(decodeURIComponent(location.split('next=')[1] ?? '')).toContain(
      '/invite/ps_invite_abc/accept',
    );
  });

  it('given a session whose user record cannot be found, redirects to dashboard with TOKEN_NOT_FOUND', async () => {
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_ghost'));
    vi.mocked(driveInviteRepository.findUserVerificationStatusById).mockResolvedValue(null as never);

    const response = await GET(buildGet('tok'), ctx('tok'));

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('/dashboard?inviteError=TOKEN_NOT_FOUND');
    expect(acceptInviteForExistingUser).not.toHaveBeenCalled();
  });

  it('given a successful acceptance, redirects to /dashboard/<driveId>?invited=1', async () => {
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_existing'));
    vi.mocked(acceptInviteForExistingUser).mockResolvedValue({
      ok: true,
      data: { driveId: 'drive_abc', driveName: 'Alpha', memberId: 'mem_new' },
    });

    const response = await GET(buildGet('tok'), ctx('tok'));

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(
      'https://app.example.com/dashboard/drive_abc?invited=1',
    );
    expect(acceptInviteForExistingUser).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'tok',
        userId: 'user_existing',
        userEmail: 'invitee@example.com',
        now: expect.any(Date),
      }),
    );
  });

  it('given EMAIL_MISMATCH, redirects to /dashboard?inviteError=EMAIL_MISMATCH', async () => {
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_a'));
    vi.mocked(acceptInviteForExistingUser).mockResolvedValue({
      ok: false,
      error: 'EMAIL_MISMATCH',
    });

    const response = await GET(buildGet('tok'), ctx('tok'));

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(
      'https://app.example.com/dashboard?inviteError=EMAIL_MISMATCH',
    );
  });

  it('given ALREADY_MEMBER, redirects to /dashboard?inviteError=ALREADY_MEMBER', async () => {
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_dup'));
    vi.mocked(acceptInviteForExistingUser).mockResolvedValue({
      ok: false,
      error: 'ALREADY_MEMBER',
    });

    const response = await GET(buildGet('tok'), ctx('tok'));

    expect(response.headers.get('Location')).toBe(
      'https://app.example.com/dashboard?inviteError=ALREADY_MEMBER',
    );
  });
});
