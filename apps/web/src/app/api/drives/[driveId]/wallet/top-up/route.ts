import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { topUpDriveWallet } from '@pagespace/lib/services/drive-wallet-service';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { safeParseBody } from '@/lib/validation/parse-body';
import { WALLET_WRITE_AUTH, walletCredentialOf, walletErrorResponse } from '@/lib/wallets/wallet-route';

/**
 * POST /api/drives/[driveId]/wallet/top-up — Top up a drive's wallet from its funder (Spec WAL-3): the org pool for an org drive (org admins only), the lead's own wallet for a personal drive. A refundable owner funding leg; one per idempotency key (a replay moves nothing). 402 when the funder cannot cover it.
 *
 * Session only: an MCP/CLI token is refused by name, nothing written ([D-OW-26]). Dark while ORGS_ENABLED is false (404).
 */

type RouteContext = { params: Promise<{ driveId: string }> };

const schema = z.object({
  amountCents: z.number().int().min(1).max(2_147_483_647),
  /** Minted by the client per action, so a retried request lands once. */
  idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export async function POST(request: Request, context: RouteContext) {
  const { driveId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, WALLET_WRITE_AUTH);
  if (isAuthError(auth)) return auth.error;
  const parsed = await safeParseBody(request, schema);
  if (!parsed.success) return parsed.response;
  try {
    const result = await topUpDriveWallet(auth.userId, driveId, parsed.data, walletCredentialOf(auth));
    if (!result.ok) return walletErrorResponse(result);
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'drive_wallet',
      resourceId: driveId,
      details: { operation: 'top_up_drive_wallet', amountCents: result.amountCents, legId: result.legId, duplicate: result.duplicate },
    });
    return NextResponse.json({ topUp: { legId: result.legId, amountCents: result.amountCents, paidDebtCents: result.paidDebtCents, duplicate: result.duplicate } });
  } catch (error) {
    loggers.api.error('Error in top_up_drive_wallet:', error as Error);
    return NextResponse.json({ error: 'Failed to move the funds' }, { status: 500 });
  }
}
