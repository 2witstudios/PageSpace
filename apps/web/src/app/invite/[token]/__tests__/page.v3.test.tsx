import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock('@/lib/auth/invite-resolver', () => ({
  resolveInviteContext: vi.fn(),
}));

import InvitePage from '../page';
import { resolveInviteContext } from '@/lib/auth/invite-resolver';

const renderPage = async () => {
  const element = await InvitePage({ params: Promise.resolve({ token: 'tok' }) });
  return render(element);
};

describe('InvitePage v3 branch', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('Given Imago is enabled and a drive invite, should render the v3 frame and card', async () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
    vi.mocked(resolveInviteContext).mockResolvedValue({
      ok: true,
      data: { kind: 'drive', driveName: 'Studio', inviterName: 'Jono', role: 'MEMBER', email: 'a@b.c', isExistingUser: true },
    });

    await renderPage();

    expect(screen.getByTestId('auth-frame-spine')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'You’re invited to Studio' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in to join' })).toBeInTheDocument();
  });

  it('Given Imago is enabled and an invalid token, should render the v3 invalid card', async () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
    vi.mocked(resolveInviteContext).mockResolvedValue({ ok: false, error: 'NOT_FOUND' });

    await renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'This invite is no longer valid' })).toBeInTheDocument();
    expect(screen.getByTestId('auth-frame-spine')).toBeInTheDocument();
  });

  it('Given Imago is off, should keep the classic invite markup', async () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', undefined);
    vi.mocked(resolveInviteContext).mockResolvedValue({
      ok: true,
      data: { kind: 'drive', driveName: 'Studio', inviterName: 'Jono', role: 'MEMBER', email: 'a@b.c', isExistingUser: false },
    });

    await renderPage();

    expect(screen.queryByTestId('auth-frame-spine')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create account & join' })).toBeInTheDocument();
  });
});
