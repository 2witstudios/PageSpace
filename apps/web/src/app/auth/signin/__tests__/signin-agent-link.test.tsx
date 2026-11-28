/**
 * Agent Signup Phase 3 (US2, US9): the muted "Are you an AI agent?" link on
 * /auth/signin, in the cloud block after the magic-link toggle AND in the
 * on-prem block after "No passkey yet?", carrying `next`, and only when the
 * server says the agent door is open. Without it, the page is unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { AgentDoorProvider } from '@/components/agent-auth/AgentDoorContext';

const { mockInAppSpy, mockOnPrem, mockParams } = vi.hoisted(() => ({
  mockInAppSpy: vi.fn(),
  mockOnPrem: vi.fn(),
  mockParams: { current: new URLSearchParams() },
}));

vi.mock('inapp-spy', () => ({ default: mockInAppSpy }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/deployment-mode', () => ({ isOnPrem: () => mockOnPrem() }));
vi.mock('@/lib/capacitor-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/capacitor-bridge')>()),
  isCapacitorApp: () => false,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => mockParams.current,
}));
vi.mock('@/hooks/useAuthCSRF', () => ({ useAuthCSRF: () => ({ csrfToken: 'csrf', refreshToken: vi.fn() }) }));
vi.mock('@/hooks/useOAuthSignIn', () => ({
  useOAuthSignIn: () => ({
    handleGoogleSignIn: vi.fn(), handleAppleSignIn: vi.fn(), isGoogleLoading: false, isAppleLoading: false,
    isWaitingForExternalAuth: false, waitingProvider: null, cancelExternalAuth: vi.fn(),
  }),
}));
vi.mock('../useSigninRecovery', () => ({ useSigninRecovery: () => ({ recovering: false }) }));
vi.mock('@/components/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/auth')>()),
  GoogleOneTap: () => null,
  MagicLinkForm: () => <div data-testid="magic-link-form" />,
  PasskeyLoginButton: () => <button type="button">Sign in with Passkey</button>,
}));

import SignInPage from '../page';

const AGENT_LINK = 'Are you an AI agent? Sign in with an agent secret';
const withDoor = (open: boolean, ui: ReactElement) => <AgentDoorProvider open={open}>{ui}</AgentDoorProvider>;

describe('sign-in page — agent link', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockOnPrem.mockReturnValue(false);
    mockInAppSpy.mockReturnValue({ isInApp: false, appName: undefined });
    mockParams.current = new URLSearchParams();
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([['classic', 'false'], ['v3', 'true']])('given the %s cloud page and an open door, should show the link after the magic-link toggle', async (_label, v3) => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', v3);
    render(withDoor(true, <SignInPage />));
    const link = await screen.findByRole('link', { name: AGENT_LINK });
    expect(link).toHaveAttribute('href', '/auth/agent?mode=signin');
    const toggle = screen.getByRole('button', { name: 'Or use a magic link' });
    expect(toggle.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('given a safe next, should carry it on the agent link', async () => {
    mockParams.current = new URLSearchParams('next=/dashboard/drive-1');
    render(withDoor(true, <SignInPage />));
    expect(await screen.findByRole('link', { name: AGENT_LINK })).toHaveAttribute('href', '/auth/agent?mode=signin&next=%2Fdashboard%2Fdrive-1');
  });

  it('given on-prem with the door open, should show the link after "No passkey yet?"', async () => {
    mockOnPrem.mockReturnValue(true);
    render(withDoor(true, <SignInPage />));
    const link = await screen.findByRole('link', { name: AGENT_LINK });
    const hint = screen.getByText(/No passkey yet\?/);
    expect(hint.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([[false], [true]])('given the door closed (onprem=%s), should show no agent link', async (onPrem) => {
    mockOnPrem.mockReturnValue(onPrem);
    render(withDoor(false, <SignInPage />));
    await screen.findByRole('heading', { name: 'Welcome back' });
    expect(screen.queryByRole('link', { name: AGENT_LINK })).not.toBeInTheDocument();
  });
});
