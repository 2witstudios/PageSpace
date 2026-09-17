import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AccountDeletedView } from '../AccountDeletedView';

describe('AccountDeletedView', () => {
  it('given Apple revocation needs the user, should confirm the deletion and show the Stop Using steps', () => {
    render(<AccountDeletedView showAppleSignInSteps={true} />);

    expect(screen.getByText(/your account is being deleted/i)).toBeInTheDocument();
    expect(screen.getByText(/remove PageSpace from Sign in with Apple/i)).toBeInTheDocument();
    expect(screen.getByText(/Sign-In & Security/)).toBeInTheDocument();
  });

  it('given no Apple steps are needed, should only confirm the deletion', () => {
    render(<AccountDeletedView showAppleSignInSteps={false} />);

    expect(screen.getByText(/your account is being deleted/i)).toBeInTheDocument();
    expect(screen.queryByText(/Sign in with Apple/i)).not.toBeInTheDocument();
  });
});
