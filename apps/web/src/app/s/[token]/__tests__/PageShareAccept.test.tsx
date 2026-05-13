import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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
import { PageShareAccept } from '../PageShareAccept';

const INFO = { type: 'page' as const, linkId: 'l1', driveId: 'd1', pageId: 'p1', pageTitle: 'My Page', driveName: 'Drive', creatorName: 'Bob', expiresAt: null, useCount: 0 };
const CSRF = 'csrf-tok';

describe('PageShareAccept', () => {
  const csrfBase = { csrfToken: null, isLoading: false, error: null, refreshToken: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ type: 'page', pageId: 'p1', driveId: 'd1' }),
    } as Response);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Given auth is loading, should not redirect', () => {
    vi.mocked(useAuth).mockReturnValue({ isAuthenticated: false, isLoading: true } as ReturnType<typeof useAuth>);
    vi.mocked(useCSRFToken).mockReturnValue({ ...csrfBase, isLoading: true });

    render(<PageShareAccept token="tok" info={INFO} />);

    expect(pushMock).not.toHaveBeenCalledWith(expect.stringContaining('signin'));
  });

  it('Given unauthenticated user after auth loads, should redirect to signin', async () => {
    vi.mocked(useAuth).mockReturnValue({ isAuthenticated: false, isLoading: false } as ReturnType<typeof useAuth>);
    vi.mocked(useCSRFToken).mockReturnValue(csrfBase);

    render(<PageShareAccept token="tok-xyz" info={INFO} />);

    await act(async () => {});

    expect(pushMock).toHaveBeenCalledWith('/auth/signin?next=/s/tok-xyz');
  });

  it('Given authenticated user with csrfToken, should POST accept and redirect to page', async () => {
    vi.mocked(useAuth).mockReturnValue({ isAuthenticated: true, isLoading: false } as ReturnType<typeof useAuth>);
    vi.mocked(useCSRFToken).mockReturnValue({ ...csrfBase, csrfToken: CSRF });

    render(<PageShareAccept token="tok-page" info={INFO} />);

    await act(async () => {});

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/share/tok-page/accept',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) })
    );
    expect(pushMock).toHaveBeenCalledWith('/dashboard/d1/p1');
  });

  it('Given component unmounts before accept resolves, should abort fetch', async () => {
    vi.mocked(useAuth).mockReturnValue({ isAuthenticated: true, isLoading: false } as ReturnType<typeof useAuth>);
    vi.mocked(useCSRFToken).mockReturnValue({ ...csrfBase, csrfToken: CSRF });

    let resolveAbort!: () => void;
    vi.spyOn(global, 'fetch').mockImplementationOnce((_url, init) => {
      return new Promise((resolve) => {
        resolveAbort = () => resolve({
          ok: true,
          json: async () => ({ type: 'page', pageId: 'p1', driveId: 'd1' }),
        } as Response);
        init?.signal?.addEventListener('abort', () => resolve({ ok: false } as Response));
      });
    });

    const { unmount } = render(<PageShareAccept token="tok" info={INFO} />);

    await act(async () => {
      unmount();
    });

    expect(pushMock).not.toHaveBeenCalled();
    resolveAbort();
  });
});
