/**
 * ADR 0004 §4.3 + §8.17, §8.22 — what the authority must obtain before it
 * issues a grant. Written RED at G1b before `decide-approval.ts` existed.
 */
import { describe, it, expect } from 'vitest';
import { decideApproval } from '../decide-approval';
import type { AccountApprovalPolicy, AlwaysAllowedByClass, ApprovalScope, UsageCounters } from '../approval';
import type { CanonicalOrigin, ResourceRestrictions } from '../canonical-request';
import type { OperationClass, OperationRef, RequestDigest, UserId } from '../grant';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://api.github.com:443' as CanonicalOrigin;
const OTHER_ORIGIN = 'https://api.gitlab.com:443' as CanonicalOrigin;
const DIGEST = 'digest_1' as RequestDigest;
const READ: OperationRef = { class: 'read', name: 'github.issues.list' };
const WRITE: OperationRef = { class: 'write', name: 'github.issues.create' };
const NO_USAGE: UsageCounters = { usesThisHour: 0, bytesOutThisHour: 0, concurrent: 0 };

function policy(overrides: Partial<AccountApprovalPolicy> = {}): AccountApprovalPolicy {
  return {
    scope: { origins: [ORIGIN], operations: [{ class: 'read', name: '*' }, { class: 'write', name: '*' }], resources: [] },
    trigger: 'irreversible_only',
    duration: null,
    limits: { maxUsesPerHour: 10, maxBytesOut: 1_000_000, maxConcurrent: 2 },
    approver: 'user_1' as UserId,
    ...overrides,
  };
}

function decide(
  operation: OperationRef,
  p: AccountApprovalPolicy | null,
  extra: {
    resources?: readonly (readonly [string, string])[];
    origin?: CanonicalOrigin;
    now?: number;
    usage?: UsageCounters;
    restrictions?: ResourceRestrictions;
    delegationScope?: ApprovalScope | null;
  } = {},
) {
  return decideApproval({
    operation,
    restrictions: extra.restrictions ?? {},
    delegationScope: extra.delegationScope ?? null,
    policy: p,
    requestDigest: DIGEST,
    origin: extra.origin ?? ORIGIN,
    resources: extra.resources ?? [],
    now: extra.now ?? NOW,
    usage: extra.usage ?? NO_USAGE,
  });
}

