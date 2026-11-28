// @vitest-environment jsdom
/**
 * Agent Signup Phase 3 (US2): "Sign up as an AI agent" after the magic-link
 * toggle on /auth/signup, only when the server says the door is open.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentDoorProvider } from '@/components/agent-auth/AgentDoorContext';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useAuthCSRF', () => ({ useAuthCSRF: () => ({ csrfToken: 'csrf', refreshToken: vi.fn() }) }));
vi.mock('@/hooks/useOAuthSignIn', () => ({
  useOAuthSignIn: () => ({
    handleGoogleSignIn: vi.fn(), handleAppleSignIn: vi.fn(), isGoogleLoading: false, isAppleLoading: false,
    isWaitingForExternalAuth: false, waitingProvider: null, cancelExternalAuth: vi.fn(),
  }),
}));
vi.mock('@/hooks/useInAppBrowserNotice', () => ({ useInAppBrowserNotice: () => ({ isInApp: false, appName: undefined }) }));
vi.mock('@/components/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/auth')>()),
  GoogleOneTap: () => null,
  MagicLinkForm: () => <div data-testid="magic-link-form" />,
  PasskeySignupButton: () => null,
}));

import { SignUpClient } from '../SignUpClient';

describe('SignUpClient — agent link', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([['classic', 'false'], ['v3', 'true']])('given the %s page and an open door, should show the link after the magic-link toggle, carrying next', (_label, v3) => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', v3);
    render(<AgentDoorProvider open><SignUpClient returnUrl="/dashboard/d1" /></AgentDoorProvider>);
    const link = screen.getByRole('link', { name: 'Sign up as an AI agent' });
    expect(link).toHaveAttribute('href', '/auth/agent?mode=signup&next=%2Fdashboard%2Fd1');
    const toggle = screen.getByRole('button', { name: 'Or sign up with email link' });
    expect(toggle.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('given a closed door, should show no agent link', () => {
    render(<AgentDoorProvider open={false}><SignUpClient /></AgentDoorProvider>);
    expect(screen.queryByRole('link', { name: 'Sign up as an AI agent' })).not.toBeInTheDocument();
  });
});
