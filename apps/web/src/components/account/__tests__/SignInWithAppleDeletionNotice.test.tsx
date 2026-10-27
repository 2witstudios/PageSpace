import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SignInWithAppleDeletionNotice, StopUsingSignInWithAppleSteps } from '../SignInWithAppleDeletionNotice';

describe('StopUsingSignInWithAppleSteps', () => {
  it('should give the iPhone/iPad and the web paths to stop using Sign in with Apple for PageSpace', () => {
    render(<StopUsingSignInWithAppleSteps />);

    expect(screen.getByText(/Settings → your name → Sign-In & Security → Sign in with Apple/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'account.apple.com' })).toHaveAttribute('href', 'https://account.apple.com');
    expect(screen.getAllByText(/Stop Using/).length).toBeGreaterThan(0);
  });
});

describe('SignInWithAppleDeletionNotice', () => {
  it('given automatic revocation, should say PageSpace will disconnect Sign in with Apple and show no manual steps', () => {
    render(<SignInWithAppleDeletionNotice revocation="automatic" />);

    expect(screen.getByText(/also disconnect PageSpace from Sign in with Apple/i)).toBeInTheDocument();
    expect(screen.queryByText(/Sign-In & Security/)).not.toBeInTheDocument();
  });

  it('given manual revocation, should show the Stop Using steps', () => {
    render(<SignInWithAppleDeletionNotice revocation="manual" />);

    expect(screen.getByText(/remove PageSpace from Sign in with Apple yourself/i)).toBeInTheDocument();
    expect(screen.getByText(/Sign-In & Security/)).toBeInTheDocument();
  });

  it('given a user who never used Sign in with Apple, should render nothing', () => {
    const { container } = render(<SignInWithAppleDeletionNotice revocation="none" />);

    expect(container).toBeEmptyDOMElement();
  });
});
