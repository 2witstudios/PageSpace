import { describe, it } from 'vitest';

// Threat model A9 (ASI03/ASI10). A main-DB writer who reassigns owner/origins/approval rows must not broaden authority.

describe('adversarial: owner-origin-tampering', () => {
  it.todo('given agent_accounts.ownerUserId reassigned after put and a grant signed over the tampered row, should return binding_mismatch at resolve (grant.bindingDigest differs from digestBindings(stored)) [PR #2637 P1]');
  it.todo('given allowedOrigins widened in the main DB without step-up, should return binding_mismatch at resolve (no main-DB fact consulted by the plane)');
  it.todo('given approval row outcome flipped to always in the DB, should still refuse irreversible/privilege classes (class_never_always)');
  it.todo('given policyVersion bumped by an owner change, should refuse every outstanding grant with policy_epoch');
  it.todo('given a widening performed through put with step-up, should rewrite bindings and subsequent resolve should succeed');
});
