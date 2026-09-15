import { describe, it } from 'vitest';

// Threat model A8, Λ8 (ASI03). Revocation ends live use.

describe('adversarial: mid-session-revocation', () => {
  it.todo('given revoke during an in-flight grant, should refuse the next resolve with revoked regardless of version — I/O row, owned by G1b-store (store revoke) and G6b (live pane)');
  it.todo('given revoke during a live browser session, should end the pane within the cookie window and refuse every further typed action — I/O row, owned by G1b-store (store revoke) and G6b (live pane)');
  it.todo('given delete with upstream revocation failed, should report removed:true, upstream:failed and the UI copy should state the key may still be valid at the provider — I/O row, owned by G1b-store (store revoke) and G6b (live pane)');
  it.todo('given account status needs_reauth, should refuse issuance and require human re-login — I/O row, owned by G1b-store (store revoke) and G6b (live pane)');
  it.todo('given a session account with sessionHttpEnabled false, should be unresolvable by the http-executor under any ordinary use grant (session_http default off) [PR #2637 P1] — I/O row, owned by G1b-store (store revoke) and G6b (live pane)');
});
