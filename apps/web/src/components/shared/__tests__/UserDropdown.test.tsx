/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Radix dropdown content is portalled; `forceMount` on the content keeps it in
// the tree, but the trigger still needs a pointer-capable environment. Mock the
// menu primitives down to plain elements so the label is always rendered.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    DropdownMenu: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: Passthrough,
    DropdownMenuLabel: Passthrough,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuSub: Passthrough,
    DropdownMenuSubContent: Passthrough,
    DropdownMenuSubTrigger: Passthrough,
    DropdownMenuPortal: Passthrough,
  };
});

const mockUseAuth = vi.fn();
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mockUseAuth() }));

const mockUseSWR = vi.fn();
vi.mock('swr', () => ({ default: (...args: unknown[]) => mockUseSWR(...args) }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ setTheme: vi.fn() }) }));
vi.mock('@/hooks/useBillingVisibility', () => ({
  useBillingVisibility: () => ({ showBilling: true, hideBilling: false, isReady: true }),
}));
vi.mock('@/hooks/useCreditBalance', () => ({ useCreditBalance: () => ({ balance: null }) }));
vi.mock('@/lib/deployment-mode', () => ({ isOnPrem: () => false }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../FeedbackDialog', () => ({ FeedbackDialog: () => null }));

import UserDropdown from '../UserDropdown';

const authUser = (subscriptionTier?: string) => ({
  isAuthenticated: true,
  isLoading: false,
  user: { id: 'u1', name: 'Test', email: 't@example.com', subscriptionTier },
  actions: { logout: vi.fn(), refreshAuth: vi.fn(), checkAuth: vi.fn() },
});

const billingLabel = () => screen.getByText(/^Billing \(/).textContent;

describe('UserDropdown billing tier label', () => {
  beforeEach(() => {
    mockUseAuth.mockReset();
    mockUseSWR.mockReset();
  });

  it('shows Free while the subscription status fetch is still loading (auth says free)', () => {
    mockUseAuth.mockReturnValue(authUser('free'));
    mockUseSWR.mockReturnValue({ data: undefined });
    render(<UserDropdown />);
    expect(billingLabel()).toBe('Billing (Free)');
  });

  it('shows Free when neither the fetch nor the auth user carry a tier', () => {
    mockUseAuth.mockReturnValue(authUser(undefined));
    mockUseSWR.mockReturnValue({ data: undefined });
    render(<UserDropdown />);
    expect(billingLabel()).toBe('Billing (Free)');
  });

  it('shows Free when the fetch failed', () => {
    mockUseAuth.mockReturnValue(authUser(undefined));
    mockUseSWR.mockReturnValue({ data: undefined, error: new Error('Failed to fetch: 500') });
    render(<UserDropdown />);
    expect(billingLabel()).toBe('Billing (Free)');
  });

  it('shows Founder for the founder tier', () => {
    mockUseAuth.mockReturnValue(authUser('free'));
    mockUseSWR.mockReturnValue({ data: { subscriptionTier: 'founder' } });
    render(<UserDropdown />);
    expect(billingLabel()).toBe('Billing (Founder)');
  });

  it('shows Business only for the business tier', () => {
    mockUseAuth.mockReturnValue(authUser('free'));
    mockUseSWR.mockReturnValue({ data: { subscriptionTier: 'business' } });
    render(<UserDropdown />);
    expect(billingLabel()).toBe('Billing (Business)');
  });

  it('prefers the fresh fetch over the auth snapshot after an upgrade', () => {
    mockUseAuth.mockReturnValue(authUser('free'));
    mockUseSWR.mockReturnValue({ data: { subscriptionTier: 'pro' } });
    render(<UserDropdown />);
    expect(billingLabel()).toBe('Billing (Pro)');
  });

  it('coerces an unknown stored tier value to Free instead of Business', () => {
    mockUseAuth.mockReturnValue(authUser('free'));
    mockUseSWR.mockReturnValue({ data: { subscriptionTier: 'enterprise-legacy' } });
    render(<UserDropdown />);
    expect(billingLabel()).toBe('Billing (Free)');
  });
});
