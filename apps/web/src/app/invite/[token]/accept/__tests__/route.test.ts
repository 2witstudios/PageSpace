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

const { pipeInner, pipeFactory } = vi.hoisted(() => {
  const inner = vi.fn();
  return { pipeInner: inner, pipeFactory: vi.fn(() => inner) };
});
vi.mock('@pagespace/lib/services/invites', () => ({
  acceptInviteForExistingUser: pipeFactory,
}));

vi.mock('@/lib/auth/invite-acceptance-adapters', () => ({
  buildAcceptancePorts: vi.fn(() => ({})),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { GET } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

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
  pipeFactory.mockReturnValue(pipeInner);
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
    expect(decodeURIComponent(location.split('next=')[1] ?? '')).toContain(
      '/invite/ps_invite_abc/accept',
    );
  });

  it('given a session whose user record cannot be found, redirects to dashboard with TOKEN_NOT_FOUND and never invokes the pipe', async () => {
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_ghost'));
    vi.mocked(driveInviteRepository.findUserVerificationStatusById).mockResolvedValue(null as never);

    const response = await GET(buildGet('tok'), ctx('tok'));

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('/dashboard?inviteError=TOKEN_NOT_FOUND');
    expect(pipeInner).not.toHaveBeenCalled();
  });

  it('given a successful acceptance, redirects to /dashboard/<driveId>?invited=1 and forwards suspendedAt to the pipe', async () => {
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_existing'));
    pipeInner.mockResolvedValue({
      ok: true,
      data: {
        memberId: 'mem_new',
        driveId: 'drive_abc',
        driveName: 'Alpha',
        role: 'MEMBER',
        invitedUserId: 'user_existing',
        inviterUserId: 'user_inviter',
        inviteId: 'inv_1',
        inviteEmail: 'invitee@example.com',
      },
    });

    const response = await GET(buildGet('tok'), ctx('tok'));

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(
      'https://app.example.com/dashboard/drive_abc?invited=1',
    );
    expect(pipeInner).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'tok',
        userId: 'user_existing',
        userEmail: 'invitee@example.com',
        suspendedAt: null,
        now: expect.any(Date),
      }),
    );
  });

  it('given EMAIL_MISMATCH from the pipe, redirects to /dashboard?inviteError=EMAIL_MISMATCH', async () => {
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_a'));
    pipeInner.mockResolvedValue({ ok: false, error: 'EMAIL_MISMATCH' });

    const response = await GET(buildGet('tok'), ctx('tok'));

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(
      'https://app.example.com/dashboard?inviteError=EMAIL_MISMATCH',
    );
  });

  it('given a suspended account, the pipe receives suspendedAt and returns ACCOUNT_SUSPENDED (no consume)', async () => {
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_suspended'));
    vi.mocked(driveInviteRepository.findUserVerificationStatusById).mockResolvedValue({
      email: 'invitee@example.com',
      emailVerified: new Date('2025-01-01'),
      suspendedAt: new Date('2026-01-01'),
    } as never);
    pipeInner.mockResolvedValue({ ok: false, error: 'ACCOUNT_SUSPENDED' });

    const response = await GET(buildGet('tok'), ctx('tok'));

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(
      'https://app.example.com/dashboard?inviteError=ACCOUNT_SUSPENDED',
    );
    expect(pipeInner).toHaveBeenCalledWith(
      expect.objectContaining({ suspendedAt: new Date('2026-01-01') }),
    );
  });

  it('given ALREADY_MEMBER, redirects to /dashboard?inviteError=ALREADY_MEMBER', async () => {
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_dup'));
    pipeInner.mockResolvedValue({ ok: false, error: 'ALREADY_MEMBER' });

    const response = await GET(buildGet('tok'), ctx('tok'));

    expect(response.headers.get('Location')).toBe(
      'https://app.example.com/dashboard?inviteError=ALREADY_MEMBER',
    );
  });
});
