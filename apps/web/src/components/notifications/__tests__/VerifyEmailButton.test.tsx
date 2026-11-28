/**
 * The header's verification slot: unchanged for humans; an unclaimed agent
 * sees the unfunded notice instead (Agent Signup Phase 3, US4).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useAuthStore } from '@/stores/useAuthStore';
import VerifyEmailButton from '../VerifyEmailButton';

type StoreUser = NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;
const setUser = (user: Partial<StoreUser> | null) =>
  useAuthStore.setState({ user: user === null ? null : ({ id: 'u1', name: 'U', email: 'u@example.com', ...user } as StoreUser) });

const UNFUNDED = 'This agent has no AI credits — share your claim link to get funded';

describe('VerifyEmailButton', () => {
  beforeEach(() => setUser(null));

  it('given no user, should render nothing', () => {
    const { container } = render(<VerifyEmailButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it('given an unverified human, should still link to Verify Email', () => {
    setUser({ emailVerified: null, accountType: 'human' });
    render(<VerifyEmailButton />);
    expect(screen.getByRole('link')).toHaveTextContent('Verify Email');
    expect(screen.queryByText(UNFUNDED)).not.toBeInTheDocument();
  });

  it('given a verified human, should render nothing', () => {
    setUser({ emailVerified: new Date(), accountType: 'human' });
    const { container } = render(<VerifyEmailButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it('given an unclaimed agent, should show the unfunded notice linking to the identity card instead of Verify Email', () => {
    setUser({ emailVerified: null, accountType: 'agent', agent: { ownerUserId: null, claimedAt: null, source: null } });
    render(<VerifyEmailButton />);
    const notice = screen.getByTestId('agent-unfunded-notice');
    expect(notice).toHaveAttribute('href', '/settings/account#agent-identity');
    expect(screen.getByText(UNFUNDED)).toBeInTheDocument();
    expect(screen.queryByText('Verify Email')).not.toBeInTheDocument();
  });

  it('given a claimed agent, should render nothing', () => {
    setUser({ emailVerified: new Date(), accountType: 'agent', agent: { ownerUserId: 'h1', claimedAt: '2026-11-01T00:00:00Z', source: null } });
    const { container } = render(<VerifyEmailButton />);
    expect(container).toBeEmptyDOMElement();
  });
});
