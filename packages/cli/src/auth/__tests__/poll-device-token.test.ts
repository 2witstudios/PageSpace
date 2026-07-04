import { describe, expect, it } from 'vitest';
import { createPollDeviceToken } from '@pagespace/cli';

const PARAMS = {
  tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
  clientId: 'pagespace-cli',
  deviceCode: 'ps_dc_test',
};

describe('createPollDeviceToken', () => {
  it('POSTs the device_code grant type with no code_verifier/redirect_uri', async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        json: async () => ({
          access_token: 'ps_at_x',
          token_type: 'Bearer',
          expires_in: 900,
          refresh_token: 'ps_rt_x',
          scope: 'account offline_access',
        }),
      };
    }) as unknown as typeof fetch;

    const result = await createPollDeviceToken(fetchImpl)(PARAMS);

    expect(capturedUrl).toBe(PARAMS.tokenEndpoint);
    expect(capturedInit?.method).toBe('POST');
    const body = new URLSearchParams(capturedInit?.body as string);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(body.get('device_code')).toBe(PARAMS.deviceCode);
    expect(body.get('client_id')).toBe(PARAMS.clientId);
    expect(body.has('code_verifier')).toBe(false);
    expect(body.has('redirect_uri')).toBe(false);

    expect(result).toEqual({
      kind: 'success',
      tokens: { accessToken: 'ps_at_x', refreshToken: 'ps_rt_x', expiresIn: 900, scope: 'account offline_access' },
    });
  });

  it.each([
    ['authorization_pending', 'authorization_pending'],
    ['slow_down', 'slow_down'],
    ['access_denied', 'access_denied'],
    ['expired_token', 'expired_token'],
  ])('classifies a %s error body as a %s result, not a thrown error', async (errorCode, expectedKind) => {
    const fetchImpl = (async () => ({ ok: false, status: 400, json: async () => ({ error: errorCode }) })) as unknown as typeof fetch;

    const result = await createPollDeviceToken(fetchImpl)(PARAMS);

    expect(result).toEqual({ kind: expectedKind });
  });

  it('maps an unrecognized error code to request_failed with the code as the message', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) })) as unknown as typeof fetch;

    const result = await createPollDeviceToken(fetchImpl)(PARAMS);

    expect(result).toEqual({ kind: 'request_failed', message: 'invalid_grant' });
  });

  it('maps a malformed 2xx response body to request_failed', async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ access_token: 'only-this' }) })) as unknown as typeof fetch;

    const result = await createPollDeviceToken(fetchImpl)(PARAMS);

    expect(result).toEqual({ kind: 'request_failed', message: 'invalid_response' });
  });

  it('maps a network failure to request_failed instead of throwing', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    const result = await createPollDeviceToken(fetchImpl)(PARAMS);

    expect(result.kind).toBe('request_failed');
  });
});
