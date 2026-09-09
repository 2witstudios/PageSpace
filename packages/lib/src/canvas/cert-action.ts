import {
  describeOwnershipVerification,
  type FlyOwnershipRequirement,
  type FlyOwnershipVerification,
} from '../validators/fly-ownership';

export type FlyCertResponse =
  | {
      ok: true;
      /** Fly reports the certificate as live and servable for this hostname. */
      configured: boolean;
      /**
       * Fly's raw status string (`'pending_validation' | 'active'` on the REST
       * certificates resource). Carried alongside `configured` rather than
       * replacing it so the decision below stays a boolean question while the
       * exact state is still available for logs and the settings UI.
       */
      status?: string;
      /**
       * The `_fly-ownership` TXT record Fly wants published, when it wants one.
       * `null`/absent means validation is proceeding by reachability instead.
       * See `validators/fly-ownership.ts` for why the distinction matters.
       */
      ownership?: FlyOwnershipRequirement | null;
      /** Whether Fly has already SEEN an acceptable ownership TXT. */
      ownershipTxtConfigured?: boolean;
    }
  | { ok: false; error: string };

export type CertAction =
  | { action: 'provision' }
  | { action: 'poll-again' }
  | { action: 'mark-active' }
  /**
   * Fly is waiting on an ownership TXT the customer has not published. NOT a
   * failure — the domain is fine and the certificate will issue the moment the
   * record appears — so this maps to the same `provisioning` status as
   * `poll-again` and never clears mirrored content. It exists as its own action
   * purely so the caller can surface WHAT is missing: through the certificate
   * status alone, "still validating" and "blocked on a record nobody asked the
   * customer for" are indistinguishable, and they need opposite responses.
   */
  | { action: 'blocked-on-ownership'; reason: string }
  | { action: 'mark-failed'; reason: string };

export type CertEligibleStatus = 'verified' | 'provisioning' | 'active' | 'cert_failed';

/** Returns true when a domain's status allows cert provisioning or polling. */
export function isCertEligible(status: string): status is CertEligibleStatus {
  return status === 'verified' || status === 'provisioning' || status === 'active' || status === 'cert_failed';
}

/**
 * "Serving" statuses = DNS-confirmed hosts that should hold mirrored content,
 * independent of TLS cert state. A host serves content the moment DNS is
 * verified; the cert only controls whether Fly TLS-terminates the host at the
 * edge. Content mirroring keys off this predicate; canonical/primary-host
 * resolution keys off `active` only.
 *
 * True for: verified | provisioning | active.
 * False for: pending | failed | dns_failed | cert_failed (and anything else).
 */
export function isServingStatus(status: string): boolean {
  return status === 'verified' || status === 'provisioning' || status === 'active';
}

/**
 * Pure decision function: given the domain's current status and a Fly cert API
 * response, return the next action to take.
 *
 * - Fly error → mark-failed (stop polling; surface the error)
 * - configured=true → mark-active (cert is live)
 * - configured=false + an unsatisfied ownership TXT → blocked-on-ownership
 * - configured=false + verified|cert_failed → provision (request cert, move to provisioning)
 * - configured=false + provisioning|active → poll-again (still waiting)
 *
 * `ownership` is the result of pre-validating the `_fly-ownership` TXT
 * (`validators/fly-ownership.ts`). It is OPTIONAL and defaults to "no
 * pre-validation was run", which reproduces the previous behaviour exactly —
 * a caller that does not resolve DNS gets the same answer it always did.
 * Checked BEFORE the `configured` branch is not an option: a live certificate
 * is live regardless of what any record says, so `mark-active` still wins.
 */
export function nextCertAction(
  currentStatus: CertEligibleStatus,
  flyCert: FlyCertResponse,
  ownership: FlyOwnershipVerification | null = null,
): CertAction {
  if (!flyCert.ok) {
    return { action: 'mark-failed', reason: flyCert.error || 'Fly cert API error' };
  }
  if (flyCert.configured) {
    return { action: 'mark-active' };
  }
  if (ownership && (ownership.state === 'missing' || ownership.state === 'mismatched')) {
    return {
      action: 'blocked-on-ownership',
      reason: describeOwnershipVerification(ownership) ?? 'Fly is waiting on an ownership TXT record',
    };
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
    case 'blocked-on-ownership':
      return 'provisioning';
    case 'mark-active':
      return 'active';
    case 'mark-failed':
      return 'cert_failed';
  }
}
