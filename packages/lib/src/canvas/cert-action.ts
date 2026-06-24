export type FlyCertResponse =
  | { ok: true; configured: boolean }
  | { ok: false; error: string };

export type CertActionStatus = 'provision' | 'poll-again' | 'mark-active' | 'mark-failed';

export type CertAction =
  | { action: 'provision' }
  | { action: 'poll-again' }
  | { action: 'mark-active' }
  | { action: 'mark-failed'; reason: string };

export type CertEligibleStatus = 'verified' | 'provisioning' | 'active';

/**
 * Pure decision function: given the domain's current status and a Fly cert API
 * response, return the next action to take.
 *
 * - Fly error → mark-failed (stop polling; surface the error)
 * - configured=true → mark-active (cert is live)
 * - configured=false + verified → provision (first-time request accepted, move to provisioning)
 * - configured=false + provisioning|active → poll-again (still waiting)
 */
export function nextCertAction(currentStatus: CertEligibleStatus, flyCert: FlyCertResponse): CertAction {
  if (!flyCert.ok) {
    return { action: 'mark-failed', reason: flyCert.error || 'Fly cert API error' };
  }
  if (flyCert.configured) {
    return { action: 'mark-active' };
  }
  if (currentStatus === 'verified') {
    return { action: 'provision' };
  }
  return { action: 'poll-again' };
}

/** Map a CertAction to the DB status column value. */
export function certActionToDbStatus(action: CertAction): 'provisioning' | 'active' | 'failed' {
  switch (action.action) {
    case 'provision':
    case 'poll-again':
      return 'provisioning';
    case 'mark-active':
      return 'active';
    case 'mark-failed':
      return 'failed';
  }
}
