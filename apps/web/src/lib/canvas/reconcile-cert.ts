import 'server-only';

import { loggers } from '@pagespace/lib/logging/logger-config';
import { nextCertAction, certActionToDbStatus, isCertEligible } from '@pagespace/lib/canvas/cert-action';
import type { CertAction, CertEligibleStatus } from '@pagespace/lib/canvas/cert-action';
import { addCertificate } from '@/lib/fly/certs';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { mirrorDriveToCustomHost, clearCustomHost } from '@/lib/canvas/custom-domain-mirror';
import { regeneratePublishedSiteFiles } from '@/lib/canvas/publish-page';

const FLY_APP_NAME = process.env.FLY_PROXY_APP_NAME ?? 'pagespace-proxy';

/** The minimal domain shape `reconcileCustomDomainCert` needs. */
export interface CertReconcileDomain {
  id: string;
  driveId: string;
  hostname: string;
  status: string;
}

export interface CertReconcileResult {
  /** The resulting DB status (equals the input status when no work was done). */
  status: string;
  /** The cert action taken, or `null` when reconcile was a no-op. */
  action: CertAction['action'] | null;
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
 * outage breaking the batch.
 */
export async function reconcileCustomDomainCert(
  domain: CertReconcileDomain,
): Promise<CertReconcileResult> {
  if (!process.env.FLY_API_TOKEN) {
    return { status: domain.status, action: null };
  }
  if (!isCertEligible(domain.status)) {
    return { status: domain.status, action: null };
  }

  const flyCert = await addCertificate(FLY_APP_NAME, domain.hostname);
  const action = nextCertAction(domain.status as CertEligibleStatus, flyCert);
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
    mirrorDriveToCustomHost(domain.driveId, domain.hostname).catch((err) => {
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

  return { status: nextStatus, action: action.action };
}
