export type FlyCertResponse =
  | { ok: true; configured: boolean }
  | { ok: false; error: string };

export type CertAction =
  | { action: 'provision' }
  | { action: 'poll-again' }
  | { action: 'mark-active' }
  | { action: 'mark-failed'; reason: string };

export type CertEligibleStatus = 'verified' | 'provisioning' | 'active' | 'cert_failed';

/** Returns true when a domain's status allows cert provisioning or polling. */
export function isCertEligible(status: string): status is CertEligibleStatus {
  return status === 'verified' || status === 'provisioning' || status === 'active' || status === 'cert_failed';
}

/**
 * Pure decision function: given the domain's current status and a Fly cert API
 * response, return the next action to take.
 *
 * - Fly error → mark-failed (stop polling; surface the error)
 * - configured=true → mark-active (cert is live)
 * - configured=false + verified|cert_failed → provision (request cert, move to provisioning)
 * - configured=false + provisioning|active → poll-again (still waiting)
 */
export function nextCertAction(currentStatus: CertEligibleStatus, flyCert: FlyCertResponse): CertAction {
  if (!flyCert.ok) {
    return { action: 'mark-failed', reason: flyCert.error || 'Fly cert API error' };
  }
  if (flyCert.configured) {
    return { action: 'mark-active' };
  }
  if (currentStatus === 'verified' || currentStatus === 'cert_failed') {
    return { action: 'provision' };
  }
  return { action: 'poll-again' };
}

/** Map a CertAction to the DB status column value. */
export function certActionToDbStatus(action: CertAction): 'provisioning' | 'active' | 'cert_failed' {
  switch (action.action) {
    case 'provision':
    case 'poll-again':
      return 'provisioning';
    case 'mark-active':
      return 'active';
    case 'mark-failed':
      return 'cert_failed';
  }
}
