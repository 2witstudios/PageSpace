import { describe, expect, it, vi } from 'vitest';
import { NetworkError, ValidationError } from '@pagespace/sdk';
import type { OAuthTokens } from '@pagespace/sdk';
import { agentCredentialWithTokens, createAgentRefreshAccessToken } from '../agent-session.js';
import type { AgentHostCredential } from '../../credentials/serialize.js';

const TOKENS = (tag: string): OAuthTokens => ({
  accessToken: `ps_at_${tag}`,
  accessExpiresAt: 2_000,
  refreshToken: `ps_rt_${tag}`,
  refreshExpiresAt: 9_000,
  scope: 'account offline_access',
});

const SECRET = 'ps_agent_abcdefghijklmnopqrstuvwxyz012345';

describe('createAgentRefreshAccessToken (silent refresh for an agent)', () => {
  it('uses the refresh token while it works, never presenting the secret', async () => {
    const refresh = vi.fn(async () => TOKENS('refreshed'));
    const exchange = vi.fn(async () => TOKENS('exchanged'));
    const doRefresh = createAgentRefreshAccessToken({ secret: SECRET, refresh, exchange });

    await expect(doRefresh('ps_rt_old')).resolves.toMatchObject({ accessToken: 'ps_at_refreshed' });
    expect(refresh).toHaveBeenCalledWith('ps_rt_old');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('re-exchanges the stored secret when the refresh answers invalid_grant', async () => {
    const refresh = vi.fn(async () => {
      throw new ValidationError('invalid_grant', [], 'auth.refresh');
    });
    const exchange = vi.fn(async () => TOKENS('exchanged'));
    const doRefresh = createAgentRefreshAccessToken({ secret: SECRET, refresh, exchange });

    await expect(doRefresh('ps_rt_dead')).resolves.toMatchObject({ accessToken: 'ps_at_exchanged' });
    expect(exchange).toHaveBeenCalledWith(SECRET);
  });

  it('exchanges straight away when there is no refresh token yet (an interrupted signup)', async () => {
    const refresh = vi.fn(async () => TOKENS('refreshed'));
    const exchange = vi.fn(async () => TOKENS('exchanged'));
    const doRefresh = createAgentRefreshAccessToken({ secret: SECRET, refresh, exchange });

    await expect(doRefresh('')).resolves.toMatchObject({ accessToken: 'ps_at_exchanged' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does NOT re-exchange on a transient failure — the refresh token may be fine', async () => {
    const refresh = vi.fn(async () => {
      throw new NetworkError('offline');
    });
    const exchange = vi.fn(async () => TOKENS('exchanged'));
    const doRefresh = createAgentRefreshAccessToken({ secret: SECRET, refresh, exchange });

    await expect(doRefresh('ps_rt_old')).rejects.toBeInstanceOf(NetworkError);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('surfaces the exchange failure when the secret itself is refused', async () => {
    const refusal = new ValidationError('invalid_grant', [], 'auth.agentAssertion');
    const doRefresh = createAgentRefreshAccessToken({
      secret: SECRET,
      refresh: async () => {
        throw new ValidationError('invalid_grant', [], 'auth.refresh');
      },
      exchange: async () => {
        throw refusal;
      },
    });

    await expect(doRefresh('ps_rt_dead')).rejects.toBe(refusal);
  });
});

describe('agentCredentialWithTokens', () => {
  it('keeps the secret, agent id, claim token and key while taking the new refresh token and live scope', () => {
    const credential: AgentHostCredential = {
      kind: 'agent',
      agentId: 'agent_1',
      secret: SECRET,
      refreshToken: 'ps_rt_old',
      clientId: 'pagespace-agent',
      claimToken: 'ps_claim_1',
      contentKeyName: 'agent',
      scopes: ['account'],
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    expect(agentCredentialWithTokens(credential, TOKENS('new'), 0)).toEqual({
      ...credential,
      refreshToken: 'ps_rt_new',
      scopes: ['account', 'offline_access'],
      createdAt: '1970-01-01T00:00:00.000Z',
    });
  });
});
