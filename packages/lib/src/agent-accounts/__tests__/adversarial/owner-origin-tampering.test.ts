import { describe, it } from 'vitest';

// Threat model A9 (ASI03/ASI10). A main-DB writer who reassigns owner/origins/approval rows must not broaden authority.

describe('adversarial: owner-origin-tampering', () => {
  it.todo('given agent_accounts.ownerUserId reassigned after put and a grant signed over the tampered row, should return binding_mismatch at resolve (grant.bindingDigest differs from digestBindings(stored)) [PR #2637 P1] — I/O row, owned by G1b-store (plane bindings at resolve)');
  it.todo('given allowedOrigins widened in the main DB without step-up, should return binding_mismatch at resolve (no main-DB fact consulted by the plane) — I/O row, owned by G1b-store (plane bindings at resolve)');
  it.todo('given approvalPolicy.scope.resources widened in the main DB with policyVersion left unchanged, should return binding_mismatch at resolve (policyDigest differs) [G1a review H1] — I/O row, owned by G1b-store (plane bindings at resolve)');
  it.todo('given a resourceRestrictions repo added, or an agent_account_bindings row inserted, in the main DB without a consent-gated rebind, should return binding_mismatch at resolve [G1a review H1] — I/O row, owned by G1b-store (plane bindings at resolve)');
  it.todo('given a delegation or approval row inserted in the main DB, should not be caught by the plane bindings but by the verifier facts (F7 / F14) — both assertions run in this suite — I/O row, owned by G1b-store (plane bindings at resolve)');
  it.todo('given approval row outcome flipped to always in the DB, should still refuse irreversible/privilege classes (class_never_always) — I/O row, owned by G1b-store (plane bindings at resolve)');
  it.todo('given policyVersion bumped by an owner change, should refuse every outstanding grant with policy_epoch — I/O row, owned by G1b-store (plane bindings at resolve)');
  it.todo('given a widening performed through rebind with an OwnerConsent to exactly the new bindings, should rewrite bindings and a grant signed over them should resolve [0005 §10.21; G1a review H2] — I/O row, owned by G1b-store (plane bindings at resolve)');
  it.todo('given a DB writer who reassigned the owner and then produced a consent from the NEW owner, should return consent_invalid (the plane checks the STORED ownerRef) [0005 F15] — I/O row, owned by G1b-store (plane bindings at resolve)');
  it.todo('given a policyVersion bump written through rebind, should refuse an outstanding grant signed over the old bindings with binding_mismatch at resolve [0005 §10.21] — I/O row, owned by G1b-store (plane bindings at resolve)');
});
