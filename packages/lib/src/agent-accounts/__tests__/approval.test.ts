import { describe, it } from 'vitest';

// ADR 0004 §4.3 + §8.17 — RED at G1b before decide-approval.ts exists.

describe('decideApproval', () => {
  it.todo('given class read under an unexpired always policy in scope, should return policy');
  it.todo('given class write under an always policy whose limits.maxUsesPerHour is exhausted, should return refuse(limits_exceeded) [0004 §8.17]');
  it.todo('given an always policy whose duration.until has passed, should return concrete [0004 §8.17]');
  it.todo('given class irreversible, should return concrete regardless of policy (class_never_always) [0004 F15]');
  it.todo('given class privilege, should return concrete with stepUp true [0004 §3.4]');
  it.todo('given class unknown and no explicit generic-capability policy, should return concrete');
  it.todo('given an origin outside policy.scope.origins, should return refuse(out_of_scope)');
  it.todo('given AlwaysAllowedByClass, should be a Record over every OperationClass (typecheck fails on an added class)');
});
