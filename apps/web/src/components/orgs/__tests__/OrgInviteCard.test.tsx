import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/auth/auth-fetch';

const mocks = vi.hoisted(() => ({ push: vi.fn(), post: vi.fn(), logout: vi.fn(), assign: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ actions: { logout: mocks.logout } }) }));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/auth-fetch')>()),
  post: mocks.post,
}));

import { OrgInviteCard, type OrgInviteCardProps } from '../OrgInviteCard';
import { orgInviteCardModel, screenAfterAccept } from '@/lib/orgs/org-invite-view';
import type { OrgInviteView } from '@pagespace/lib/organizations/invite-view-core';

const TOKEN = 'ps_orginv_abc';
const props = (view: OrgInviteView, extra: { viewerEmail?: string | null } = {}): OrgInviteCardProps => ({
  token: TOKEN,
  model: orgInviteCardModel(view, {
    orgId: 'org_nw', orgName: 'Northwind Labs', inviterName: 'Jono', role: 'MEMBER',
    invitedEmail: 'tomas@northwind.test', viewerEmail: extra.viewerEmail ?? null,
  }),
});
const refusal = (code: string, status: number) => new ApiRequestError('refused', status, { code });

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { ...window.location, assign: mocks.assign }, writable: true });
});

describe('ORG-3 (partial) the org invitation page', () => {
  it('a signed-out visitor goes to sign up (no account) or sign in (existing account) with the token carried as ?invite=', () => {
    const { unmount } = render(<OrgInviteCard {...props('sign_up')} />);
    expect(screen.getByText(/invited/)).toHaveTextContent('Jono invited tomas@northwind.test to join as a member.');
    expect(screen.getByRole('link', { name: 'Create account & join' })).toHaveAttribute('href', `/auth/signup?invite=${TOKEN}`);
    unmount();
    render(<OrgInviteCard {...props('sign_in')} />);
    expect(screen.getByRole('link', { name: 'Sign in to join' })).toHaveAttribute('href', `/auth/signin?invite=${TOKEN}`);
  });

  it('the invited account accepts with one click and lands on the org hub', async () => {
    mocks.post.mockResolvedValue({ orgId: 'org_nw', role: 'MEMBER', joined: true });
    render(<OrgInviteCard {...props('accept')} />);
    await userEvent.click(screen.getByRole('button', { name: 'Join Northwind Labs' }));
    expect(mocks.post).toHaveBeenCalledWith('/api/orgs/invitations/accept', { token: TOKEN });
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/orgs/org_nw/settings'));
  });

  it('an acceptance refused in between (expired, wrong account, revoked, lapsed) shows that state; an existing member is told so', async () => {
    const cases: Array<[unknown, string]> = [
      [refusal('expired', 410), 'org-invite-expired'],
      [refusal('email_mismatch', 403), 'org-invite-wrong_account'],
      [refusal('not_found', 404), 'org-invite-invalid'],
      [refusal('org_lapsed', 402), 'org-invite-org_lapsed'],
    ];
    for (const [error, testId] of cases) {
      mocks.post.mockRejectedValueOnce(error);
      const { unmount } = render(<OrgInviteCard {...props('accept')} />);
      await userEvent.click(screen.getByRole('button', { name: 'Join Northwind Labs' }));
      expect(await screen.findByTestId(testId)).toBeInTheDocument();
      unmount();
    }
    mocks.post.mockResolvedValueOnce({ orgId: 'org_nw', role: 'MEMBER', joined: false });
    render(<OrgInviteCard {...props('accept')} />);
    await userEvent.click(screen.getByRole('button', { name: 'Join Northwind Labs' }));
    expect(await screen.findByText("You're already a member of Northwind Labs")).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('the wrong signed-in account is told whose invitation it is, and can sign out and come back to the same link', async () => {
    mocks.logout.mockResolvedValue(undefined);
    render(<OrgInviteCard {...props('wrong_account', { viewerEmail: 'marcus@northwind.test' })} />);
    expect(screen.getByTestId('org-invite-wrong_account')).toHaveTextContent("It was sent to tomas@northwind.test, but you're signed in as marcus@northwind.test");
    expect(screen.queryByRole('button', { name: /Join/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out and use another account' }));
    await waitFor(() => expect(mocks.assign).toHaveBeenCalledWith(`/invite/${TOKEN}`));
    expect(mocks.logout).toHaveBeenCalled();
  });

  it('expired, no longer valid and already-member links offer no way to join', () => {
    for (const view of ['expired', 'invalid'] as const) {
      const { unmount } = render(<OrgInviteCard {...props(view)} />);
      expect(screen.getByTestId(`org-invite-${view}`)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Join/ })).not.toBeInTheDocument();
      unmount();
    }
    render(<OrgInviteCard {...props('already_member')} />);
    expect(screen.getByRole('link', { name: 'Open Northwind Labs' })).toHaveAttribute('href', '/orgs/org_nw/settings');
  });

  it('screenAfterAccept maps every refusal code, and an unknown failure is not mistaken for a refusal', () => {
    expect(screenAfterAccept({ ok: true, orgId: 'o', joined: true })).toBe('joined');
    expect(screenAfterAccept({ ok: true, orgId: 'o', joined: false })).toBe('already_member');
    expect(screenAfterAccept({ ok: false, code: 'already_accepted' })).toBe('invalid');
    expect(screenAfterAccept({ ok: false, code: null })).toBe('failed');
  });
});
