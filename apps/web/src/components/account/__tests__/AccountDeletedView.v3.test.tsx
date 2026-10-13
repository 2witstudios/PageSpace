// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AccountDeletedView } from '../AccountDeletedView';

describe('AccountDeletedView — v3 (Imago enabled)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('given a deletion, should show the board copy as the page h1 with the sign-in link', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
    render(<AccountDeletedView showAppleSignInSteps={false} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Your account is being deleted' })).toBeInTheDocument();
    expect(screen.getByText(/your data is being permanently removed/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/auth/signin');
    expect(screen.queryByText(/One more step/i)).not.toBeInTheDocument();
  });

  it('given Apple revocation needs the user, should show the "One more step" copy with the steps', () => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
    render(<AccountDeletedView showAppleSignInSteps={true} />);

    expect(
      screen.getByText('One more step: remove PageSpace from Sign in with Apple'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Sign-In & Security/)).toBeInTheDocument();
  });
});
