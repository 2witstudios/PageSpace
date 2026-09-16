import { describe, it } from 'vitest';

// ADR 0004 §5 + §8.18 — RED at G1b before build-audit-record.ts exists.

describe('buildAuditRecord', () => {
  it.todo('given a canonical request with a body and a resolved credential in scope, should produce a record containing neither (property test over random bodies: JSON.stringify(record) never includes the body bytes or the secret) [0004 §8.18]');
  it.todo('given a canonical request, should carry header NAMES only, never values');
  it.todo('given every principal on the grant, should carry each by id');
  it.todo('given a denied verdict, should carry the GrantDenyReason (Record over every reason; typecheck fails on an added reason)');
});

describe('audit acceptance before execute — adapter (ADR 0004 F13)', () => {
  it.todo('given an unavailable audit store, should refuse the operation with audit_unavailable and not act');
  it.todo('given a durable allowed record, should act, then write the outcome row keyed by the same grantId');
});
