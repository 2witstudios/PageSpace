import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/hooks/useCSRFToken', () => ({
  useCSRFToken: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    <a href={href}>{children}</a>,
}));

import { useAuth } from '@/hooks/useAuth';
import { useCSRFToken } from '@/hooks/useCSRFToken';
import { DriveShareAccept } from '../DriveShareAccept';

const INFO = { type: 'drive' as const, linkId: 'l1', driveId: 'd1', driveName: 'My Drive', creatorName: 'Alice', role: 'MEMBER' as const, expiresAt: null, useCount: 0 };

describe('DriveShareAccept', () => {
  const csrfBase = { csrfToken: null, isLoading: false, error: null, refreshToken: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCSRFToken).mockReturnValue(csrfBase);
  });

  it('Given auth is loading, should not redirect', () => {
    vi.mocked(useAuth).mockReturnValue({ isAuthenticated: false, isLoading: true } as ReturnType<typeof useAuth>);

    render(<DriveShareAccept token="tok" info={INFO} />);

    expect(pushMock).not.toHaveBeenCalled();
  });

  it('Given unauthenticated user after auth loads, should redirect to signin', async () => {
    vi.mocked(useAuth).mockReturnValue({ isAuthenticated: false, isLoading: false } as ReturnType<typeof useAuth>);

    render(<DriveShareAccept token="tok-abc" info={INFO} />);

    await act(async () => {});

    expect(pushMock).toHaveBeenCalledWith('/auth/signin?next=/s/tok-abc');
  });

  it('Given authenticated user, should not redirect even if csrfToken is null', () => {
    vi.mocked(useAuth).mockReturnValue({ isAuthenticated: true, isLoading: false } as ReturnType<typeof useAuth>);
    vi.mocked(useCSRFToken).mockReturnValue({ ...csrfBase, error: 'csrf error' });

    render(<DriveShareAccept token="tok" info={INFO} />);

    expect(pushMock).not.toHaveBeenCalled();
  });
});