describe('decideApproval', () => {
  it('given class read under an unexpired always policy in scope, should return policy', () => {
    const actual = decide(READ, policy());
    expect(actual).toEqual({ kind: 'policy' });
  });

  it('given no policy at all, should return concrete for read and write', () => {
    const actual = [decide(READ, null), decide(WRITE, null)];
    expect(actual).toEqual([{ kind: 'concrete', stepUp: false }, { kind: 'concrete', stepUp: false }]);
  });

  it('given class write under an always policy whose limits.maxUsesPerHour is exhausted, should return refuse(limits_exceeded) [0004 §8.17]', () => {
    const actual = decide(WRITE, policy(), { usage: { ...NO_USAGE, usesThisHour: 10 } });
    expect(actual).toEqual({ kind: 'refuse', reason: 'limits_exceeded' });
  });

  it('given maxConcurrent or maxBytesOut reached, should return refuse(limits_exceeded)', () => {
    const actual = [decide(WRITE, policy(), { usage: { ...NO_USAGE, concurrent: 2 } }), decide(WRITE, policy(), { usage: { ...NO_USAGE, bytesOutThisHour: 1_000_000 } })];
    expect(actual).toEqual([{ kind: 'refuse', reason: 'limits_exceeded' }, { kind: 'refuse', reason: 'limits_exceeded' }]);
  });

  it('given an always policy whose duration.until has passed, should return concrete [0004 §8.17]', () => {
    const actual = decide(READ, policy({ duration: { until: NOW - 1 } }));
    expect(actual).toEqual({ kind: 'concrete', stepUp: false });
  });

  it('given an always policy whose duration.until is still ahead, should return policy', () => {
    const actual = decide(READ, policy({ duration: { until: NOW + 1 } }));
    expect(actual).toEqual({ kind: 'policy' });
  });

  it('given class irreversible, should return concrete regardless of policy (class_never_always) [0004 F15]', () => {
    const op: OperationRef = { class: 'irreversible', name: 'github.pr.merge' };
    const actual = [decide(op, null), decide(op, policy())];
    expect(actual).toEqual([{ kind: 'concrete', stepUp: false }, { kind: 'concrete', stepUp: false }]);
  });

  it('given a policy row that claims to cover an irreversible or privilege operation (tampered), should return refuse(class_never_always)', () => {
    const merge: OperationRef = { class: 'irreversible', name: 'github.pr.merge' };
    const token: OperationRef = { class: 'privilege', name: 'github.token.create' };
    const actual = [decide(merge, policy({ scope: { origins: [ORIGIN], operations: [merge], resources: [] } })), decide(token, policy({ scope: { origins: [ORIGIN], operations: [{ class: 'privilege', name: '*' }], resources: [] } }))];
    expect(actual).toEqual([{ kind: 'refuse', reason: 'class_never_always' }, { kind: 'refuse', reason: 'class_never_always' }]);
  });

  it('given class privilege, should return concrete with stepUp true [0004 §3.4]', () => {
    const op: OperationRef = { class: 'privilege', name: 'github.token.create' };
    const actual = [decide(op, null), decide(op, policy())];
    expect(actual).toEqual([{ kind: 'concrete', stepUp: true }, { kind: 'concrete', stepUp: true }]);
  });

  it('given class unknown and no explicit generic-capability policy, should return concrete', () => {
    const op: OperationRef = { class: 'unknown', name: 'generic.http' };
    const actual = [decide(op, null), decide(op, policy())];
    expect(actual).toEqual([{ kind: 'concrete', stepUp: false }, { kind: 'concrete', stepUp: false }]);
  });

  it('given class unknown under a policy that names the generic capability exactly (never by wildcard), should return policy', () => {
    const op: OperationRef = { class: 'unknown', name: 'generic.http' };
    const actual = [
      decide(op, policy({ scope: { origins: [ORIGIN], operations: [op], resources: [] } })),
      decide(op, policy({ scope: { origins: [ORIGIN], operations: [{ class: 'unknown', name: '*' }], resources: [] } })),
    ];
    expect(actual).toEqual([{ kind: 'policy' }, { kind: 'concrete', stepUp: false }]);
  });

  it('given an origin outside policy.scope.origins, should return refuse(out_of_scope)', () => {
    const actual = decide(READ, policy(), { origin: OTHER_ORIGIN });
    expect(actual).toEqual({ kind: 'refuse', reason: 'out_of_scope' });
  });

  it('given an operation outside policy.scope.operations, should return concrete (the policy does not speak to it)', () => {
    const actual = decide(WRITE, policy({ scope: { origins: [ORIGIN], operations: [{ class: 'read', name: '*' }], resources: [] } }));
    expect(actual).toEqual({ kind: 'concrete', stepUp: false });
  });

  it('given an always policy whose scope.resources names repo A and request resources naming repo B, should return refuse(out_of_scope) [0004 §8.22; PR #2637 P1]', () => {
    const actual = decide(WRITE, policy({ scope: { origins: [ORIGIN], operations: [WRITE], resources: [['repo', 'octo/A']] } }), { resources: [['repo', 'octo/B']] });
    expect(actual).toEqual({ kind: 'refuse', reason: 'out_of_scope' });
  });

  it('given an always policy whose scope.resources names repo A and request resources naming repo A, should return policy [0004 §8.22]', () => {
    const actual = decide(WRITE, policy({ scope: { origins: [ORIGIN], operations: [WRITE], resources: [['repo', 'octo/A']] } }), { resources: [['repo', 'octo/A']] });
    expect(actual).toEqual({ kind: 'policy' });
  });

  it('given a policy that restricts a resource key the request does not name, should return refuse(out_of_scope) (an unbounded request is not inside a bounded policy)', () => {
    const actual = decide(WRITE, policy({ scope: { origins: [ORIGIN], operations: [WRITE], resources: [['repo', 'octo/A']] } }), { resources: [['org', 'octo']] });
    expect(actual).toEqual({ kind: 'refuse', reason: 'out_of_scope' });
  });

  it('given trigger every_use, should return concrete even for a read in scope', () => {
    const actual = decide(READ, policy({ trigger: 'every_use' }));
    expect(actual).toEqual({ kind: 'concrete', stepUp: false });
  });

  it('given trigger unknown_and_irreversible, should return policy for read/write and concrete for unknown even when named', () => {
    const generic: OperationRef = { class: 'unknown', name: 'generic.http' };
    const p = policy({ trigger: 'unknown_and_irreversible', scope: { origins: [ORIGIN], operations: [{ class: 'read', name: '*' }, { class: 'write', name: '*' }, generic], resources: [] } });
    const actual = [decide(READ, p), decide(WRITE, p), decide(generic, p)];
    expect(actual).toEqual([{ kind: 'policy' }, { kind: 'policy' }, { kind: 'concrete', stepUp: false }]);
  });

  it('given AlwaysAllowedByClass, should be a Record over every OperationClass (typecheck fails on an added class)', () => {
    const table: AlwaysAllowedByClass = { read: true, write: true, irreversible: false, privilege: false, unknown: true };
    const classes: readonly OperationClass[] = ['read', 'write', 'irreversible', 'privilege', 'unknown'];
    const actual = classes.map((c) => table[c]);
    expect(actual).toEqual([true, true, false, false, true]);
  });
});

