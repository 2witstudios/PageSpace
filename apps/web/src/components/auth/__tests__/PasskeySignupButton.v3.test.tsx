// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/hooks/useWebAuthnSupport', () => ({
  useWebAuthnSupport: () => true,
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { PasskeySignupButton } from '../PasskeySignupButton';

const LOCK_HINT = 'Locked to the address the invitation was sent to.';

async function expand() {
  await userEvent.click(screen.getByRole('button', { name: /create with passkey/i }));
}

describe('PasskeySignupButton — invite email lock hint', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('given Imago is enabled and an invite locks the email, should show the lock hint', async () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
    render(
      <PasskeySignupButton csrfToken="csrf" lockedEmail="lena@studio.example" />,
    );
    await expand();

    expect(await screen.findByLabelText(/email/i)).toBeDisabled();
    expect(screen.getByText(LOCK_HINT)).toBeInTheDocument();
  });

  it('given Imago is off, should not show the lock hint', async () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', undefined);
    render(
      <PasskeySignupButton csrfToken="csrf" lockedEmail="lena@studio.example" />,
    );
    await expand();

    expect(screen.queryByText(LOCK_HINT)).not.toBeInTheDocument();
  });
});
