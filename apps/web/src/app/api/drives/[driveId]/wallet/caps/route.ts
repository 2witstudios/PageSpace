import { NextResponse } from 'next/server';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { listDriveWalletCaps } from '@pagespace/lib/services/drive-wallet-service';
import { authenticateRequestWithOptions, checkMCPDriveScope, isAuthError } from '@/lib/auth';
import { WALLET_READ_AUTH, walletCredentialOf, walletErrorResponse } from '@/lib/wallets/wallet-route';

type RouteContext = { params: Promise<{ driveId: string }> };

/**
 * GET /api/drives/[driveId]/wallet/caps — every person's per-consumer caps on the drive's wallet
 * (Spec WAL-7, UI-9), by name: `{ walletId, caps: [{ userId, displayName, dailyCapCents,
 * monthlyCapCents, dailyCapCredits, monthlyCapCredits }] }` (null = no cap in that window). For
 * whoever may set caps (org admins on an org drive, the lead on a personal drive) and the lead.
 */
export async function GET(request: Request, context: RouteContext) {
  const { driveId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, WALLET_READ_AUTH);
  if (isAuthError(auth)) return auth.error;
  const scopeError = checkMCPDriveScope(auth, driveId);
  if (scopeError) return scopeError;
  try {
    const result = await listDriveWalletCaps(auth.userId, driveId, walletCredentialOf(auth));
    if (!result.ok) return walletErrorResponse(result);
    auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'drive_wallet', resourceId: driveId, details: { operation: 'list_consumer_caps' } });
    return NextResponse.json({ walletId: result.walletId, caps: result.caps });
  } catch (error) {
    loggers.api.error('Error listing the drive wallet caps:', error as Error);
    return NextResponse.json({ error: 'Failed to list the caps', code: 'internal_error' }, { status: 500 });
  }
}
