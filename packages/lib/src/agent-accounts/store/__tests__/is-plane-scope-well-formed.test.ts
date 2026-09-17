/**
 * ADR 0005 §2.6 (G1c review of PR #2660, HIGH) — the plane validates every
 * PlaneScope value it compares. Non-numeric limits, a non-numeric deadline or
 * an unknown trigger made every comparison false, so a widened policy passed
 * as a "narrowing" and then never limited or expired. Written RED before
 * `is-plane-scope-well-formed.ts` exists.
 */
import { describe, expect, it } from 'vitest';
import type { AccountApprovalPolicy } from '../../approval';
import type { CanonicalOrigin } from '../../canonical-request';
import type { UserId } from '../../grant';
import type { PlaneScope } from '../store-adapter';
import { isPlaneScopeWellFormed } from '../is-plane-scope-well-formed';

const POLICY: AccountApprovalPolicy = {
  scope: { origins: ['https://a.example:443' as CanonicalOrigin], operations: [{ class: 'read', name: '*' }], resources: [['repo', 'A']] },
  trigger: 'irreversible_only',
  duration: { until: 1_000 },
  limits: { maxUsesPerHour: 10, maxBytesOut: 1_000, maxConcurrent: 1 },
  approver: 'u1' as UserId,
};
const SCOPE: PlaneScope = {
  approvalPolicy: POLICY,
  resourceRestrictions: { repo: ['A'] },
  boundAgentPageIds: [],
  allowedOrigins: ['https://a.example:443' as CanonicalOrigin],
  auxiliaryOrigins: [],
  sessionHttpEnabled: false,
  providerSlug: 'github',
};
const withPolicy = (overrides: Record<string, unknown>) => ({ ...SCOPE, approvalPolicy: { ...POLICY, ...overrides } }) as unknown as PlaneScope;
const withScope = (overrides: Record<string, unknown>) => ({ ...SCOPE, ...overrides }) as unknown as PlaneScope;

describe('isPlaneScopeWellFormed (G1c review HIGH)', () => {
  it('given a typed scope, with or without a policy and an open-ended duration, should be well formed', () => {
    const actual = [SCOPE, { ...SCOPE, approvalPolicy: null, providerSlug: null }, withPolicy({ duration: null })].map((scope) => isPlaneScopeWellFormed({ scope }));
    expect(actual).toEqual([true, true, true]);
  });

  it('given a limit that is not a finite non-negative integer, should be malformed', () => {
    const bad = ['x', -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, null];
    const actual = bad.flatMap((value) =>
      (['maxUsesPerHour', 'maxBytesOut', 'maxConcurrent'] as const).map((key) => isPlaneScopeWellFormed({ scope: withPolicy({ limits: { ...POLICY.limits, [key]: value } }) })),
    );
    expect(actual).toEqual(actual.map(() => false));
  });

  it('given a deadline that is not a finite number, an unknown trigger, a missing approver or a malformed operation, should be malformed', () => {
    const variants = [
      withPolicy({ duration: { until: 'x' } }),
      withPolicy({ duration: {} }),
      withPolicy({ trigger: 'never_ask' }),
      withPolicy({ approver: 7 }),
      withPolicy({ scope: { ...POLICY.scope, operations: [{ class: 'admin', name: '*' }] } }),
      withPolicy({ scope: { ...POLICY.scope, resources: [['repo']] } }),
      withPolicy({ scope: { ...POLICY.scope, origins: 'https://a.example:443' } }),
    ];
    const actual = variants.map((scope) => isPlaneScopeWellFormed({ scope }));
    expect(actual).toEqual(variants.map(() => false));
  });

  it('given top-level fields of the wrong shape, should be malformed', () => {
    const variants = [
      withScope({ resourceRestrictions: { repo: 'A' } }),
      withScope({ resourceRestrictions: ['repo'] }),
      withScope({ boundAgentPageIds: 'p1' }),
      withScope({ allowedOrigins: [1] }),
      withScope({ auxiliaryOrigins: null }),
      withScope({ sessionHttpEnabled: 'false' }),
      withScope({ providerSlug: 3 }),
      withScope({ approvalPolicy: 'always' }),
      null as unknown as PlaneScope,
    ];
    const actual = variants.map((scope) => isPlaneScopeWellFormed({ scope }));
    expect(actual).toEqual(variants.map(() => false));
  });
});
