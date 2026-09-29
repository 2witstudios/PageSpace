import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getAlwaysOwnCredits, setAlwaysOwnCredits } from '@pagespace/lib/services/drive-wallet-service';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { safeParseBody } from '@/lib/validation/parse-body';
import {
  WALLET_READ_AUTH,
  WALLET_WRITE_AUTH,
  refuseScopedTokenForAccountRead,
  walletCredentialOf,
  walletErrorResponse,
} from '@/lib/wallets/wallet-route';

/**
 * /api/wallets/always-own-credits — the caller's "Always my own credits" switches (Spec SPEND-5,
 * D17.2, D20.7): `driveId: null` is the one global switch, a drive id the switch for that
 * drive. Either makes every call own credits or a refusal; it never opens another wallet.
 * GET reads both (the drive's with `?driveId=`); PUT is session only ([D-OW-26]).
 */

const schema = z.object({ driveId: z.string().min(1).nullable(), enabled: z.boolean() }).strict();

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, WALLET_READ_AUTH);
  if (isAuthError(auth)) return auth.error;
  const scoped = refuseScopedTokenForAccountRead(auth);
  if (scoped) return scoped;
  const driveId = new URL(request.url).searchParams.get('driveId');
  try {
    const { alwaysOwnCredits, alwaysOwnCreditsInDrive } = await getAlwaysOwnCredits(auth.userId, driveId && driveId.length > 0 ? driveId : null);
    return NextResponse.json({ alwaysOwnCredits, alwaysOwnCreditsInDrive });
  } catch (error) {
    loggers.api.error('Error reading the always-own-credits switches:', error as Error);
    return NextResponse.json({ error: 'Failed to read the switches' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const auth = await authenticateRequestWithOptions(request, WALLET_WRITE_AUTH);
  if (isAuthError(auth)) return auth.error;
  const parsed = await safeParseBody(request, schema);
  if (!parsed.success) return parsed.response;
  try {
    const result = await setAlwaysOwnCredits(auth.userId, parsed.data, walletCredentialOf(auth));
    if (!result.ok) return walletErrorResponse(result);
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'wallets',
      resourceId: auth.userId,
      details: { operation: 'set_always_own_credits', driveId: result.driveId, enabled: result.enabled },
    });
    return NextResponse.json({ driveId: result.driveId, enabled: result.enabled });
  } catch (error) {
    loggers.api.error('Error setting the always-own-credits switch:', error as Error);
    return NextResponse.json({ error: 'Failed to set the switch' }, { status: 500 });
  }
}
