import { describe, it } from 'vitest';

// Threat model A8, Λ8 (ASI03). Revocation ends live use.

describe('adversarial: mid-session-revocation', () => {
  it.todo('given revoke during an in-flight grant, should refuse the next resolve with revoked regardless of version');
  it.todo('given revoke during a live browser session, should end the pane within the cookie window and refuse every further typed action');
  it.todo('given delete with upstream revocation failed, should report removed:true, upstream:failed and the UI copy should state the key may still be valid at the provider');
  it.todo('given account status needs_reauth, should refuse issuance and require human re-login');
});
