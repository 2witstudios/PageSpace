/**
 * ADR 0005 §2.4, §10.20 (G1a review H1) — RED before `digest-plane-scope.ts` existed.
 * The authority (reading the main DB) and the plane (holding its own copy) must derive the same
 * `policyDigest` from the same scope, and any widening must change it.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { CanonicalOrigin } from '../../canonical-request';
import type { AgentPageId, HashBytes, UserId } from '../../grant';
import type { AccountApprovalPolicy } from '../../approval';
import type { PlaneScope } from '../store-adapter';
import { canonicalJson } from '../../canonical-json';
import { digestPlaneScope } from '../digest-plane-scope';

const sha3: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');
const origin = (value: string) => value as CanonicalOrigin;
const page = (value: string) => value as AgentPageId;

const POLICY: AccountApprovalPolicy = {
  scope: { origins: [origin('https://a.example')], operations: [{ class: 'read', name: '*' }], resources: [['repo', 'org/repo-a']] },
  trigger: 'irreversible_only',
  duration: null,
  limits: { maxUsesPerHour: 10, maxBytesOut: 1_000_000, maxConcurrent: 1 },
  approver: 'u1' as UserId,
};

const SCOPE: PlaneScope = {
  approvalPolicy: POLICY,
  resourceRestrictions: { github: ['org/repo-a'] },
  boundAgentPageIds: [page('page_b'), page('page_a')],
  allowedOrigins: [origin('https://b.example'), origin('https://a.example')],
};

describe('digestPlaneScope', () => {
  it('given the same scope with boundAgentPageIds and allowedOrigins in a different order, should return the same PolicyDigest', () => {
    const reordered: PlaneScope = { ...SCOPE, boundAgentPageIds: [page('page_a'), page('page_b')], allowedOrigins: [origin('https://a.example'), origin('https://b.example')] };
    const actual = digestPlaneScope({ scope: reordered, hash: sha3 });
    const expected = digestPlaneScope({ scope: SCOPE, hash: sha3 });
    expect(actual).toEqual(expected);
  });

  it('given a scope widened in approvalPolicy, resourceRestrictions, boundAgentPageIds or allowedOrigins, should return a different PolicyDigest for each', () => {
    const widenings: readonly PlaneScope[] = [
      { ...SCOPE, approvalPolicy: { ...POLICY, scope: { ...POLICY.scope, resources: [...POLICY.scope.resources, ['repo', 'org/repo-b']] } } },
      { ...SCOPE, approvalPolicy: null },
      { ...SCOPE, resourceRestrictions: { github: ['org/repo-a', 'org/repo-b'] } },
      { ...SCOPE, boundAgentPageIds: [...SCOPE.boundAgentPageIds, page('page_c')] },
      { ...SCOPE, allowedOrigins: [...SCOPE.allowedOrigins, origin('https://c.example')] },
    ];
    const base = digestPlaneScope({ scope: SCOPE, hash: sha3 });
    const actual = widenings.map((scope) => digestPlaneScope({ scope, hash: sha3 }) === base);
    const expected = [false, false, false, false, false];
    expect(actual).toEqual(expected);
  });

  it('given the injected hash, should be that hash over canonicalJson of the scope with its id and origin lists sorted — the bytes the authority derives independently', () => {
    const sortedScope = { ...SCOPE, boundAgentPageIds: ['page_a', 'page_b'], allowedOrigins: ['https://a.example', 'https://b.example'] };
    const actual = digestPlaneScope({ scope: SCOPE, hash: sha3 });
    const expected = sha3(new TextEncoder().encode(canonicalJson(sortedScope)));
    expect(actual).toEqual(expected);
  });

  it('given the caller-supplied lists, should not reorder them in place', () => {
    const boundAgentPageIds = [page('page_b'), page('page_a')];
    digestPlaneScope({ scope: { ...SCOPE, boundAgentPageIds }, hash: sha3 });
    const actual = boundAgentPageIds;
    const expected = ['page_b', 'page_a'];
    expect(actual).toEqual(expected);
  });
});
