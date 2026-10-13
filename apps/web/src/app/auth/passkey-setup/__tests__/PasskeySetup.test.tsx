// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockReplace, mockSupported } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockSupported: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useWebAuthnSupport', () => ({
  useWebAuthnSupport: () => mockSupported(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import PasskeySetupPage from '../page';

describe('PasskeySetupPage — skip destination', () => {
  beforeEach(() => {
    mockReplace.mockReset();
    mockSupported.mockReturnValue(true);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('given Imago is enabled, should show the v3 copy and send "Skip for now" to /imago', async () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
    render(<PasskeySetupPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Secure your account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /register a passkey/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));

    expect(mockReplace).toHaveBeenCalledWith('/imago');
  });

  it('given Imago is off, should send "Skip for now" to /dashboard', async () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', undefined);
    render(<PasskeySetupPage />);

    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));

    expect(mockReplace).toHaveBeenCalledWith('/dashboard');
  });

  it('given WebAuthn is unsupported, should show the notice and a "Continue" to /imago when Imago is enabled', async () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
    mockSupported.mockReturnValue(false);
    render(<PasskeySetupPage />);

    expect(screen.getByText(/this browser doesn.t support passkeys/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(mockReplace).toHaveBeenCalledWith('/imago');
  });
});
