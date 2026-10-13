/**
 * The v3 (Imago-enabled) sign-in card per the C-Auth-SignIn board, and proof that the
 * classic card renders exactly as before when Imago is off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { mockInAppSpy, mockIsCapacitorApp, mockOnPrem, mockToastError, mockToastInfo, mockParams } =
  vi.hoisted(() => ({
    mockInAppSpy: vi.fn(),
    mockIsCapacitorApp: vi.fn(),
    mockOnPrem: vi.fn(),
    mockToastError: vi.fn(),
    mockToastInfo: vi.fn(),
    mockParams: { current: new URLSearchParams() },
  }));

vi.mock('inapp-spy', () => ({ default: mockInAppSpy }));

vi.mock('sonner', () => ({
  toast: { error: mockToastError, info: mockToastInfo, success: vi.fn() },
}));

vi.mock('@/lib/deployment-mode', () => ({ isOnPrem: () => mockOnPrem() }));

vi.mock('@/lib/capacitor-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/capacitor-bridge')>()),
  isCapacitorApp: () => mockIsCapacitorApp(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => mockParams.current,
}));

vi.mock('@/hooks/useAuthCSRF', () => ({
  useAuthCSRF: () => ({ csrfToken: 'csrf', refreshToken: vi.fn() }),
}));

vi.mock('@/hooks/useOAuthSignIn', () => ({
  useOAuthSignIn: () => ({
    handleGoogleSignIn: vi.fn(),
    handleAppleSignIn: vi.fn(),
    isGoogleLoading: false,
    isAppleLoading: false,
    isWaitingForExternalAuth: false,
    waitingProvider: null,
    cancelExternalAuth: vi.fn(),
  }),
}));

vi.mock('../useSigninRecovery', () => ({ useSigninRecovery: () => ({ recovering: false }) }));

vi.mock('@/components/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/auth')>()),
  GoogleOneTap: () => null,
  MagicLinkForm: () => <div data-testid="magic-link-form" />,
  PasskeyLoginButton: ({ className }: { className?: string }) => (
    <button type="button" className={className}>
      Sign in with Passkey
    </button>
  ),
}));

import SignInPage from '../page';

function setParams(query: string) {
  mockParams.current = new URLSearchParams(query);
}

describe('sign-in page — v3 frame (Imago enabled)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
    mockOnPrem.mockReturnValue(false);
    mockIsCapacitorApp.mockReturnValue(false);
    mockInAppSpy.mockReturnValue({ isInApp: false, appName: undefined });
    setParams('');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('given the cloud default, shows a left-aligned heading with passkey first, then the or separator, then Google and Apple', async () => {
    render(<SignInPage />);

    const heading = await screen.findByRole('heading', { name: 'Welcome back' });
    expect(heading).toHaveClass('text-[28px]', 'text-left');
    expect(screen.getByText('Sign in to your workspace')).toBeInTheDocument();

    const passkey = screen.getByRole('button', { name: 'Sign in with Passkey' });
    const separator = screen.getByRole('separator');
    const google = screen.getByRole('button', { name: 'Continue with Google' });
    const apple = screen.getByRole('button', { name: 'Continue with Apple' });
    expect(passkey.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(separator.compareDocumentPosition(google) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(google.compareDocumentPosition(apple) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(google).toHaveClass('h-10', 'rounded-[10px]');
    expect(passkey).toHaveClass('bg-[oklch(0.50_0.16_235)]');
    expect(screen.getByRole('button', { name: 'Or use a magic link' })).toHaveClass('h-9');
    expect(screen.getByRole('button', { name: 'Cookie preferences' })).toBeInTheDocument();
    expect(screen.queryByTestId('magic-link-form')).not.toBeInTheDocument();
  });

  it('given magic_link_expired, shows the status pill with the board copy and no sonner toast', async () => {
    setParams('error=magic_link_expired');
    render(<SignInPage />);

    const pill = await screen.findByRole('status');
    expect(pill).toHaveTextContent('Your sign-in link has expired. Please request a new one.');
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('given account_suspended, shows the suspended copy in the status pill', async () => {
    setParams('error=account_suspended');
    render(<SignInPage />);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Your account has been suspended. Please contact support.',
    );
  });

  it('given an in-app browser, shows the warning under the heading and opens the magic-link form', async () => {
    mockInAppSpy.mockReturnValue({ isInApp: true, appName: undefined });
    render(<SignInPage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Google sign-in is blocked in this app');
    expect(alert).toHaveTextContent('Use a magic link below');
    expect(await screen.findByTestId('magic-link-form')).toBeInTheDocument();
  });

  it('given on-prem, shows passkey, the admin hint and the contact-admin pill', async () => {
    mockOnPrem.mockReturnValue(true);
    setParams('onprem=contact_admin');
    render(<SignInPage />);

    expect(await screen.findByRole('button', { name: 'Sign in with Passkey' })).toBeInTheDocument();
    expect(screen.getByText('No passkey yet? Ask your administrator for a one-time setup link.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Contact your administrator for an account.');
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).not.toBeInTheDocument();
  });
});

describe('sign-in page — classic frame (Imago off) is unchanged', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', undefined);
    mockOnPrem.mockReturnValue(false);
    mockIsCapacitorApp.mockReturnValue(false);
    mockInAppSpy.mockReturnValue({ isInApp: false, appName: undefined });
    setParams('');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('given the cloud default, keeps the centred heading and classic button classes', async () => {
    render(<SignInPage />);

    const heading = await screen.findByRole('heading', { name: 'Welcome back' });
    expect(heading).toHaveClass('text-3xl', 'tracking-tight');
    expect(heading.parentElement).toHaveClass('text-center');
    expect(screen.getByRole('button', { name: 'Continue with Google' })).not.toHaveClass('h-10');
    expect(screen.getByRole('button', { name: 'Or use a magic link' })).toHaveClass('py-2');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('given magic_link_expired, shows the error as a sonner toast, not a status pill', async () => {
    setParams('error=magic_link_expired');
    render(<SignInPage />);

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('Your sign-in link has expired. Please request a new one.'),
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('given an in-app browser, keeps the warning above the heading as a shadcn alert', async () => {
    mockInAppSpy.mockReturnValue({ isInApp: true, appName: 'Instagram' });
    render(<SignInPage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Google sign-in is blocked in Instagram');
    expect(alert.compareDocumentPosition(screen.getByRole('heading', { name: 'Welcome back' })) &
      Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
