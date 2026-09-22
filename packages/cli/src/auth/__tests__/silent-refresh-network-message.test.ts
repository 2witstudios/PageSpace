import { describe, expect, it } from 'vitest';
import { isNetworkError } from '@pagespace/sdk';
import { createRefreshAccessToken } from '../silent-refresh.js';

describe('createRefreshAccessToken — network failure wording', () => {
  it('keeps the CLI\'s own message for an unreachable token endpoint, with the cause attached and no token in it', async () => {
    const cause = new TypeError('getaddrinfo ENOTFOUND');
    const fetchImpl = (async () => {
      throw cause;
    }) as typeof fetch;

    const error = await createRefreshAccessToken('https://pagespace.ai/api/oauth/token', 'pagespace-cli', fetchImpl)('ps_rt_secret').catch((e: unknown) => e);

    expect(isNetworkError(error)).toBe(true);
    expect((error as Error).message).toBe('Refresh token request failed');
    expect((error as { cause?: unknown }).cause).toBe(cause);
    expect((error as { operation?: string }).operation).toBe('auth.refresh');
  });
});
