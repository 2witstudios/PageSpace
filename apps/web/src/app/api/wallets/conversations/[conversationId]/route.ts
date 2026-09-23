import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getConversationSpend, setConversationSpend } from '@pagespace/lib/services/drive-wallet-service';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { safeParseBody } from '@/lib/validation/parse-body';
import { WALLET_READ_AUTH, WALLET_WRITE_AUTH, refuseScopedTokenForAccountRead, walletErrorResponse } from '@/lib/wallets/wallet-route';

/**
 * A conversation's spend source (Spec SPEND-2, SPEND-3, SPEND-4).
 *
 * GET  the stored choice, the wallets the caller may pick here, and what the next call would
 *      spend as the gate decides it now (the chip, before the first message).
 * PUT  choose a wallet (`walletId`) or clear the choice (`null`). The only writer of the choice:
 *      a turn never changes it. The wallet must be one the caller may spend in this
 *      conversation's drive now (400 otherwise); the gate re-checks it on every call and refuses
 *      it if it stops being one.
 *
 * The drive is the conversation's own (a drive or page conversation). A GLOBAL conversation has
 * none, so `?driveId=` names the drive the person is choosing for; it only lists options (which
 * the permissions module opens) and is ignored for any other conversation type.
 * Only the caller's own conversation: anyone else's is 404. PUT is session only.
 */

type RouteContext = { params: Promise<{ conversationId: string }> };

const schema = z.object({ walletId: z.string().min(1).max(64).nullable() }).strict();

const globalDriveIdOf = (request: Request): string | null => {
  const value = new URL(request.url).searchParams.get('driveId');
  return value && value.length <= 64 ? value : null;
};

export async function GET(request: Request, context: RouteContext) {
  const { conversationId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, WALLET_READ_AUTH);
  if (isAuthError(auth)) return auth.error;
  const scopeError = refuseScopedTokenForAccountRead(auth);
  if (scopeError) return scopeError;
  try {
    const result = await getConversationSpend(auth.userId, conversationId, globalDriveIdOf(request));
    if (!result.ok) return walletErrorResponse(result);
    auditRequest(request, {
      eventType: 'data.read',
      userId: auth.userId,
      resourceType: 'conversation_spend_source',
      resourceId: conversationId,
      details: { operation: 'read_conversation_spend_source' },
    });
    const { ok: _ok, ...body } = result;
    return NextResponse.json(body);
  } catch (error) {
    loggers.api.error('Error reading the conversation spend source:', error as Error);
    return NextResponse.json({ error: 'Failed to read the spend source' }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const { conversationId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, WALLET_WRITE_AUTH);
  if (isAuthError(auth)) return auth.error;
  const parsed = await safeParseBody(request, schema);
  if (!parsed.success) return parsed.response;
  try {
    const result = await setConversationSpend(auth.userId, conversationId, parsed.data.walletId, globalDriveIdOf(request));
    if (!result.ok) return walletErrorResponse(result);
    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'conversation_spend_source',
      resourceId: conversationId,
      details: { operation: 'set_conversation_spend_source', walletId: parsed.data.walletId },
    });
    const { ok: _ok, ...body } = result;
    return NextResponse.json(body);
  } catch (error) {
    loggers.api.error('Error setting the conversation spend source:', error as Error);
    return NextResponse.json({ error: 'Failed to set the spend source' }, { status: 500 });
  }
}
