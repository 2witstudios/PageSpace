import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
}));

const postMock = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  post: (...args: unknown[]) => postMock(...args),
}));

import { attemptStepUp, readStepUpTokenFromHash, stripStepUpTokenFromHash } from '../step-up-ceremony';
import { startAuthentication } from '@simplewebauthn/browser';

const ACTION_BINDING = { op: 'revoke_oauth_grant', grantId: 'grant-1' };
const NEXT = '/settings/account';

describe('attemptStepUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves ready with the stepUpToken after a successful WebAuthn ceremony', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      if (url === '/api/auth/step-up/webauthn/verify') {
        return Promise.resolve({ stepUpToken: 'ps_stepup_test' });
      }
      throw new Error(`unexpected post to ${url}`);
    });
    vi.mocked(startAuthentication).mockResolvedValue({} as never);

    const result = await attemptStepUp(ACTION_BINDING, NEXT);

    expect(result).toEqual({ status: 'ready', stepUpToken: 'ps_stepup_test' });
    expect(postMock).toHaveBeenCalledWith('/api/auth/step-up/webauthn/options', { actionBinding: ACTION_BINDING });
    expect(postMock).toHaveBeenCalledWith('/api/auth/step-up/webauthn/verify', {
      response: {},
      expectedChallenge: 'srv-challenge',
      actionBinding: ACTION_BINDING,
    });
  });

  it('falls back to a magic link and resolves awaiting_email when the user has no passkey', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      if (url === '/api/auth/step-up/magic-link/request') {
        return Promise.resolve({ ok: true });
      }
      throw new Error(`unexpected post to ${url}`);
    });
    vi.mocked(startAuthentication).mockRejectedValue(new Error('no_passkey'));

    const result = await attemptStepUp(ACTION_BINDING, NEXT);

    expect(result).toEqual({ status: 'awaiting_email' });
    expect(postMock).toHaveBeenCalledWith('/api/auth/step-up/magic-link/request', {
      actionBinding: ACTION_BINDING,
      next: NEXT,
    });
  });

  it('rethrows a generic WebAuthn ceremony failure without sending a magic link', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      throw new Error(`unexpected post to ${url}`);
    });
    vi.mocked(startAuthentication).mockRejectedValue(new Error('NotAllowedError: user cancelled'));

    await expect(attemptStepUp(ACTION_BINDING, NEXT)).rejects.toThrow('NotAllowedError: user cancelled');
    expect(postMock).not.toHaveBeenCalledWith('/api/auth/step-up/magic-link/request', expect.anything());
  });

  it('rethrows when the magic-link fallback request itself fails', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      if (url === '/api/auth/step-up/magic-link/request') {
        return Promise.reject(new Error('network error'));
      }
      throw new Error(`unexpected post to ${url}`);
    });
    vi.mocked(startAuthentication).mockRejectedValue(new Error('no_passkey'));

    await expect(attemptStepUp(ACTION_BINDING, NEXT)).rejects.toThrow('network error');
  });
});

describe('readStepUpTokenFromHash', () => {
  it('returns the token when present alongside other fragment params', () => {
    expect(readStepUpTokenFromHash('#other=x&step_up_token=ps_stepup_abc')).toBe('ps_stepup_abc');
  });

  it('returns null when absent', () => {
    expect(readStepUpTokenFromHash('')).toBeNull();
    expect(readStepUpTokenFromHash('#other=x')).toBeNull();
  });
});

describe('stripStepUpTokenFromHash', () => {
  it('removes step_up_token but keeps other fragment params', () => {
    expect(stripStepUpTokenFromHash('#other=x&step_up_token=ps_stepup_abc')).toBe('#other=x');
  });

  it('returns an empty string when step_up_token was the only fragment param', () => {
    expect(stripStepUpTokenFromHash('#step_up_token=ps_stepup_abc')).toBe('');
  });
});
