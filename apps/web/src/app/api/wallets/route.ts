import { NextResponse } from 'next/server';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { listMyWallets } from '@pagespace/lib/services/drive-wallet-service';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { WALLET_READ_AUTH, refuseScopedTokenForAccountRead, walletCredentialOf } from '@/lib/wallets/wallet-route';

/**
 * GET /api/wallets — Settings › Usage › Wallets (Spec UI-10): everything the caller spends from
 * (their own wallet, drive wallets of drives they can open, a seat on each org they belong to),
 * everything they fund (drive wallets their wallet parents, pools they administer, their
 * donations) and their default source. A consumer's entries carry remaining amounts only; a
 * pool's balance appears only for its org's Owner and Admins (SPEND-9, SPEND-10).
 *
 * Session, or an MCP token with no drive restriction (a drive-scoped token would see drives
 * outside its scope, so it is refused). Read with a token it is the consumer view: no pool
 * balances ([D-OW-26]).
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, WALLET_READ_AUTH);
  if (isAuthError(auth)) return auth.error;
  const scopeError = refuseScopedTokenForAccountRead(auth);
  if (scopeError) return scopeError;
  try {
    const wallets = await listMyWallets(auth.userId, walletCredentialOf(auth));
    auditRequest(request, {
      eventType: 'data.read',
      userId: auth.userId,
      resourceType: 'wallets',
      resourceId: auth.userId,
      details: { operation: 'list_my_wallets', driveWallets: wallets.driveWallets.length, seats: wallets.seats.length },
    });
    return NextResponse.json(wallets);
  } catch (error) {
    loggers.api.error('Error listing wallets:', error as Error);
    return NextResponse.json({ error: 'Failed to list wallets' }, { status: 500 });
  }
}
