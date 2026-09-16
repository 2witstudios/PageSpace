/**
 * ADR 0005 §2.6, §10.27 — a rebind that narrows (or keeps) the scope needs no
 * consent; any widening does (G1c R13). Written RED before
 * `is-scope-narrowing.ts` exists (Control Board §7.2).
 */
import { describe, expect, it } from 'vitest';
import type { AccountApprovalPolicy } from '../../approval';
import type { CanonicalOrigin } from '../../canonical-request';
import type { AgentPageId, UserId } from '../../grant';
import type { PlaneScope } from '../store-adapter';
import { isScopeNarrowing } from '../is-scope-narrowing';

const origin = (value: string) => value as CanonicalOrigin;
const page = (value: string) => value as AgentPageId;

const POLICY: AccountApprovalPolicy = {
  scope: {
    origins: [origin('https://a.example:443'), origin('https://b.example:443')],
    operations: [
      { class: 'read', name: '*' },
      { class: 'write', name: 'issues.create' },
    ],
    resources: [
      ['repo', 'A'],
      ['repo', 'B'],
    ],
  },
  trigger: 'unknown_and_irreversible',
  duration: { until: 2_000 },
  limits: { maxUsesPerHour: 10, maxBytesOut: 1_000, maxConcurrent: 2 },
  approver: 'u1' as UserId,
};

const STORED: PlaneScope = {
  approvalPolicy: POLICY,
  resourceRestrictions: { repo: ['A', 'B'] },
  boundAgentPageIds: [page('p1'), page('p2')],
  allowedOrigins: [origin('https://a.example:443'), origin('https://b.example:443')],
  auxiliaryOrigins: [origin('https://login.a.example:443')],
  sessionHttpEnabled: true,
  providerSlug: 'github',
};

const withPolicy = (overrides: Partial<AccountApprovalPolicy>): PlaneScope => ({ ...STORED, approvalPolicy: { ...POLICY, ...overrides } });

describe('isScopeNarrowing (G1c R13)', () => {
  it('given an identical scope, or the same lists in another order, should be narrowing (no consent needed)', () => {
    const reordered: PlaneScope = { ...STORED, boundAgentPageIds: [page('p2'), page('p1')], allowedOrigins: [...STORED.allowedOrigins].reverse() };
    const actual = [isScopeNarrowing({ stored: STORED, next: STORED }), isScopeNarrowing({ stored: STORED, next: reordered })];
    expect(actual).toEqual([true, true]);
  });

  it('given each strictly narrower change, should be narrowing', () => {
    const narrower: readonly PlaneScope[] = [
      { ...STORED, allowedOrigins: [origin('https://a.example:443')] },
      { ...STORED, auxiliaryOrigins: [] },
      { ...STORED, boundAgentPageIds: [page('p1')] },
      { ...STORED, resourceRestrictions: { repo: ['A'] } },
      { ...STORED, resourceRestrictions: { repo: ['A', 'B'], org: ['acme'] } },
      { ...STORED, sessionHttpEnabled: false },
      { ...STORED, approvalPolicy: null },
      withPolicy({ scope: { ...POLICY.scope, origins: [origin('https://a.example:443')] } }),
      withPolicy({ scope: { ...POLICY.scope, operations: [{ class: 'read', name: '*' }] } }),
      withPolicy({ scope: { ...POLICY.scope, operations: [{ class: 'read', name: 'issues.list' }, { class: 'write', name: 'issues.create' }] } }),
      withPolicy({ scope: { ...POLICY.scope, resources: [['repo', 'A']] } }),
      withPolicy({ scope: { ...POLICY.scope, resources: [['repo', 'A'], ['repo', 'B'], ['org', 'acme']] } }),
      withPolicy({ trigger: 'every_use' }),
      withPolicy({ duration: { until: 1_000 } }),
      withPolicy({ limits: { maxUsesPerHour: 5, maxBytesOut: 500, maxConcurrent: 1 } }),
    ];
    const actual = narrower.map((next) => isScopeNarrowing({ stored: STORED, next }));
    expect(actual).toEqual(narrower.map(() => true));
  });

  it('given each widening or lateral change, should NOT be narrowing (consent required)', () => {
    const wider: readonly PlaneScope[] = [
      { ...STORED, allowedOrigins: [...STORED.allowedOrigins, origin('https://c.example:443')] },
      { ...STORED, auxiliaryOrigins: [origin('https://login.c.example:443')] },
      { ...STORED, boundAgentPageIds: [page('p1'), page('p3')] },
      { ...STORED, resourceRestrictions: { repo: ['A', 'B', 'C'] } },
      { ...STORED, resourceRestrictions: {} },
      { ...STORED, providerSlug: 'github-enterprise' },
      { ...STORED, providerSlug: null },
      withPolicy({ scope: { ...POLICY.scope, origins: [...POLICY.scope.origins, origin('https://c.example:443')] } }),
      withPolicy({ scope: { ...POLICY.scope, operations: [...POLICY.scope.operations, { class: 'write', name: '*' }] } }),
      withPolicy({ scope: { ...POLICY.scope, resources: [['repo', 'A'], ['repo', 'C']] } }),
      withPolicy({ scope: { ...POLICY.scope, resources: [] } }),
      withPolicy({ trigger: 'irreversible_only' }),
      withPolicy({ duration: { until: 3_000 } }),
      withPolicy({ duration: null }),
      withPolicy({ limits: { ...POLICY.limits, maxUsesPerHour: 11 } }),
      withPolicy({ limits: { ...POLICY.limits, maxBytesOut: 1_001 } }),
      withPolicy({ limits: { ...POLICY.limits, maxConcurrent: 3 } }),
      withPolicy({ approver: 'u2' as UserId }),
    ];
    const actual = wider.map((next) => isScopeNarrowing({ stored: STORED, next }));
    expect(actual).toEqual(wider.map(() => false));
  });

  it('given sessionHttpEnabled turned on, or a policy added where there was none, should NOT be narrowing', () => {
    const noSession: PlaneScope = { ...STORED, sessionHttpEnabled: false };
    const noPolicy: PlaneScope = { ...STORED, approvalPolicy: null };
    const actual = [isScopeNarrowing({ stored: noSession, next: STORED }), isScopeNarrowing({ stored: noPolicy, next: STORED })];
    expect(actual).toEqual([false, false]);
  });

  it('given a stored policy with an open-ended duration, should treat any bounded end as narrowing', () => {
    const openEnded = withPolicy({ duration: null });
    const actual = isScopeNarrowing({ stored: openEnded, next: withPolicy({ duration: { until: 5 } }) });
    expect(actual).toBe(true);
  });
});
