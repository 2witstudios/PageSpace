import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PasskeyRegisterExternalView } from '@/components/auth/PasskeyRegisterExternalView';

describe('PasskeyRegisterExternalView', () => {
  it('renders a loading state while the ceremony is running', () => {
    render(<PasskeyRegisterExternalView status={{ kind: 'running' }} />);
    expect(screen.getByText(/adding your passkey/i)).toBeInTheDocument();
  });

  it('renders a redirecting message when the deep link is ready', () => {
    render(<PasskeyRegisterExternalView status={{ kind: 'redirecting' }} />);
    expect(screen.getByText(/returning to the desktop app/i)).toBeInTheDocument();
  });

  it('renders a softer "already set up" header when code=ALREADY_REGISTERED', () => {
    render(
      <PasskeyRegisterExternalView
        status={{
          kind: 'error',
          message:
            'A passkey is already registered on this device. To add another, use a different device, a security key, or iCloud Keychain from another Mac or iPhone.',
          code: 'ALREADY_REGISTERED',
        }}
      />,
    );
    expect(screen.getByText(/this device is already set up/i)).toBeInTheDocument();
    expect(screen.getByText(/already registered on this device/i)).toBeInTheDocument();
    expect(screen.queryByText(/registration failed/i)).not.toBeInTheDocument();
  });

  it('renders a "Registration cancelled" header when code=CANCELLED', () => {
    render(
      <PasskeyRegisterExternalView
        status={{
          kind: 'error',
          message: 'Registration was cancelled',
          code: 'CANCELLED',
        }}
      />,
    );
    expect(screen.getByText(/registration cancelled/i)).toBeInTheDocument();
    expect(screen.queryByText(/registration failed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/this device is already set up/i)).not.toBeInTheDocument();
  });

  it('renders a generic "Registration failed" header for uncoded errors', () => {
    render(
      <PasskeyRegisterExternalView
        status={{ kind: 'error', message: 'network failure' }}
      />,
    );
    expect(screen.getByText(/registration failed/i)).toBeInTheDocument();
    expect(screen.getByText(/network failure/i)).toBeInTheDocument();
    expect(screen.queryByText(/this device is already set up/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/registration cancelled/i)).not.toBeInTheDocument();
  });
});
