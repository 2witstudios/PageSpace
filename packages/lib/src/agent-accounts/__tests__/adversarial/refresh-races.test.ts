import { describe, it } from 'vitest';

// Threat model A10, C5 (ASI08). One restricted refresh worker; RFC 9700 rotation.

describe('adversarial: refresh-races', () => {
  it.todo('given two concurrent refreshes for one account, should serialize under the advisory lock; exactly one rotates — I/O row, owned by G3 (refresh worker) / G1b-store (CAS + rotation grace)');
  it.todo('given a rotated refresh token presented a second time, should set needs_reauth(rotation_replay) and revoke the account grant — I/O row, owned by G3 (refresh worker) / G1b-store (CAS + rotation grace)');
  it.todo('given a crash between write and verify, should reconcile so currentVersion equals the store and the stale version is unresolvable — I/O row, owned by G3 (refresh worker) / G1b-store (CAS + rotation grace)');
  it.todo('given a grant naming the pre-rotation version inside rotationGraceMs, should resolve; outside it, version_mismatch — I/O row, owned by G3 (refresh worker) / G1b-store (CAS + rotation grace)');
  it.todo('given a provider token endpoint differing from the pinned one, should refuse the refresh (issuer confusion) — I/O row, owned by G3 (refresh worker) / G1b-store (CAS + rotation grace)');
  it.todo('given a compromised http-executor or relay-runner identity, should be unable to obtain a refreshToken from resolve (OAuth2AccessMaterial has no such field) [PR #2637 P1] — I/O row, owned by G3 (refresh worker) / G1b-store (CAS + rotation grace)');
});
