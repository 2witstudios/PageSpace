import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { InviteCardV3 } from '../InviteCardV3';
import type { InviteResolution } from '@/lib/auth/invite-resolver';

const EMAIL = 'lena@studio.example';

const driveOk = (isExistingUser: boolean): InviteResolution => ({
  ok: true,
  data: {
    kind: 'drive',
    driveName: 'Studio',
    inviterName: 'Jono',
    role: 'MEMBER',
    email: EMAIL,
    isExistingUser,
  },
});

describe('InviteCardV3', () => {
  afterEach(() => vi.clearAllMocks());

  it('Given a drive invite for a new user, should show the drive heading, body, ToS and Create account & join', () => {
    render(<InviteCardV3 resolution={driveOk(false)} token="tok" />);

    expect(screen.getByRole('heading', { level: 1, name: 'You’re invited to Studio' })).toBeInTheDocument();
    expect(screen.getByText('Jono', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText(EMAIL, { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('member', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText(/By continuing, you agree to PageSpace’s/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create account & join' })).toHaveAttribute(
      'href',
      '/auth/signup?invite=tok',
    );
  });

  it('Given a drive invite for an existing user, should switch the CTA to Sign in to join', () => {
    render(<InviteCardV3 resolution={driveOk(true)} token="tok" />);

    expect(screen.getByRole('link', { name: 'Sign in to join' })).toHaveAttribute('href', '/auth/signin?invite=tok');
    expect(screen.queryByRole('link', { name: 'Create account & join' })).not.toBeInTheDocument();
  });

  it('Given any valid invite, should show the Not {email}? sign-out footnote', () => {
    render(<InviteCardV3 resolution={driveOk(false)} token="tok" />);

    expect(
      screen.getByText(`Not ${EMAIL}? Sign out of any other account first, then return to this link.`),
    ).toBeInTheDocument();
  });

  it('Given a page invite, should show the shared-page heading and body, and switch the CTA on isExistingUser', () => {
    const page = (isExistingUser: boolean): InviteResolution => ({
      ok: true,
      data: {
        kind: 'page',
        pageTitle: 'Q4 Launch Plan',
        driveName: 'Studio',
        inviterName: 'Jono',
        permissions: [],
        email: 'marcus@kimdesign.example',
        isExistingUser,
      },
    });

    const { unmount } = render(<InviteCardV3 resolution={page(true)} token="tok" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Jono has shared a page with you' })).toBeInTheDocument();
    expect(screen.getByText('“Q4 Launch Plan”', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in to access' })).toHaveAttribute('href', '/auth/signin?invite=tok');
    unmount();

    render(<InviteCardV3 resolution={page(false)} token="tok" />);
    expect(screen.getByRole('link', { name: 'Create account & access' })).toHaveAttribute('href', '/auth/signup?invite=tok');
  });

  it('Given a connection invite, should show the connect heading and switch the CTA on isExistingUser', () => {
    const conn = (isExistingUser: boolean): InviteResolution => ({
      ok: true,
      data: { kind: 'connection', inviterName: 'Dana', email: 'marcus@kimdesign.example', isExistingUser, message: null },
    });

    const { unmount } = render(<InviteCardV3 resolution={conn(true)} token="tok" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Dana wants to connect with you' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in to connect' })).toBeInTheDocument();
    unmount();

    render(<InviteCardV3 resolution={conn(false)} token="tok" />);
    expect(screen.getByRole('link', { name: 'Create account & connect' })).toBeInTheDocument();
  });

  it('Given an expired or consumed token, should show the invalid card with Go to sign in', () => {
    render(<InviteCardV3 resolution={{ ok: false, error: 'EXPIRED' }} token="tok" />);

    expect(screen.getByRole('heading', { level: 1, name: 'This invite is no longer valid' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/auth/signin');
  });
});
