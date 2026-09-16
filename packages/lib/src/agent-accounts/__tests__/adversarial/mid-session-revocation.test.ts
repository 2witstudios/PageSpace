import { describe, it } from 'vitest';

// Threat model A8, Λ8 (ASI03). Revocation ends live use.

describe('adversarial: mid-session-revocation', () => {
  it.todo('given revoke during an in-flight grant, should refuse the next resolve with revoked regardless of version');
  it.todo('given revoke during a live browser session, should end the pane within the cookie window and refuse every further typed action');
  it.todo('given delete with upstream revocation failed, should report removed:true, upstream:failed and the UI copy should state the key may still be valid at the provider');
  it.todo('given account status needs_reauth, should refuse issuance and require human re-login');
  it.todo('given an unexpired grant issued while the account was active and the account then marked revoked, needs_reauth or deleted, should return account_not_active at verifyGrant — before the plane is ever asked [0004 F5; G1a review H4]');
  it.todo('given a session account with sessionHttpEnabled false, should be unresolvable by the http-executor under any ordinary use grant (session_http default off) [PR #2637 P1]');
});
