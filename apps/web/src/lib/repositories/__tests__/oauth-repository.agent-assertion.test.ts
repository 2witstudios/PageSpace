/**
 * `exchangeAgentAssertion` — the jwt-bearer grant's persistence (Agent Signup
 * Phase 2 leaf 4; ADR 0007 Decisions 4-6, threat model T3/T4). The pure
 * `decideAgentSignin` and `issueInitialTokenPair` are REAL; only the database
 * is faked, and the fake re-checks the WHERE so the hash lookup is exercised.
 * Real-Postgres coverage of the whole door is in
 * `app/api/agent/__tests__/agent-door-flow.integration.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { hashToken } from '@pagespace/lib/auth/token-utils';

vi.mock('server-only', () => ({}));

const H = vi.hoisted(() => ({
  agentIdentities: { __table: 'agent_identities', userId: 'ai.userId', secretHash: 'ai.secretHash', revokedAt: 'ai.revokedAt', lastAuthAt: 'ai.lastAuthAt' } as Record<string, unknown>,
  users: { __table: 'users', id: 'users.id', suspendedAt: 'users.suspendedAt', lockedUntil: 'users.lockedUntil', tokenVersion: 'users.tokenVersion' } as Record<string, unknown>,
  oauthRefreshTokens: { __table: 'refresh' } as Record<string, unknown>,
  oauthAccessTokens: { __table: 'access' } as Record<string, unknown>,
}));

vi.mock('@pagespace/db/schema/agent-identities', () => ({ agentIdentities: H.agentIdentities }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: H.users }));
vi.mock('@pagespace/db/schema/oauth', () => ({
  oauthClients: {}, oauthAuthorizationCodes: {}, oauthDeviceCodes: {},
  oauthRefreshTokens: H.oauthRefreshTokens, oauthAccessTokens: H.oauthAccessTokens,
}));
vi.mock('../session-repository', () => ({ sessionRepository: {} }));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  isNull: vi.fn((a: unknown) => ({ _isNull: a })),
}));

interface AgentRow {
  userId: string;
  secretHash: string;
  revokedAt: Date | null;
  suspendedAt: Date | null;
  lockedUntil: Date | null;
  tokenVersion: number;
  lastAuthAt: Date | null;
}

const state = {
  row: null as AgentRow | null,
  lookups: 0,
  lockedForUpdate: false,
  inserts: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
};

function makeTx() {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: (pred: { _eq: [unknown, unknown] }) => ({
            limit: () => ({
              for: async (mode: string) => {
                state.lookups += 1;
                state.lockedForUpdate = mode === 'update';
                const [column, value] = pred._eq;
                return state.row && column === H.agentIdentities.secretHash && value === state.row.secretHash ? [{ ...state.row }] : [];
              },
            }),
          }),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (pred: { _eq: [unknown, unknown] }) => {
          if (table === H.agentIdentities && state.row && pred._eq[1] === state.row.userId) Object.assign(state.row, patch);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        state.inserts.push({ table, values });
      },
    }),
  };
}

vi.mock('@pagespace/db/db', () => ({
  db: { transaction: (cb: (tx: unknown) => unknown) => cb(makeTx()) },
}));

import { exchangeAgentAssertion } from '../oauth-repository';

const SECRET = 'ps_agent_abcdefghijklmnopqrstuvwxyz012345';
const NOW = new Date('2026-09-21T12:00:00Z');

const agentRow = (overrides: Partial<AgentRow> = {}): AgentRow => ({
  userId: 'agent-1', secretHash: hashToken(SECRET), revokedAt: null, suspendedAt: null, lockedUntil: null, tokenVersion: 3, lastAuthAt: null, ...overrides,
});

const exchange = (assertion = SECRET, scopes = ['account', 'offline_access']) =>
  exchangeAgentAssertion({ assertion, clientDbId: 'client-db-agent', scopes, now: NOW });

describe('exchangeAgentAssertion', () => {
  beforeEach(() => {
    state.row = agentRow();
    state.lookups = 0;
    state.lockedForUpdate = false;
    state.inserts = [];
  });

  describe('given a live agent secret', () => {
    it('should issue a ps_at_/ps_rt_ pair for the agent with the agent client and its tokenVersion', async () => {
      const result = await exchange();
      expect(result.outcome).toBe('ok');
      if (result.outcome !== 'ok') return;
      expect(result.userId).toBe('agent-1');
      expect(result.scopes).toEqual(['account', 'offline_access']);
      expect(result.tokens.accessToken.startsWith('ps_at_')).toBe(true);
      expect(result.tokens.refreshToken?.startsWith('ps_rt_')).toBe(true);

      const refresh = state.inserts.find((i) => i.table === H.oauthRefreshTokens);
      const access = state.inserts.find((i) => i.table === H.oauthAccessTokens);
      expect(refresh?.values).toMatchObject({ clientId: 'client-db-agent', userId: 'agent-1', scopes: ['account', 'offline_access'], tokenVersion: 3, tokenHash: result.tokens.refreshTokenHash, familyId: result.tokens.familyId });
      expect(access?.values).toMatchObject({ clientId: 'client-db-agent', userId: 'agent-1', scopes: ['account', 'offline_access'], tokenVersion: 3, tokenHash: result.tokens.accessTokenHash, familyId: result.tokens.familyId });
    });

    it('should look the agent up by the SHA3-256 hash of the secret, locked for update', async () => {
      await exchange();
      expect(state.lookups).toBe(1);
      expect(state.lockedForUpdate).toBe(true);
    });

    it('should stamp lastAuthAt', async () => {
      await exchange();
      expect(state.row?.lastAuthAt).toEqual(NOW);
    });

    it('given no offline_access, should issue an access token only', async () => {
      const result = await exchange(SECRET, ['account']);
      expect(result.outcome).toBe('ok');
      expect(state.inserts.map((i) => i.table)).toEqual([H.oauthAccessTokens]);
    });
  });

  describe('given a secret that must not sign in', () => {
    it.each([
      ['an unknown secret', () => { state.row = agentRow({ secretHash: hashToken('ps_agent_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz') }); }, 'not_found'],
      ['a revoked agent', () => { state.row = agentRow({ revokedAt: new Date('2026-09-01') }); }, 'revoked'],
      ['a suspended agent', () => { state.row = agentRow({ suspendedAt: new Date('2026-09-01') }); }, 'suspended'],
      ['a locked agent', () => { state.row = agentRow({ lockedUntil: new Date(NOW.getTime() + 60_000) }); }, 'locked'],
    ])('given %s, should mint nothing and not stamp lastAuthAt', async (_label, arrange, outcome) => {
      arrange();
      const result = await exchange();
      expect(result.outcome).toBe(outcome);
      expect(state.inserts).toEqual([]);
      expect(state.row?.lastAuthAt).toBeNull();
    });

    it('given a lock that expired exactly now, should sign in (decideAgentSignin boundary)', async () => {
      state.row = agentRow({ lockedUntil: NOW });
      expect((await exchange()).outcome).toBe('ok');
    });

    it.each([
      ['a malformed secret', 'ps_agent_short'],
      ['a different token family', 'ps_at_abcdefghijklmnopqrstuvwxyz012345'],
      ['an empty string', ''],
    ])('given %s, should refuse without touching the database', async (_label, assertion) => {
      const result = await exchange(assertion);
      expect(result.outcome).toBe('not_found');
      expect(state.lookups).toBe(0);
      expect(state.inserts).toEqual([]);
    });
  });
});
