import { verifySecurityAuditChain } from '@pagespace/lib';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to verify the security audit log hash chain integrity.
 *
 * Detects tampering in the security audit log by recomputing each entry's
 * hash and verifying chain links. Logs a SECURITY ALERT if the chain is broken.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce, X-Cron-Signature headers.
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const result = await verifySecurityAuditChain({ stopOnFirstBreak: true });

    if (!result.isValid) {
      console.error(
        '[SECURITY ALERT] Security audit hash chain integrity check FAILED.',
        'Break point:', JSON.stringify(result.breakPoint),
        'Entries verified:', result.entriesVerified,
        'Invalid:', result.invalidEntries
      );

      const webhookUrl = process.env.AUDIT_ALERT_WEBHOOK_URL;
      if (webhookUrl && webhookUrl.startsWith('https://')) {
        fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'audit_chain_integrity_failure',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV,
            details: {
              isValid: result.isValid,
              totalEntries: result.totalEntries,
              entriesVerified: result.entriesVerified,
              invalidEntries: result.invalidEntries,
              breakPosition: result.breakPoint?.position ?? null,
              durationMs: result.durationMs,
            },
          }),
        }).catch((err) => {
          console.warn('[Cron] Webhook alert delivery failed:', err.message);
        });
      }
    } else {
      console.log(
        `[Cron] Security audit chain verified: ${result.validEntries} entries valid`
      );
    }

    return NextResponse.json({
      success: true,
      isValid: result.isValid,
      totalEntries: result.totalEntries,
      entriesVerified: result.entriesVerified,
      validEntries: result.validEntries,
      invalidEntries: result.invalidEntries,
      breakPoint: result.breakPoint,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Error verifying audit chain:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
