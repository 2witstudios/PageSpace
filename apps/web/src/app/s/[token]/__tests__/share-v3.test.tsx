import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock('@pagespace/lib/permissions/share-link-service', () => ({
  resolveShareToken: vi.fn(),
}));

import { useAuth } from '@/hooks/useAuth';
import { useCSRFToken } from '@/hooks/useCSRFToken';
import { resolveShareToken } from '@pagespace/lib/permissions/share-link-service';
import { DriveShareAccept } from '../DriveShareAccept';
import { PageShareAccept } from '../PageShareAccept';
import ShareLinkPage from '../page';

const DRIVE_INFO = { type: 'drive' as const, linkId: 'l1', driveId: 'd1', driveName: 'Studio', creatorName: 'Jono', role: 'MEMBER' as const, expiresAt: null, useCount: 0 };
const PAGE_INFO = { type: 'page' as const, linkId: 'l2', driveId: 'd1', pageId: 'p1', pageTitle: 'Q4 Launch Plan', driveName: 'Studio', creatorName: 'Jono', expiresAt: null, useCount: 0 };
const csrfBase = { csrfToken: null, isLoading: false, error: null, refreshToken: vi.fn() };

describe('share links, Imago enabled (v3)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', 'true');
    vi.mocked(useCSRFToken).mockReturnValue(csrfBase);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('DriveShareAccept', () => {
    it('Given drive link signed out, should show Join Studio, Sign in to join, Create an account and Not now', () => {
      vi.mocked(useAuth).mockReturnValue({ isAuthenticated: false, isLoading: false } as ReturnType<typeof useAuth>);

      render(<DriveShareAccept token="tok" info={DRIVE_INFO} />);

      expect(screen.getByRole('heading', { level: 1, name: 'Join Studio' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sign in to join' })).toBeEnabled();
      expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
        'href',
        '/auth/signup?next=%2Fs%2Ftok',
      );
      expect(screen.getByRole('link', { name: 'Not now' })).toHaveAttribute('href', '/imago');
    });

    it('Given drive link signed out, clicking Sign in to join should go to signin with next', () => {
      vi.mocked(useAuth).mockReturnValue({ isAuthenticated: false, isLoading: false } as ReturnType<typeof useAuth>);

      render(<DriveShareAccept token="tok" info={DRIVE_INFO} />);
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to join' }));

      expect(pushMock).toHaveBeenCalledWith('/auth/signin?next=%2Fs%2Ftok');
    });

    it('Given drive link signed in, should show the Joining Studio spinner copy', () => {
      vi.mocked(useAuth).mockReturnValue({ isAuthenticated: true, isLoading: false } as ReturnType<typeof useAuth>);
      vi.mocked(useCSRFToken).mockReturnValue({ ...csrfBase, isLoading: true });

      render(<DriveShareAccept token="tok" info={DRIVE_INFO} />);

      expect(screen.getByText('Studio', { selector: 'strong' })).toBeInTheDocument();
      expect(screen.getByText(/Joining/)).toHaveTextContent('Joining Studio…');
    });

    it('Given a successful accept, should navigate to /imago/{driveId}', async () => {
      vi.mocked(useAuth).mockReturnValue({ isAuthenticated: true, isLoading: false } as ReturnType<typeof useAuth>);
      vi.mocked(useCSRFToken).mockReturnValue({ ...csrfBase, csrfToken: 'csrf-tok' });
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ type: 'drive', driveId: 'drive-123' }),
      } as Response);

      render(<DriveShareAccept token="tok" info={DRIVE_INFO} />);

      await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/imago/drive-123'));
    });
  });

  describe('PageShareAccept', () => {
    it('Given page link signed out, should show You’re invited and Sign in to continue', () => {
      vi.mocked(useAuth).mockReturnValue({ isAuthenticated: false, isLoading: false } as ReturnType<typeof useAuth>);

      render(<PageShareAccept token="tok" info={PAGE_INFO} />);

      expect(screen.getByRole('heading', { level: 1, name: 'You’re invited' })).toBeInTheDocument();
      expect(screen.getByText('Q4 Launch Plan', { selector: 'strong' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to continue' }));
      expect(pushMock).toHaveBeenCalledWith('/auth/signin?next=/s/tok');
    });

    it('Given page link signed in, should show Opening Q4 Launch Plan…', () => {
      vi.mocked(useAuth).mockReturnValue({ isAuthenticated: true, isLoading: false } as ReturnType<typeof useAuth>);
      vi.mocked(useCSRFToken).mockReturnValue({ ...csrfBase, isLoading: true });

      render(<PageShareAccept token="tok" info={PAGE_INFO} />);

      expect(screen.getByText(/Opening/)).toHaveTextContent('Opening Q4 Launch Plan…');
    });

    it('Given a successful accept, should navigate to /imago/{driveId}/files/{pageId}', async () => {
      vi.mocked(useAuth).mockReturnValue({ isAuthenticated: true, isLoading: false } as ReturnType<typeof useAuth>);
      vi.mocked(useCSRFToken).mockReturnValue({ ...csrfBase, csrfToken: 'csrf-tok' });
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ type: 'page', pageId: 'p9', driveId: 'd9' }),
      } as Response);

      render(<PageShareAccept token="tok" info={PAGE_INFO} />);

      await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/imago/d9/files/p9'));
    });
  });

  describe('share link route', () => {
    it('Given a revoked link, should show the v3 no-longer-valid card with Go to dashboard', async () => {
      vi.mocked(resolveShareToken).mockResolvedValue(null);

      const element = await ShareLinkPage({ params: Promise.resolve({ token: 'dead' }) });
      render(element);

      expect(screen.getByRole('heading', { level: 1, name: 'This link is no longer valid' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Go to dashboard' })).toHaveAttribute('href', '/imago');
      expect(screen.getByTestId('auth-frame-spine')).toBeInTheDocument();
    });
  });
});
