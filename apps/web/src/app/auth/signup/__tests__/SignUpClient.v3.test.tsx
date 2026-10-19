// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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

vi.mock('@/hooks/useInAppBrowserNotice', () => ({
  useInAppBrowserNotice: () => ({ isInApp: false, appName: undefined }),
}));

vi.mock('@/components/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/auth')>()),
  GoogleOneTap: () => null,
  MagicLinkForm: () => <div data-testid="magic-link-form" />,
  PasskeySignupButton: () => null,
}));

import { SignUpClient } from '../SignUpClient';

const driveInvite = {
  kind: 'drive' as const,
  driveName: 'Studio',
  inviterName: 'Jono',
  role: 'MEMBER' as const,
  email: 'lena@studio.example',
  isExistingUser: false,
};

describe('SignUpClient — v3 (Imago enabled)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('given a direct visit, should show "Get on the same page." as the h1 and no invite banner', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', 'true');
    render(<SignUpClient />);

    expect(screen.getByRole('heading', { level: 1, name: 'Get on the same page.' })).toBeInTheDocument();
    expect(screen.queryByText(/you’re joining/i)).not.toBeInTheDocument();
  });

  it('given a drive invite, should show the joining banner with the curly apostrophe', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', 'true');
    render(<SignUpClient inviteToken="ps_invite_x" inviteContext={driveInvite} />);

    const banner = screen.getByText(/you’re joining/i).closest('p');
    expect(banner).toHaveTextContent('You’re joining Studio, invited by Jono.');
  });
});
