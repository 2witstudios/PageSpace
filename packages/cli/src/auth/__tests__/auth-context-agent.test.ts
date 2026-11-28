/**
 * `buildAuthProvider` / `enforceAuth` for an agent's own stored credential:
 * refresh while the refresh token works, re-exchange the secret on
 * invalid_grant, persist the new refresh token (keeping the secret) before the
 * new access token is used, and never delete an agent secret on a failure.
 */
import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '@pagespace/sdk';
import type { OAuthTokens } from '@pagespace/sdk';
import { buildAuthProvider, enforceAuth } from '../auth-context.js';
import type { AgentHostCredential, HostCredential } from '../../credentials/serialize.js';
import { EXIT_RUNTIME_ERROR } from '../../exit-codes.js';

const HOST = 'https://pagespace.ai';
const SECRET = 'ps_agent_abcdefghijklmnopqrstuvwxyz012345';

const AGENT: AgentHostCredential = {
  kind: 'agent',
  agentId: 'agent_1',
  secret: SECRET,
  refreshToken: 'ps_rt_old',
  clientId: 'pagespace-agent',
  contentKeyName: 'agent',
  scopes: ['account', 'offline_access'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const tokens = (tag: string): OAuthTokens => ({
  accessToken: `ps_at_${tag}`,
  accessExpiresAt: Number.POSITIVE_INFINITY,
  refreshToken: `ps_rt_${tag}`,
  refreshExpiresAt: Number.POSITIVE_INFINITY,
  scope: 'account offline_access',
});

function storeSpy() {
  const sets: Array<{ host: string; credential: HostCredential; profile?: string }> = [];
  const deletes: string[] = [];
  return {
    sets,
    deletes,
    async set(host: string, credential: HostCredential, profile?: string) {
      sets.push({ host, credential, profile });
    },
    async delete(host: string) {
      deletes.push(host);
    },
  };
}

const discover = async () => ({ tokenEndpoint: `${HOST}/api/oauth/token` });

describe('buildAuthProvider — stored agent credential', () => {
  it('refreshes with the agent client id and persists the rotated refresh token, keeping the secret', async () => {
    const store = storeSpy();
    const createRefresh = vi.fn(() => async () => tokens('refreshed'));
    const exchange = vi.fn(async () => tokens('exchanged'));
    const auth = buildAuthProvider(
      { kind: 'stored', host: HOST, keyName: 'default', credential: AGENT },
      { discoverMetadata: discover, createRefreshAccessToken: createRefresh, exchangeAgentAssertion: exchange, credentialStore: store, now: () => 0 },
    );

    await expect(auth.getAccessToken()).resolves.toBe('ps_at_refreshed');
    expect(createRefresh).toHaveBeenCalledWith(`${HOST}/api/oauth/token`, 'pagespace-agent');
    expect(exchange).not.toHaveBeenCalled();
    expect(store.sets).toHaveLength(1);
    expect(store.sets[0]?.credential).toMatchObject({ kind: 'agent', secret: SECRET, refreshToken: 'ps_rt_refreshed', contentKeyName: 'agent' });
    expect(store.sets[0]?.profile).toBe('default');
  });

  it('re-exchanges the stored secret on invalid_grant and persists the new pair before use', async () => {
    const store = storeSpy();
    let persisted = false;
    const persistingStore = {
      ...store,
      async set(host: string, credential: HostCredential, profile?: string) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        persisted = true;
        await store.set(host, credential, profile);
      },
    };
    const exchange = vi.fn(async () => tokens('exchanged'));
    const auth = buildAuthProvider(
      { kind: 'stored', host: HOST, keyName: 'default', credential: AGENT },
      {
        discoverMetadata: discover,
        createRefreshAccessToken: () => async () => {
          throw new ValidationError('invalid_grant', [], 'auth.refresh');
        },
        exchangeAgentAssertion: exchange,
        credentialStore: persistingStore,
        now: () => 0,
      },
    );

    const token = await auth.getAccessToken();
    expect(persisted).toBe(true);
    expect(token).toBe('ps_at_exchanged');
    expect(exchange).toHaveBeenCalledWith(`${HOST}/api/oauth/token`, SECRET, 'pagespace-agent');
    expect(store.sets[0]?.credential).toMatchObject({ secret: SECRET, refreshToken: 'ps_rt_exchanged' });
  });

  it('exchanges immediately for a credential stored before its first exchange (no refresh token)', async () => {
    const store = storeSpy();
    const createRefresh = vi.fn(() => async () => tokens('refreshed'));
    const exchange = vi.fn(async () => tokens('exchanged'));
    const auth = buildAuthProvider(
      { kind: 'stored', host: HOST, credential: { ...AGENT, refreshToken: null } },
      { discoverMetadata: discover, createRefreshAccessToken: createRefresh, exchangeAgentAssertion: exchange, credentialStore: store, now: () => 0 },
    );

    await expect(auth.getAccessToken()).resolves.toBe('ps_at_exchanged');
    expect(createRefresh).not.toHaveBeenCalled();
  });
});

describe('enforceAuth — stored agent credential', () => {
  it('never deletes an agent secret when refresh and exchange both fail; tells the agent how to recover', async () => {
    const store = storeSpy();
    const stderr = { lines: [] as string[], write(chunk: string) { this.lines.push(chunk); } };
    const source = { kind: 'stored', host: HOST, keyName: 'default', credential: AGENT } as const;
    const auth = buildAuthProvider(source, {
      discoverMetadata: discover,
      createRefreshAccessToken: () => async () => {
        throw new ValidationError('invalid_grant', [], 'auth.refresh');
      },
      exchangeAgentAssertion: async () => {
        throw new ValidationError('invalid_grant', [], 'auth.agentAssertion');
      },
      credentialStore: store,
      now: () => 0,
    });

    const code = await enforceAuth({ auth, source, credentialStore: store, stderr });

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(store.deletes).toEqual([]);
    expect(stderr.lines.join('')).toContain('pagespace login --agent');
    expect(stderr.lines.join('')).not.toContain(SECRET);
  });
});
