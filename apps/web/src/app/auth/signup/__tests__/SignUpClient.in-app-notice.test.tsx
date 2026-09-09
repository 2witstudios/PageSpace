/**
 * The in-app-browser warning, end to end at the page level.
 *
 * The chain under test is real: the page reads `useInAppBrowserNotice`, which
 * reads `detectInAppBrowser`, which asks the Capacitor bridge before asking
 * `inapp-spy`. Only the two leaves are mocked — the shell answer and what
 * inapp-spy would say — so a regression anywhere between them fails here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { mockInAppSpy, mockIsCapacitorApp } = vi.hoisted(() => ({
  mockInAppSpy: vi.fn(),
  mockIsCapacitorApp: vi.fn(),
}));

vi.mock('inapp-spy', () => ({ default: mockInAppSpy }));

// Spread the real module: the page's other imports pull getPlatform etc. from here.
vi.mock('@/lib/capacitor-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/capacitor-bridge')>()),
  isCapacitorApp: () => mockIsCapacitorApp(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
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

// Stub only the leaves that drag in Google's SDK / the send flow; the page's
// own structure stays real.
vi.mock('@/components/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/auth')>()),
  GoogleOneTap: () => null,
  MagicLinkForm: () => <div data-testid="magic-link-form" />,
  PasskeySignupButton: () => null,
}));

import { SignUpClient } from '../SignUpClient';

const BANNER = /Google sign-in is blocked/i;

describe('SignUpClient — in-app browser warning', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // inapp-spy flags every bare WKWebView, our own shell included.
    mockInAppSpy.mockReturnValue({ isInApp: true, appName: undefined });
  });

  it('given the Capacitor shell, shows no warning and leaves the magic-link form collapsed', async () => {
    mockIsCapacitorApp.mockReturnValue(true);

    render(<SignUpClient />);

    // Wait for the effect that would have opened it, then assert it did not.
    await waitFor(() => expect(screen.getByRole('button', { name: /sign up with email link/i })).toBeInTheDocument());
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
    expect(screen.queryByTestId('magic-link-form')).not.toBeInTheDocument();
  });

  it('given a genuine in-app browser, warns and opens the magic-link form', async () => {
    mockIsCapacitorApp.mockReturnValue(false);
    mockInAppSpy.mockReturnValue({ isInApp: true, appName: 'Instagram' });

    render(<SignUpClient />);

    await waitFor(() => expect(screen.getByText(/Google sign-in is blocked in Instagram/i)).toBeInTheDocument());
    expect(screen.getByTestId('magic-link-form')).toBeInTheDocument();
  });

  it('given a normal browser, shows no warning and leaves the form collapsed', async () => {
    mockIsCapacitorApp.mockReturnValue(false);
    mockInAppSpy.mockReturnValue({ isInApp: false, appName: undefined });

    render(<SignUpClient />);

    await waitFor(() => expect(screen.getByRole('button', { name: /sign up with email link/i })).toBeInTheDocument());
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
  });
});