describe('decideApproval — account resource restrictions (ADR 0004 §4.3a, §8.39; G1c R5)', () => {
  const restrictions: ResourceRestrictions = { 'slack.channel': ['C1'] };
  const POST: OperationRef = { class: 'write', name: 'slack.chat.postMessage' };

  it('given a restriction key the request does not bind, should refuse out_of_scope whatever the policy — including none', () => {
    const actual = [decide(POST, policy({ scope: { origins: [ORIGIN], operations: [POST], resources: [] } }), { restrictions }), decide(POST, null, { restrictions })];
    expect(actual).toEqual([
      { kind: 'refuse', reason: 'out_of_scope' },
      { kind: 'refuse', reason: 'out_of_scope' },
    ]);
  });

  it('given a bound value outside the restriction list, or one value in and one out, should refuse out_of_scope', () => {
    const actual = [
      decide(POST, null, { restrictions, resources: [['slack.channel', 'C2']] }),
      decide(POST, null, { restrictions, resources: [['slack.channel', 'C1'], ['slack.channel', 'C2']] }),
    ];
    expect(actual).toEqual([
      { kind: 'refuse', reason: 'out_of_scope' },
      { kind: 'refuse', reason: 'out_of_scope' },
    ]);
  });

  it('given every restriction key bound with allowed values, should fall through to the approval decision', () => {
    const actual = [decide(POST, null, { restrictions, resources: [['slack.channel', 'C1']] }), decide(READ, policy(), { restrictions: {}, resources: [] })];
    expect(actual).toEqual([{ kind: 'concrete', stepUp: false }, { kind: 'policy' }]);
  });

  it('given a restriction key with an empty allowlist, should refuse any request — binding it or not', () => {
    const actual = [decide(POST, null, { restrictions: { 'slack.channel': [] }, resources: [['slack.channel', 'C1']] }), decide(POST, null, { restrictions: { 'slack.channel': [] } })];
    expect(actual).toEqual([
      { kind: 'refuse', reason: 'out_of_scope' },
      { kind: 'refuse', reason: 'out_of_scope' },
    ]);
  });

  it('given a policy scope resource key the request does not bind, should refuse out_of_scope (never read as unrestricted)', () => {
    const scoped = policy({ scope: { origins: [ORIGIN], operations: [WRITE], resources: [['repo', 'A']] } });
    const actual = decide(WRITE, scoped, { resources: [] });
    expect(actual).toEqual({ kind: 'refuse', reason: 'out_of_scope' });
  });
});

describe('decideApproval — the delegation scope of an unattended run (ADR 0004 §4.3a, §8.40; G1c R12)', () => {
  const readOnlyRepoA: ApprovalScope = { origins: [ORIGIN], operations: [{ class: 'read', name: '*' }], resources: [['repo', 'A']] };
  const wide = policy({ scope: { origins: [ORIGIN, OTHER_ORIGIN], operations: [{ class: 'read', name: '*' }, { class: 'write', name: '*' }], resources: [] } });

  it('given a delegation scoped to read-only repo A, should refuse a write, repo B, or another origin even under a policy that covers them', () => {
    const actual = [
      decide(WRITE, wide, { delegationScope: readOnlyRepoA, resources: [['repo', 'A']] }),
      decide(READ, wide, { delegationScope: readOnlyRepoA, resources: [['repo', 'B']] }),
      decide(READ, wide, { delegationScope: readOnlyRepoA, resources: [['repo', 'A']], origin: OTHER_ORIGIN }),
    ];
    expect(actual).toEqual([
      { kind: 'refuse', reason: 'out_of_scope' },
      { kind: 'refuse', reason: 'out_of_scope' },
      { kind: 'refuse', reason: 'out_of_scope' },
    ]);
  });

  it('given a request inside the delegation scope, should decide by the policy exactly as a live session would', () => {
    const actual = [decide(READ, wide, { delegationScope: readOnlyRepoA, resources: [['repo', 'A']] }), decide(READ, null, { delegationScope: readOnlyRepoA, resources: [['repo', 'A']] })];
    expect(actual).toEqual([{ kind: 'policy' }, { kind: 'concrete', stepUp: false }]);
  });

  it('given a delegation that names an unknown operation only by wildcard, should refuse it — a wildcard never reaches unknown', () => {
    const generic: OperationRef = { class: 'unknown', name: 'generic_request' };
    const wildcard: ApprovalScope = { origins: [ORIGIN], operations: [{ class: 'unknown', name: '*' }], resources: [] };
    const actual = decide(generic, null, { delegationScope: wildcard });
    expect(actual).toEqual({ kind: 'refuse', reason: 'out_of_scope' });
  });
});
