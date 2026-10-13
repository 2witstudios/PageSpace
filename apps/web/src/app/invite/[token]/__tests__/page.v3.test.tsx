import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock('@/lib/auth/invite-resolver', () => ({
  resolveInviteContext: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ toString: (): string => 'session=test-session' })),
}));
vi.mock('@/lib/orgs/org-invite-page', () => ({ loadOrgInvitePage: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ actions: { logout: vi.fn() } }) }));

import InvitePage from '../page';
import { resolveInviteContext } from '@/lib/auth/invite-resolver';
import { loadOrgInvitePage } from '@/lib/orgs/org-invite-page';

const renderPage = async () => {
  const element = await InvitePage({ params: Promise.resolve({ token: 'tok' }) });
  return render(element);
};

describe('InvitePage v3 branch', () => {
  beforeEach(() => {
    vi.mocked(loadOrgInvitePage).mockResolvedValue(null);
  });

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

  it.each(['true', undefined])('Given an org invitation and Imago enabled=%s, should render its org card before the generic invalid card', async (enabled) => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', enabled);
    vi.mocked(resolveInviteContext).mockResolvedValue({ ok: false, error: 'NOT_FOUND' });
    vi.mocked(loadOrgInvitePage).mockResolvedValue({
      view: 'sign_in', orgName: 'Northwind Labs', inviterName: 'Jono', role: 'MEMBER', invitedEmail: 'a@b.c',
    });

    await renderPage();

    expect(loadOrgInvitePage).toHaveBeenCalledWith({ token: 'tok', cookieHeader: 'session=test-session', now: expect.any(Date) });
    expect(screen.getByTestId('org-invite-sign_in')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Join Northwind Labs' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in to join' })).toHaveAttribute('href', '/auth/signin?invite=tok');
    expect(screen.queryByRole('heading', { name: 'This invite is no longer valid' })).not.toBeInTheDocument();
    expect(Boolean(screen.queryByTestId('auth-frame-spine'))).toBe(enabled === 'true');
  });
});
