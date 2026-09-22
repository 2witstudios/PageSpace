/**
 * L2·G2 — `toSafeAccount`: the ONLY shape an account leaves the server in.
 *
 * Requirement (task r17kt880rmgn4urtgpaicn5q): "Given any API response listing
 * accounts, should never include a secret field (test by value with a
 * canary)". The row type has no secret column, but a projection that spreads
 * the row would forward whatever a future column, a join or a careless caller
 * put on it — the `SafeConnection` pattern (`api/user/integrations/route.ts`)
 * is an explicit allowlist for exactly that reason.
 */
import { describe, expect, it } from 'vitest';
import type { AgentAccountRecord } from '@pagespace/db/schema/agent-accounts';
import { toSafeAccount } from '../to-safe-account';

const CANARY = 'sk_canary_7f3a9c1e5b2d4f6a8c0e';

const row: AgentAccountRecord = {
  id: 'acct_1',
  kind: 'api_key',
  ownerKind: 'agent_page',
  ownerUserId: null,
  ownerAgentPageId: 'page_1',
  ownerDriveId: 'drive_1',
  tenantId: 'drive:drive_1',
  name: 'Weather API',
  providerSlug: null,
  allowedOrigins: ['https://api.weather.example:443'],
  auxiliaryOrigins: [],
  resourceRestrictions: {},
  approvalPolicy: null,
  credentialVersion: 1,
  policyVersion: 1,
  acknowledgment: 'personal_login_acknowledged',
  sessionFormat: null,
  sessionHttpEnabled: false,
  status: 'active',
  upstreamRevocation: null,
  lastUsedAt: new Date(1_800_000_100_000),
  createdAt: new Date(1_800_000_000_000),
  updatedAt: new Date(1_800_000_050_000),
  revokedAt: null,
};

describe('toSafeAccount', () => {
  it('given an account row, should project exactly the listed metadata — including the acknowledgment the account list shows', () => {
    const actual = toSafeAccount({ row });
    const expected = {
      id: 'acct_1',
      kind: 'api_key',
      name: 'Weather API',
      ownerKind: 'agent_page',
      providerSlug: null,
      allowedOrigins: ['https://api.weather.example:443'],
      acknowledgment: 'personal_login_acknowledged',
      status: 'active',
      upstreamRevocation: null,
      lastUsedAt: 1_800_000_100_000,
      createdAt: 1_800_000_000_000,
      revokedAt: null,
    };
    expect(actual).toEqual(expected);
  });

  it('given a row carrying a secret-bearing field from a join or a future column, should never forward its value', () => {
    const polluted = { ...row, credentials: { apiKey: CANARY }, secretValue: CANARY, material: { value: CANARY }, name: 'Weather API' } as AgentAccountRecord;
    const actual = JSON.stringify(toSafeAccount({ row: polluted })).includes(CANARY);
    const expected = false;
    expect(actual).toEqual(expected);
  });

  it('given a row, should not expose the tenant, owner ids, policy, restrictions or versions', () => {
    const keys = Object.keys(toSafeAccount({ row }));
    const actual = ['tenantId', 'ownerUserId', 'ownerAgentPageId', 'ownerDriveId', 'approvalPolicy', 'resourceRestrictions', 'credentialVersion', 'policyVersion'].filter((key) => keys.includes(key));
    const expected: string[] = [];
    expect(actual).toEqual(expected);
  });
});
