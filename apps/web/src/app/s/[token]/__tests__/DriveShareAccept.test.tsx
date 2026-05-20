import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, screen, fireEvent, waitFor } from '@testing-library/react';

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
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ type: 'drive', driveId: 'drive-fallback' }),
    } as Response);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Given auth is loading, should show spinner and not redirect', () => {
    vi.mocked(useAuth).mockReturnValue({ isAuthenticated: false, isLoading: true } as ReturnType<typeof useAuth>);

    render(<DriveShareAccept token="tok" info={INFO} />);

    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByText(/joining/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /join/i })).not.toBeInTheDocument();
  });

  it('Given unauthenticated user after auth loads, should show invite landing page without redirecting', async () => {
    vi.mocked(useAuth).mockReturnValue({ isAuthenticated: false, isLoading: false } as ReturnType<typeof useAuth>);

    render(<DriveShareAccept token="tok-abc" info={INFO} />);

    await act(async () => {});

    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /join/i })).toBeEnabled();
  });

  it('Given unauthenticated user clicks Join, should redirect to signin with next param', async () => {
    vi.mocked(useAuth).mockReturnValue({ isAuthenticated: false, isLoading: false } as ReturnType<typeof useAuth>);

    render(<DriveShareAccept token="tok-abc" info={INFO} />);

    fireEvent.click(screen.getByRole('button', { name: /join/i }));

    expect(pushMock).toHaveBeenCalledWith('/auth/signin?next=%2Fs%2Ftok-abc');
  });

  it('Given authenticated user, when CSRF fails to load, should show error state not an infinite spinner', () => {
    vi.mocked(useAuth).mockReturnValue({ isAuthenticated: true, isLoading: false } as ReturnType<typeof useAuth>);
    vi.mocked(useCSRFToken).mockReturnValue({ ...csrfBase, isLoading: false, error: 'Failed to fetch CSRF token' });

    render(<DriveShareAccept token="tok" info={INFO} />);

    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/joining/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to dashboard/i })).toBeInTheDocument();
  });

  it('Given authenticated user with CSRF token, should auto-POST accept and redirect to dashboard', async () => {
    vi.mocked(useAuth).mockReturnValue({ isAuthenticated: true, isLoading: false } as ReturnType<typeof useAuth>);
    vi.mocked(useCSRFToken).mockReturnValue({ ...csrfBase, csrfToken: 'csrf-tok' });
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ type: 'drive', driveId: 'drive-123' }),
    } as Response);

    render(<DriveShareAccept token="tok-abc" info={INFO} />);

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/dashboard/drive-123'));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/share/tok-abc/accept',
      expect.objectContaining({ method: 'POST', headers: { 'x-csrf-token': 'csrf-tok' } })
    );
  });

  it('Given authenticated user with CSRF token, when accept returns non-ok, should show server error', async () => {
    vi.mocked(useAuth).mockReturnValue({ isAuthenticated: true, isLoading: false } as ReturnType<typeof useAuth>);
    vi.mocked(useCSRFToken).mockReturnValue({ ...csrfBase, csrfToken: 'csrf-tok' });
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Invite link has expired' }),
    } as Response);

    render(<DriveShareAccept token="tok-abc" info={INFO} />);

    await waitFor(() => expect(screen.getByText(/invite link has expired/i)).toBeInTheDocument());
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('Given authenticated user with CSRF token, when accept throws, should show generic error', async () => {
    vi.mocked(useAuth).mockReturnValue({ isAuthenticated: true, isLoading: false } as ReturnType<typeof useAuth>);
    vi.mocked(useCSRFToken).mockReturnValue({ ...csrfBase, csrfToken: 'csrf-tok' });
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

    render(<DriveShareAccept token="tok-abc" info={INFO} />);

    await waitFor(() => expect(screen.getByRole('link', { name: /go to dashboard/i })).toBeInTheDocument());
    expect(pushMock).not.toHaveBeenCalled();
  });
});
