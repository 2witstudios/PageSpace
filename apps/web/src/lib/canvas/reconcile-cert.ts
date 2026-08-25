import 'server-only';

import { loggers } from '@pagespace/lib/logging/logger-config';
import { nextCertAction, certActionToDbStatus, isCertEligible } from '@pagespace/lib/canvas/cert-action';
import type { CertAction, CertEligibleStatus, FlyCertResponse } from '@pagespace/lib/canvas/cert-action';
import {
  describeOwnershipVerification,
  verifyFlyOwnershipTxt,
  type FlyOwnershipVerification,
} from '@pagespace/lib/validators/fly-ownership';
import { resolveAppRouterFlyAppName } from '@pagespace/lib/services/app-hosting/routing-env';
import { addCertificate, recheckCertificate } from '@/lib/fly/certs';
import { resolveTxtRecords } from '@/lib/publish/dns-resolver';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { mirrorDriveToCustomHost, clearCustomHost } from '@/lib/canvas/custom-domain-mirror';
import { regeneratePublishedSiteFiles, renderDomainNotFoundOverride } from '@/lib/canvas/publish-page';

/**
 * Certs attach to the ROUTER app — the app Fly TLS-terminates for us. Resolved
 * through `resolveAppRouterFlyAppName()` (which still falls back to
 * `FLY_PROXY_APP_NAME`) rather than read here, so custom-domain certs and the
 * published-app routing tier can never end up naming two different apps: a cert
 * issued on app A does not terminate traffic arriving at app B.
 */
function routerAppName(): string {
  return resolveAppRouterFlyAppName();
}

/**
 * Pre-validate the `_fly-ownership` TXT record, when Fly asked for one.
 *
 * Runs ONLY when Fly reports an ownership requirement it has not already
 * satisfied — the common case (a hostname whose A/AAAA already point at us
 * validates by reachability) does no DNS work at all. Returns null when there is
 * nothing to check, which `nextCertAction` reads as "no pre-validation was run"
 * and treats exactly as it did before this existed.
 *
 * Never throws: a DNS failure here must not turn into a cert failure. The
 * resolver already collapses NXDOMAIN/ENODATA/timeout to `[]`, and `[]` reads as
 * `missing` — which is non-destructive (it maps to `provisioning`, see the
 * `blocked-on-ownership` action) and merely means the next poll asks again.
 */
async function preValidateOwnership(flyCert: FlyCertResponse): Promise<FlyOwnershipVerification | null> {
  if (!flyCert.ok) return null;
  if (flyCert.ownershipTxtConfigured) return null;
  const requirement = flyCert.ownership ?? null;
  if (!requirement) return null;
  const records = await resolveTxtRecords(requirement.name).catch(() => [] as string[][]);
  return verifyFlyOwnershipTxt({ requirement, records });
}

/** The minimal domain shape `reconcileCustomDomainCert` needs. */
export interface CertReconcileDomain {
  id: string;
  driveId: string;
  hostname: string;
  status: string;
  /** Platform-owned domains (e.g. pagespace.ai) never need Fly cert reconcile. */
  platformOwned?: boolean;
}

export interface CertReconcileResult {
  /** The resulting DB status (equals the input status when no work was done). */
  status: string;
  /** The cert action taken, or `null` when reconcile was a no-op. */
  action: CertAction['action'] | null;
  /**
   * What the customer still has to do, when the certificate is blocked on a DNS
   * record they have not published. Null whenever nothing is waiting on them.
   *
   * Returned rather than persisted: it is derived from Fly's live answer plus a
   * live DNS read, so a column holding it would be stale the moment the customer
   * fixed their zone — and the status column already records the state.
   */
  ownershipInstruction?: string | null;
}

export interface CertReconcileOptions {
  /**
   * Whether a Fly API error may transition the domain to `cert_failed` (and
   * clear its mirrored prefix). Defaults to `true` for the explicit "Check SSL"
   * action. The lazy domains-list GET passes `false`: a transient Fly
   * error/timeout on a mere read must NOT flip a DNS-valid domain to
   * `cert_failed` or wipe its content — that destructive transition is reserved
   * for the user-initiated refresh.
   */
  allowFailureTransition?: boolean;
}

/**
 * Advance a custom domain's TLS cert state by one step, shared by the explicit
 * "Check SSL" route and the lazy reconcile on the domains-list GET.
 *
 * Flow (pure decision in `@pagespace/lib/canvas/cert-action`):
 *   addCertificate (idempotent) → nextCertAction(status, flyCert) → persist status.
 *   - `→ active` (and was not already active): regenerate the drive's site files
 *     so sitemap/robots/canonical adopt the now-active custom host. (Content is
 *     already mirrored at verify time; this only refreshes the canonical-bearing
 *     site files.)
 *   - `→ cert_failed`: clear the host prefix so stale content is not served.
 *
 * No-op (returns the unchanged status, action `null`) when:
 *   - `FLY_API_TOKEN` is unset — never flip a verified domain to cert_failed just
 *     because ops creds are missing (important for the best-effort GET path).
 *   - the status is not cert-eligible (e.g. pending / dns_failed).
 *
 * This function NEVER throws on Fly/storage failure of the side effects: the
 * cert decision is committed first, then mirror/clear run best-effort. A Fly
 * error surfaces as a `cert_failed` status (via `nextCertAction`), not an
 * exception — so callers can run it concurrently across rows without a single
 * outage breaking the batch. On the lazy GET path (`allowFailureTransition:
 * false`) a Fly error is instead swallowed as a no-op, so a read never destroys
 * a DNS-valid domain's content.
 */
