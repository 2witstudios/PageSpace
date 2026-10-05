import { NextResponse } from 'next/server';
import type { ConsumerCapWriteInput } from '@pagespace/lib/billing/wallet-core';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { setDriveWalletCap } from '@pagespace/lib/services/drive-wallet-service';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { safeParseBody } from '@/lib/validation/parse-body';
import { WALLET_WRITE_AUTH, walletCredentialOf, walletErrorResponse } from '@/lib/wallets/wallet-route';
import { consumerCapSchema } from '@/lib/wallets/consumer-cap-schema';

type RouteContext = { params: Promise<{ driveId: string; userId: string }> };

/**
 * One person's per-consumer caps on the drive's wallet (Spec WAL-7).
 *
 * PUT     `{ dailyCapCents?, monthlyCapCents? }` (whole cents; null = no cap in that window). The
 *         first write enables caps: an omitted window takes the D20.5 default; later writes keep
 *         an omitted window. Answers the wallet's caps as GET .../wallet/caps does.
 * DELETE  clears the person's caps (unlimited within the wallet).
 *
 * Org admins on an org drive; the lead (the wallet's owner) on a personal drive. A token is
 * refused by name ([D-OW-26]); an unknown person is 404 `not_a_consumer`.
 */
async function write(request: Request, context: RouteContext, clear: boolean) {
  const { driveId, userId: consumerId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, WALLET_WRITE_AUTH);
  if (isAuthError(auth)) return auth.error;
  let input: ConsumerCapWriteInput | null = null;
  if (!clear) {
    const parsed = await safeParseBody(request, consumerCapSchema);
    if (!parsed.success) return parsed.response;
    input = { dailyCents: parsed.data.dailyCapCents, monthlyCents: parsed.data.monthlyCapCents };
  }
  try {
    const result = await setDriveWalletCap(
      auth.userId,
      driveId,
      consumerId,
      input,
      walletCredentialOf(auth),
    );
    if (!result.ok) return walletErrorResponse(result);
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive_wallet',
      resourceId: driveId,
      details: { operation: input === null ? 'clear_consumer_cap' : 'set_consumer_cap', consumerId },
    });
    return NextResponse.json({ walletId: result.walletId, caps: result.caps });
  } catch (error) {
    loggers.api.error('Error writing a drive wallet cap:', error as Error);
    return NextResponse.json({ error: 'Failed to write the cap', code: 'internal_error' }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  return write(request, context, false);
}

export async function DELETE(request: Request, context: RouteContext) {
  return write(request, context, true);
}
