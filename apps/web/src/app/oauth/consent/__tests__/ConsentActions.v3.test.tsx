// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  post: vi.fn(),
}));

import { ConsentActions } from '../ConsentActions';

const props = {
  clientId: 'client-1',
  redirectUri: 'http://127.0.0.1:1/cb',
  responseType: 'code',
  codeChallenge: 'challenge',
  codeChallengeMethod: 'S256',
  scope: 'account',
  state: 'xyz',
};

beforeEach(() => {
  window.history.replaceState(null, '', '/oauth/consent?client_id=client-1');
  vi.stubEnv('NEXT_PUBLIC_IMAGO_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState(null, '', '/');
});

describe('ConsentActions — v3', () => {
  it('given the ask state, should show Allow / Deny and the step-up and redirect footnote', () => {
    render(<ConsentActions {...props} />);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(
      screen.getByText(/Allow needs a fresh confirmation of who you are; denying never does\. Redirects to http:\/\/127\.0\.0\.1:1\/cb\./),
    ).toBeInTheDocument();
  });
});
