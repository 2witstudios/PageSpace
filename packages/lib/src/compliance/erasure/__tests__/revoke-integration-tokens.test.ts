import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { integrationConnections: { findMany: vi.fn() } },
    update: vi.fn(),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(() => 'eq') }));
vi.mock('@pagespace/db/schema/integrations', () => ({
  integrationConnections: { userId: 'userId', id: 'id' },
}));
vi.mock('../../../integrations/credentials/encrypt-credentials', () => ({
  decryptCredentials: vi.fn(),
}));

import { revokeUserIntegrationTokens } from '../revoke-integration-tokens';
import { db } from '@pagespace/db/db';
import { decryptCredentials } from '../../../integrations/credentials/encrypt-credentials';

function mockConnections(connections: unknown[]) {
  vi.mocked(db.query.integrationConnections.findMany).mockResolvedValue(connections as never);
}

function mockUpdate() {
  const whereFn = vi.fn().mockResolvedValue(undefined);
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  vi.mocked(db.update).mockReturnValue({ set: setFn } as never);
  return { setFn, whereFn };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

describe('revokeUserIntegrationTokens', () => {
  it('uses the canonical builtin revoke URL even when the persisted provider config is stale', async () => {
    mockConnections([
      {
        id: 'conn-1',
        credentials: { accessToken: 'enc-token' },
        provider: {
          slug: 'github',
          providerType: 'builtin',
          config: {
            authMethod: {
              type: 'oauth2',
              config: { revokeUrl: 'https://stale.example.com/revoke' },
            },
          },
        },
      },
    ]);
    mockUpdate();
    vi.mocked(decryptCredentials).mockResolvedValue({ accessToken: 'plain-token' });

    const result = await revokeUserIntegrationTokens('user-1');

    // The builtin GitHub definition's revoke URL wins, never the stale DB copy.
    expect(fetch).toHaveBeenCalledWith(
      'https://github.com/settings/connections/applications',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetch).not.toHaveBeenCalledWith('https://stale.example.com/revoke', expect.anything());
    expect(result).toEqual({ revoked: 1, failed: 0 });
  });

  it('falls back to the persisted config for a non-builtin (custom) provider', async () => {
    mockConnections([
      {
        id: 'conn-2',
        credentials: { accessToken: 'enc-token' },
        provider: {
          slug: 'my-custom-provider',
          providerType: 'custom',
          config: {
            authMethod: {
              type: 'oauth2',
              config: { revokeUrl: 'https://custom.example.com/revoke' },
            },
          },
        },
      },
    ]);
    mockUpdate();
    vi.mocked(decryptCredentials).mockResolvedValue({ accessToken: 'plain-token' });

    await revokeUserIntegrationTokens('user-1');

    expect(fetch).toHaveBeenCalledWith('https://custom.example.com/revoke', expect.anything());
  });

  it('uses the custom provider revoke URL when its slug collides with a builtin', async () => {
    mockConnections([
      {
        id: 'conn-4',
        credentials: { accessToken: 'enc-token' },
        provider: {
          slug: 'github', // collides with the builtin slug
          providerType: 'custom',
          config: {
            authMethod: {
              type: 'oauth2',
              config: { revokeUrl: 'https://proxy.example.com/revoke' },
            },
          },
        },
      },
    ]);
    mockUpdate();
    vi.mocked(decryptCredentials).mockResolvedValue({ accessToken: 'plain-token' });

    await revokeUserIntegrationTokens('user-1');

    // The custom provider's own revoke URL wins — not the builtin GitHub one.
    expect(fetch).toHaveBeenCalledWith('https://proxy.example.com/revoke', expect.anything());
  });

  it('marks the connection revoked even with no credentials or provider', async () => {
    mockConnections([{ id: 'conn-3', credentials: null, provider: null }]);
    const { setFn } = mockUpdate();

    const result = await revokeUserIntegrationTokens('user-1');

    expect(fetch).not.toHaveBeenCalled();
    expect(setFn).toHaveBeenCalledWith({ status: 'revoked' });
    expect(result).toEqual({ revoked: 1, failed: 0 });
  });
});
