import { verifySecurityAuditChain } from '@pagespace/lib';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to verify the security audit log hash chain integrity.
 *
 * Detects tampering in the security audit log by recomputing each entry's
 * hash and verifying chain links. Logs a SECURITY ALERT if the chain is broken.
 *
 * Trigger via:
 * curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/verify-audit-chain
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
