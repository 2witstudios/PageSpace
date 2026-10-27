import { runFullAuditVerification } from '@pagespace/lib/audit/full-audit-verification';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { audit } from '@pagespace/lib/audit/audit-log';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to verify the security audit log hash chain integrity.
 *
 * Post-cutover (#890 Phase 2, leaf 5) this consults the FULL trust-plane
 * verification: chain consistency (recompute + linkage, era-aware) AND
 * anchor-vs-chain matching where anchoring is configured AND co-stream
 * reconciliation where collector records are supplied (none here — the
 * tamper drill passes them explicitly). Skipped checks are reported with a
 * reason, never silent. Alerts fire inside the lib layer (verifyAndAlert /
 * notifyAnchorVerificationFailure).
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce, X-Cron-Signature headers.
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const { chain, anchors, coStream, isValid } = await runFullAuditVerification({
      source: 'periodic',
      chain: { stopOnFirstBreak: true },
    });

    if (!chain.isValid) {
      loggers.security.error(
        '[SECURITY ALERT] Security audit hash chain integrity check FAILED.',
        {
          breakPoint: chain.breakPoint,
          entriesVerified: chain.entriesVerified,
          invalidEntries: chain.invalidEntries,
        }
      );
    } else {
      loggers.api.info(
        `[Cron] Security audit chain verified: ${chain.validEntries} entries valid`
      );
    }

    audit({ eventType: 'data.read', resourceType: 'cron_job', resourceId: 'verify_audit_chain', details: { isValid, entriesVerified: chain.entriesVerified } });

    return NextResponse.json({
      success: true,
      isValid,
      chainValid: chain.isValid,
      totalEntries: chain.totalEntries,
      entriesVerified: chain.entriesVerified,
      validEntries: chain.validEntries,
      invalidEntries: chain.invalidEntries,
      anchors: anchors.configured
        ? { configured: true, allMatch: anchors.report.allMatch, counts: anchors.report.counts }
        : { configured: false, skippedReason: anchors.skippedReason },
      coStream: coStream.configured
        ? { configured: true, verified: coStream.report.verified, counts: coStream.report.counts }
        : { configured: false, skippedReason: coStream.skippedReason },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    loggers.api.error('[Cron] Error verifying verify audit chain:', { error });
    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error',
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
