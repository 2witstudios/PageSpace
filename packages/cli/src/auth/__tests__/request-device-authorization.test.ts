import { describe, expect, it } from 'vitest';
import { createRequestDeviceAuthorization, DeviceAuthorizationError } from '@pagespace/cli';

const PARAMS = {
  deviceAuthorizationEndpoint: 'https://pagespace.ai/api/oauth/device_authorization',
  clientId: 'pagespace-cli',
  scope: 'account offline_access',
};

describe('createRequestDeviceAuthorization', () => {
  it('POSTs a form-encoded device authorization request and parses the response', async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        json: async () => ({
          device_code: 'ps_dc_test',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://pagespace.ai/activate',
          verification_uri_complete: 'https://pagespace.ai/activate?user_code=ABCD-EFGH',
          expires_in: 1800,
          interval: 5,
        }),
      };
    }) as unknown as typeof fetch;

    const authorization = await createRequestDeviceAuthorization(fetchImpl)(PARAMS);

    expect(capturedUrl).toBe(PARAMS.deviceAuthorizationEndpoint);
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');

    const body = new URLSearchParams(capturedInit?.body as string);
    expect(body.get('client_id')).toBe(PARAMS.clientId);
    expect(body.get('scope')).toBe(PARAMS.scope);

    expect(authorization).toEqual({
      deviceCode: 'ps_dc_test',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://pagespace.ai/activate',
      verificationUriComplete: 'https://pagespace.ai/activate?user_code=ABCD-EFGH',
      expiresInSeconds: 1800,
      intervalSeconds: 5,
    });
  });

  it('throws a DeviceAuthorizationError named after the server error code on a 400', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_client' }),
    })) as unknown as typeof fetch;

    const error = await createRequestDeviceAuthorization(fetchImpl)(PARAMS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeviceAuthorizationError);
    expect((error as InstanceType<typeof DeviceAuthorizationError>).code).toBe('invalid_client');
  });

  it('fails closed on a malformed 2xx response body', async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ device_code: 'only-this' }) })) as unknown as typeof fetch;

    await expect(createRequestDeviceAuthorization(fetchImpl)(PARAMS)).rejects.toThrow(DeviceAuthorizationError);
  });

  it('fails closed when the network request throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(createRequestDeviceAuthorization(fetchImpl)(PARAMS)).rejects.toThrow(DeviceAuthorizationError);
  });
});
