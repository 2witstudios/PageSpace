import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { SPEND_SOURCE_KINDS } from '@pagespace/db/schema/wallets';
import { setPersonalDefaultSource } from '@pagespace/lib/services/drive-wallet-service';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { safeParseBody } from '@/lib/validation/parse-body';
import { WALLET_WRITE_AUTH, walletCredentialOf, walletErrorResponse } from '@/lib/wallets/wallet-route';

/**
 * PUT /api/wallets/default — the caller's own default source (Spec SPEND-3, UI-10): what a new
 * conversation preselects when its drive sets no default. `null` clears it; with no default and
 * more than one source, the gate refuses until a source is chosen (SPEND-4). Session only: an
 * MCP/CLI token is refused by name ([D-OW-26]).
 */

const schema = z.object({ source: z.enum(SPEND_SOURCE_KINDS).nullable() }).strict();

export async function PUT(request: Request) {
  const auth = await authenticateRequestWithOptions(request, WALLET_WRITE_AUTH);
  if (isAuthError(auth)) return auth.error;
  const parsed = await safeParseBody(request, schema);
  if (!parsed.success) return parsed.response;
  try {
    const result = await setPersonalDefaultSource(auth.userId, parsed.data.source, walletCredentialOf(auth));
    if (!result.ok) return walletErrorResponse(result);
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'wallets',
      resourceId: auth.userId,
      details: { operation: 'set_default_spend_source', source: parsed.data.source },
    });
    return NextResponse.json({ defaultSpendSource: result.defaultSpendSource });
  } catch (error) {
    loggers.api.error('Error setting the default spend source:', error as Error);
    return NextResponse.json({ error: 'Failed to set the default source' }, { status: 500 });
  }
}
