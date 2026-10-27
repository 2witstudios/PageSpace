import { describe, expect, it } from 'vitest';
import { createDiscoverMetadata, DiscoveryError } from '@pagespace/cli';

function fakeFetch(response: { ok: boolean; status?: number; json: () => Promise<unknown> }): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

describe('createDiscoverMetadata', () => {
  it('parses a valid RFC 8414 metadata document', async () => {
    const discover = createDiscoverMetadata(
      fakeFetch({
        ok: true,
        json: async () => ({
          issuer: 'https://pagespace.ai',
          authorization_endpoint: 'https://pagespace.ai/api/oauth/authorize',
          token_endpoint: 'https://pagespace.ai/api/oauth/token',
        }),
      }),
    );

    const metadata = await discover('https://pagespace.ai');

    expect(metadata).toEqual({
      authorizationEndpoint: 'https://pagespace.ai/api/oauth/authorize',
      tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
    });
  });

  it('surfaces device_authorization_endpoint when the server advertises it', async () => {
    const discover = createDiscoverMetadata(
      fakeFetch({
        ok: true,
        json: async () => ({
          authorization_endpoint: 'https://pagespace.ai/api/oauth/authorize',
          token_endpoint: 'https://pagespace.ai/api/oauth/token',
          device_authorization_endpoint: 'https://pagespace.ai/api/oauth/device_authorization',
        }),
      }),
    );

    const metadata = await discover('https://pagespace.ai');

    expect(metadata.deviceAuthorizationEndpoint).toBe('https://pagespace.ai/api/oauth/device_authorization');
  });

  it('leaves device_authorization_endpoint undefined when the server does not advertise it', async () => {
    const discover = createDiscoverMetadata(
      fakeFetch({
        ok: true,
        json: async () => ({
          authorization_endpoint: 'https://pagespace.ai/api/oauth/authorize',
          token_endpoint: 'https://pagespace.ai/api/oauth/token',
        }),
      }),
    );

    const metadata = await discover('https://pagespace.ai');

    expect(metadata.deviceAuthorizationEndpoint).toBeUndefined();
  });

  it('fetches the well-known path relative to the given host, tolerating a trailing slash', async () => {
    let requestedUrl: string | undefined;
    const fetchImpl = (async (url: string) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({
          authorization_endpoint: 'https://pagespace.ai/api/oauth/authorize',
          token_endpoint: 'https://pagespace.ai/api/oauth/token',
        }),
      };
    }) as unknown as typeof fetch;

    await createDiscoverMetadata(fetchImpl)('https://pagespace.ai/');

    expect(requestedUrl).toBe('https://pagespace.ai/.well-known/oauth-authorization-server');
  });

  it('fails closed on a non-2xx response', async () => {
    const discover = createDiscoverMetadata(fakeFetch({ ok: false, status: 500, json: async () => ({}) }));
    await expect(discover('https://pagespace.ai')).rejects.toThrow(DiscoveryError);
  });

  it('fails closed on malformed metadata (missing endpoints)', async () => {
    const discover = createDiscoverMetadata(fakeFetch({ ok: true, json: async () => ({ issuer: 'https://pagespace.ai' }) }));
    await expect(discover('https://pagespace.ai')).rejects.toThrow(DiscoveryError);
  });

  it('fails closed when the network request itself throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(createDiscoverMetadata(fetchImpl)('https://pagespace.ai')).rejects.toThrow(DiscoveryError);
  });
});
