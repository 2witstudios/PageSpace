/**
 * L2·G2 — `planeBindingsFor`: the plane scope and bindings a reference row
 * stands for. It is what the ingress `put` pins in the plane AND what the
 * authority signs as `bindingDigest`, so both sides derive it from one pure
 * function; a drift between them would make every grant `binding_mismatch`.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { AgentAccountRecord } from '@pagespace/db/schema/agent-accounts';
import type { AgentPageId, HashBytes } from '../grant';
import { digestPlaneScope } from '../store/digest-plane-scope';
import { planeBindingsFor } from '../plane-bindings-for';

const sha3: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');

const row = {
  id: 'acct_1',
  kind: 'api_key',
  ownerKind: 'agent_page',
  ownerUserId: null,
  ownerAgentPageId: 'page_1',
  ownerDriveId: 'drive_1',
  tenantId: 'drive:drive_1',
  providerSlug: null,
  allowedOrigins: ['https://b.example:443', 'https://a.example:443'],
  auxiliaryOrigins: [],
  resourceRestrictions: {},
  approvalPolicy: null,
  policyVersion: 3,
  sessionHttpEnabled: false,
} as unknown as AgentAccountRecord;

describe('planeBindingsFor', () => {
  it('given an agent-page-owned row, should bind the owner page, the sorted origins and the policy digest of exactly that scope', () => {
    const actual = planeBindingsFor({ row, boundAgentPageIds: [], hash: sha3 });
    const scope = {
      approvalPolicy: null,
      resourceRestrictions: {},
      boundAgentPageIds: ['page_1'],
      allowedOrigins: ['https://a.example:443', 'https://b.example:443'],
      auxiliaryOrigins: [],
      sessionHttpEnabled: false,
      providerSlug: null,
    };
    const expected = {
      scope,
      bindings: {
        tenantId: 'drive:drive_1',
        ownerRef: { kind: 'agent_page', agentPageId: 'page_1', driveId: 'drive_1' },
        allowedOrigins: ['https://a.example:443', 'https://b.example:443'],
        policyVersion: 3,
        policyDigest: digestPlaneScope({ scope: scope as never, hash: sha3 }),
        kind: 'api_key',
      },
    };
    expect(actual).toEqual(expected);
  });

  it('given a user-owned row, should bind the user owner and only the explicitly bound agent pages, deduplicated and sorted', () => {
    const userRow = { ...row, ownerKind: 'user', ownerUserId: 'u1', ownerAgentPageId: null, ownerDriveId: null, tenantId: 'user:u1' } as AgentAccountRecord;
    const verdict = planeBindingsFor({ row: userRow, boundAgentPageIds: ['p2', 'p1', 'p2'] as AgentPageId[], hash: sha3 });
    const actual = { owner: verdict.bindings.ownerRef, pages: verdict.scope.boundAgentPageIds };
    const expected = { owner: { kind: 'user', userId: 'u1' }, pages: ['p1', 'p2'] };
    expect(actual).toEqual(expected);
  });
});
