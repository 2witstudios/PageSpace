import { verifyAndAlert } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { audit } from '@pagespace/lib/audit/audit-log';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to verify the security audit log hash chain integrity.
 *
 * Detects tampering in the security audit log by recomputing each entry's
 * hash and verifying chain links. Fires the registered alert handler on failure.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce, X-Cron-Signature headers.
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const result = await verifyAndAlert('periodic', { stopOnFirstBreak: true });

    if (!result.isValid) {
      loggers.security.error(
        '[SECURITY ALERT] Security audit hash chain integrity check FAILED.',
        {
          breakPoint: result.breakPoint,
          entriesVerified: result.entriesVerified,
          invalidEntries: result.invalidEntries,
        }
      );
    } else {
      loggers.api.info(
        `[Cron] Security audit chain verified: ${result.validEntries} entries valid`
      );
    }

    audit({ eventType: 'data.read', userId: 'system', resourceType: 'cron_job', resourceId: 'verify_audit_chain', details: { isValid: result.isValid, entriesVerified: result.entriesVerified } });

    return NextResponse.json({
      success: true,
      isValid: result.isValid,
      totalEntries: result.totalEntries,
      entriesVerified: result.entriesVerified,
      validEntries: result.validEntries,
      invalidEntries: result.invalidEntries,
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
