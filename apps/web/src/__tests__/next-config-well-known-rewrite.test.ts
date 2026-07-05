import { describe, it, expect } from 'vitest';

describe('next.config rewrites — RFC 8414 discovery URL', () => {
  it('rewrites the unroutable /.well-known/oauth-authorization-server URL to the routable API destination', async () => {
    const { nextConfig } = await import('../../next.config');

    const rewrites = await nextConfig.rewrites?.();

    expect(rewrites).toContainEqual({
      source: '/.well-known/oauth-authorization-server',
      destination: '/api/well-known/oauth-authorization-server',
    });
  });
});
