import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getConversationSpend, getDriveSpend, setConversationSpend } from '@pagespace/lib/services/drive-wallet-service';
import { credentialRefusalFor } from '@pagespace/lib/permissions/wallet-access';
import { actorFromAuth } from '@/lib/auth/request-actor';
import { resolveOrCreateConversation, ConversationOwnershipError, ConversationHistoryDeletedError } from '@/lib/repositories/resolve-or-create-conversation';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { safeParseBody } from '@/lib/validation/parse-body';
import { WALLET_READ_AUTH, WALLET_WRITE_AUTH, refuseScopedTokenForAccountRead, walletCredentialOf, walletErrorResponse } from '@/lib/wallets/wallet-route';

/**
 * A conversation's spend source (Spec SPEND-2, SPEND-3, SPEND-4).
 *
 * GET  the stored choice, the wallets the caller may pick here, and what the next call would
 *      spend as the gate decides it now (the chip, before the first message).
 * PUT  choose a wallet (`walletId`) or clear the choice (`null`). The only writer of the choice:
 *      a turn never changes it. The wallet must be one the caller may spend in this
 *      conversation's drive now (400 otherwise); the gate re-checks it on every call and refuses
 *      it if it stops being one.
 *      `createGlobalDraft: true` materializes a local global draft only after the session's
 *      drive and wallet checks. Its selected source is part of the insert; viewing creates
 *      nothing, and empty drafts remain outside the message-based history listing.
 *
 * The drive is the conversation's own (a drive or page conversation). A GLOBAL conversation has
 * none, so `?driveId=` names the drive the person is choosing for; it only lists options (which
 * the permissions module opens) and is ignored for any other conversation type.
 * Only the caller's own conversation: anyone else's is 404. PUT is session only: an MCP/CLI
 * token is refused by name (`mcp_token_cannot_change_spend_source`, [D-OW-26]) — a source
 * change moves no money itself but redirects every later call's spend.
 */

type RouteContext = { params: Promise<{ conversationId: string }> };

const schema = z.object({ walletId: z.string().min(1).max(64).nullable(), createGlobalDraft: z.literal(true).optional() }).strict();

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
    return NextResponse.json({ error: 'Failed to read the spend source', code: 'internal_error' }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const { conversationId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, WALLET_WRITE_AUTH);
  if (isAuthError(auth)) return auth.error;
  const parsed = await safeParseBody(request, schema);
  if (!parsed.success) return parsed.response;
  try {
    const credential = walletCredentialOf(auth);
    const driveId = globalDriveIdOf(request);
    let created = false;
    if (parsed.data.createGlobalDraft) {
      // Drafts stay local while viewed. Only an explicit session choice may
      // create one, after validating its source; the insert carries the choice
      // atomically so a concurrent first send never gates against a default.
      const refusal = credentialRefusalFor(credential, 'set_conversation_source');
      if (refusal) return walletErrorResponse({ ok: false, status: 403, ...refusal });
      if (!driveId) return walletErrorResponse({ ok: false, status: 400, code: 'invalid_request', message: 'A draft source choice requires a drive context' });
      const preview = await getDriveSpend(actorFromAuth(auth), driveId);
      if (!preview.ok) return walletErrorResponse(preview);
      if (parsed.data.walletId !== null && !preview.options.some((option) => option.walletId === parsed.data.walletId)) {
        return walletErrorResponse({ ok: false, status: 400, code: 'wallet_not_available', message: 'That wallet is not one you can spend from in this conversation' });
      }
      created = (await resolveOrCreateConversation(auth.userId, conversationId, undefined, { initialChosenWalletId: parsed.data.walletId })).isNew;
    }
    const result = created
      ? await getConversationSpend(auth.userId, conversationId, driveId)
      : await setConversationSpend(auth.userId, conversationId, parsed.data.walletId, credential, driveId);
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
    if (error instanceof ConversationOwnershipError || error instanceof ConversationHistoryDeletedError) {
      return walletErrorResponse({ ok: false, status: 404, code: 'not_found', message: 'Conversation not found' });
    }
    loggers.api.error('Error setting the conversation spend source:', error as Error);
    return NextResponse.json({ error: 'Failed to set the spend source', code: 'internal_error' }, { status: 500 });
  }
}
