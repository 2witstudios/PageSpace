import { NextResponse } from 'next/server';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getDriveSpend } from '@pagespace/lib/services/drive-wallet-service';
import { authenticateRequestWithOptions, checkMCPDriveScope, isAuthError } from '@/lib/auth';
import { actorFromAuth } from '@/lib/auth/request-actor';
import { WALLET_READ_AUTH, walletErrorResponse } from '@/lib/wallets/wallet-route';

/**
 * GET /api/wallets/drives/[driveId] — what the caller would spend from in a drive with no
 * conversation in view (Spec SPEND-2: the header chip "while inside a drive"): the sources they
 * may pick there and what a new conversation would preselect, as the gate decides it now. Read
 * only: nothing is reserved, stored or logged as a refusal. Switching stays per conversation
 * (SPEND-3), so there is no PUT here.
 *
 * Session, or an MCP token whose drive scope includes the drive. A drive the caller cannot open
 * is 404.
 */

type RouteContext = { params: Promise<{ driveId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { driveId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, WALLET_READ_AUTH);
  if (isAuthError(auth)) return auth.error;
  const actor = actorFromAuth(auth);
  const scopeError = checkMCPDriveScope(auth, driveId);
  if (scopeError) return scopeError;
  try {
    const result = await getDriveSpend(actor, driveId);
    if (!result.ok) return walletErrorResponse(result);
    auditRequest(request, {
      eventType: 'data.read',
      userId: auth.userId,
      resourceType: 'drive_spend_source',
      resourceId: driveId,
      details: { operation: 'read_drive_spend_source' },
    });
    const { ok: _ok, ...body } = result;
    return NextResponse.json(body);
  } catch (error) {
    loggers.api.error('Error reading the drive spend source:', error as Error);
    return NextResponse.json({ error: 'Failed to read the spend source', code: 'internal_error' }, { status: 500 });
  }
}
