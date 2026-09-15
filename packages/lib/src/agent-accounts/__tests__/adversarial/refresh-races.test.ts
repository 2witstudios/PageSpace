import { describe, it } from 'vitest';

// Threat model A10, C5 (ASI08). One restricted refresh worker; RFC 9700 rotation.

describe('adversarial: refresh-races', () => {
  it.todo('given two concurrent refreshes for one account, should serialize under the advisory lock; exactly one rotates');
  it.todo('given a rotated refresh token presented a second time, should set needs_reauth(rotation_replay) and revoke the account grant');
  it.todo('given a crash between write and verify, should reconcile so currentVersion equals the store and the stale version is unresolvable');
  it.todo('given a grant naming the pre-rotation version inside rotationGraceMs, should resolve; outside it, version_mismatch');
  it.todo('given a provider token endpoint differing from the pinned one, should refuse the refresh (issuer confusion)');
});