export async function reconcileCustomDomainCert(
  domain: CertReconcileDomain,
  opts: CertReconcileOptions = {},
): Promise<CertReconcileResult> {
  const { allowFailureTransition = true } = opts;

  // Platform-owned domains (e.g. pagespace.ai) already have valid DNS/TLS via
  // the main app — they're inserted straight to `active` and never go through
  // Fly cert provisioning. `isCertEligible` includes `active`, so without this
  // guard a manual "Check SSL" click would call Fly's addCertificate for a
  // domain Fly doesn't need to (and shouldn't) manage.
  if (domain.platformOwned) {
    return { status: domain.status, action: null };
  }

  if (!process.env.FLY_API_TOKEN) {
    return { status: domain.status, action: null };
  }
  if (!isCertEligible(domain.status)) {
    return { status: domain.status, action: null };
  }

  const flyCert = await addCertificate(routerAppName(), domain.hostname);
  let ownership = await preValidateOwnership(flyCert);
  let cert = flyCert;

  // The customer published the record, but Fly has not noticed yet.
  //
  // This is the ONE state a re-check helps, and it is why `recheckCertificate`
  // exists: `addCertificate` above resolves an existing hostname with a GET, and
  // a GET does not make Fly re-read DNS — so without this the domain waits on
  // Fly's own polling cadence even though everything it needs is already
  // published. Narrow by construction: it fires only while our resolver can see
  // an accepted value AND Fly still reports the TXT unconfigured, a window that
  // closes as soon as Fly agrees.
  if (ownership?.state === 'satisfied' && cert.ok && !cert.ownershipTxtConfigured) {
    const rechecked = await recheckCertificate(routerAppName(), domain.hostname);
    if (rechecked.ok) {
      cert = rechecked;
      ownership = await preValidateOwnership(rechecked);
    }
    // A failed re-check is deliberately ignored: it is an optimization on top of
    // a state that already resolves on its own, and letting a Fly blip here turn
    // into `mark-failed` would flip a healthy domain to cert_failed.
  }

  const action = nextCertAction(domain.status as CertEligibleStatus, cert, ownership);

  // Blocked on a record the customer has not published: the domain is fine and
  // the certificate will issue the moment it appears, so this stays at
  // `provisioning` and clears nothing. Logged at warn because it is the one
  // cert state that will NEVER resolve on its own — somebody has to be told.
  if (action.action === 'blocked-on-ownership') {
    loggers.api.warn('Fly certificate is waiting on an _fly-ownership TXT record', {
      driveId: domain.driveId,
      hostname: domain.hostname,
      reason: action.reason,
    });
  }

  // Non-destructive read path: a Fly error/timeout maps to `mark-failed`, which
  // would flip the domain to `cert_failed` and wipe its mirrored prefix. On the
  // lazy GET we refuse that — only ever advance forward; a DNS-valid domain must
  // not lose its content because a list read hit a transient Fly blip.
  if (action.action === 'mark-failed' && !allowFailureTransition) {
    return { status: domain.status, action: null };
  }

  const nextStatus = certActionToDbStatus(action);

  await db.update(customDomains).set({ status: nextStatus }).where(eq(customDomains.id, domain.id));

  // On the freshly-active transition, regenerate site files so the now-active
  // custom host is adopted as canonical/primary. Best-effort: a failure here
  // does not roll back the committed status.
  if (nextStatus === 'active' && domain.status !== 'active') {
    try {
      await regeneratePublishedSiteFiles(domain.driveId);
    } catch (err) {
      loggers.api.warn('Failed to regenerate site files after cert activation', {
        driveId: domain.driveId,
        hostname: domain.hostname,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    mirrorDriveToCustomHost(domain.driveId, domain.hostname, renderDomainNotFoundOverride).catch((err) => {
      loggers.api.warn('Failed to re-mirror artifacts after cert activation', {
        driveId: domain.driveId,
        hostname: domain.hostname,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // On any → cert_failed outcome, purge the mirrored prefix so stale content is
  // not served until the cert recovers. Idempotent: a no-op when nothing remains.
  if (nextStatus === 'cert_failed') {
    try {
      await clearCustomHost(domain.hostname);
    } catch (err) {
      loggers.api.warn('Failed to clear custom host artifacts after cert failure', {
        hostname: domain.hostname,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    status: nextStatus,
    action: action.action,
    ownershipInstruction: ownership ? describeOwnershipVerification(ownership) : null,
  };
}
