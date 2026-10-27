/**
 * `decideReconcile` — what the next locked call does with a reconcile-required
 * ref (ADR 0005 §2.3; G1c E1). The metadata commit of a replacing write failed
 * after the Infisical write was attempted, so Infisical may hold the new
 * version or not. The adapter reads Infisical's current version and write
 * digest under the advisory lock and hands them here.
 *
 * `commit_forward` only when Infisical holds EXACTLY the pending write: its
 * version and its digest.
 *
 * `abort_pending` when Infisical still holds the version the plane last
 * committed (G2 ruling E1(b)). Every Infisical write creates a new version, so
 * an unchanged version proves the replacing write did not land: the marker is
 * dropped and the ref returns to service. Without this branch a single lost
 * write request left the account unusable forever.
 *
 * Anything else — an older version, a newer one, another writer's bytes at
 * the pending version, or an Infisical that cannot be read — is `fail_closed`:
 * nothing is served or written and the ref stays reconcile-required. Digests
 * go through the timing-safe compare. Pure.
 */
import { secureCompare } from '../../auth/secure-compare';
import type { DecideReconcile } from './store-adapter';

export const decideReconcile: DecideReconcile = ({ pending, current, observed }) => {
  if (observed === null) return { outcome: 'fail_closed' };
  if (observed.version === current) return { outcome: 'abort_pending' };
  if (observed.version !== pending.version) return { outcome: 'fail_closed' };
  if (!secureCompare(observed.digest, pending.digest)) return { outcome: 'fail_closed' };
  return { outcome: 'commit_forward', version: pending.version };
};
