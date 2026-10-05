/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Radix dropdown content is portalled; `forceMount` on the content keeps it in
// the tree, but the trigger still needs a pointer-capable environment. Mock the
// menu primitives down to plain elements so the label is always rendered.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    DropdownMenu: Passthrough,
    DropdownMenuContent: Passthrough,
    // asChild items render their child (e.g. a link) in place of the item.
    DropdownMenuItem: ({ children, asChild }: { children?: React.ReactNode; asChild?: boolean }) =>
      asChild ? <>{children}</> : <div>{children}</div>,
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
const mockIsOnPrem = vi.fn(() => false);
vi.mock('@/lib/deployment-mode', () => ({ isOnPrem: () => mockIsOnPrem() }));
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

describe('UserDropdown Try Imago item', () => {
  beforeEach(() => {
    mockUseAuth.mockReset();
    mockUseSWR.mockReset();
    mockUseAuth.mockReturnValue(authUser('free'));
    mockUseSWR.mockReturnValue({ data: undefined });
    mockIsOnPrem.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const tryImago = () => screen.queryByTestId('user-menu-try-imago');

  it('links to /imago when NEXT_PUBLIC_IMAGO_ENABLED is true', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
    render(<UserDropdown />);
    const item = tryImago();
    expect(item?.tagName).toBe('A');
    expect(item?.getAttribute('href')).toBe('/imago');
    expect(item?.textContent).toBe('Try Imago');
  });

  it('renders nothing when NEXT_PUBLIC_IMAGO_ENABLED is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', undefined);
    render(<UserDropdown />);
    expect(tryImago()).toBeNull();
    expect(screen.queryByText('Try Imago')).toBeNull();
  });

  it.each(['false', '', 'TRUE', '1', ' true'])(
    'renders nothing when NEXT_PUBLIC_IMAGO_ENABLED is %j',
    (flag) => {
      vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', flag);
      render(<UserDropdown />);
      expect(tryImago()).toBeNull();
    },
  );

  it.each([true, false])('gates on the flag alone when isOnPrem() is %s', (onPrem) => {
    mockIsOnPrem.mockReturnValue(onPrem);
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
    const { unmount } = render(<UserDropdown />);
    expect(tryImago()?.getAttribute('href')).toBe('/imago');
    unmount();

    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'false');
    render(<UserDropdown />);
    expect(tryImago()).toBeNull();
  });
});
