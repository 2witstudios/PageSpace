import { describe, it } from 'vitest';

// Threat model A8, Λ8 (ASI03). Revocation ends live use.

describe('adversarial: mid-session-revocation', () => {
  it.todo('given revoke during an in-flight grant, should refuse the next resolve with revoked regardless of version — I/O row, owned by G1b-store (store revoke) and G6b (live pane)');
  it.todo('given revoke during a live browser session, should end the pane within the cookie window and refuse every further typed action — I/O row, owned by G1b-store (store revoke) and G6b (live pane)');
  it.todo('given delete with upstream revocation failed, should report removed:true, upstream:failed and the UI copy should state the key may still be valid at the provider — I/O row, owned by G1b-store (store revoke) and G6b (live pane)');
  it.todo('given account status needs_reauth, should refuse issuance and require human re-login — I/O row, owned by G1b-store (store revoke) and G6b (live pane)');
  it.todo('given an unexpired grant issued while the account was active and the account then marked revoked, needs_reauth or deleted, should return account_not_active at verifyGrant — before the plane is ever asked [0004 F5; G1a review H4] — the pure verifier row is grant.test.ts §8.28; the end-to-end revoke is— I/O row, owned by G1b-store (store revoke) and G6b (live pane)');
  it.todo('given a session account with sessionHttpEnabled false, should be unresolvable by the http-executor under any ordinary use grant (session_http default off) [PR #2637 P1] — I/O row, owned by G1b-store (store revoke) and G6b (live pane)');
  it.todo("given an unexpired grant with sessionHttp true and the account's sessionHttpEnabled then turned off, should return policy_epoch at verifyGrant and binding_mismatch at resolve — the flag change bumps policyVersion [0004 §8.32; G1a review M4] — the bump is written by the account write path (G2) through rebind (G1b-store)");
});
