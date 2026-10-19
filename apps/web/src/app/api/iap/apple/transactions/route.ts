import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getPersonalTierFromPrice } from '@/lib/stripe/price-config';
import { emitCreditsUpdated, getCreditBalance } from '@/lib/subscription/credit-balance';
import { readJwsField, transactionReply, verificationFailureReply } from '@/lib/iap-server/apple-http';
import { AppleVerificationError, getAppleVerifier } from '@pagespace/lib/billing/apple/apple-verify';
import { applyAppleTransaction } from '@pagespace/lib/billing/apple/apple-funding';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * POST /api/iap/apple/transactions — body `{ signedTransaction }`
 *
 * The device posts every StoreKit 2 transaction it sees — a purchase, a restore, a
 * `Transaction.updates` delivery — and finishes it only once this route answers with a
 * final status (see lib/iap-server/apple-http). The JWS is verified against Apple's root
 * before anything is read from it; the transaction is then applied for the signed-in
 * caller, who must be the account its appAccountToken names.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_transaction' }, { status: 400 });
  }
  const signedTransaction = readJwsField(body, 'signedTransaction');
  if (!signedTransaction) return NextResponse.json({ error: 'invalid_transaction' }, { status: 400 });

  try {
    const { config, verifier } = getAppleVerifier();
    const decoded = await verifier.verifyTransaction(signedTransaction);
    const result = await applyAppleTransaction({
      userId,
      decoded,
      priceTier: getPersonalTierFromPrice,
      config: { bundleId: config.bundleId, allowSandbox: config.allowSandbox },
    });

    const reply = transactionReply(result);
    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'app_store_transaction',
      resourceId: decoded.transactionId ?? 'unknown',
      details: { result: result.result, ...(result.result === 'refused' ? { reason: result.reason } : { kind: result.kind }) },
    });
    if (result.result === 'refused') {
      loggers.api.warn('App Store transaction refused', { userId, transactionId: decoded.transactionId, reason: result.reason });
      return NextResponse.json(reply.body, { status: reply.status });
    }
    void emitCreditsUpdated(userId);
    // The balance the purchase left, so the device can show it without a second round trip.
    const balance = await getCreditBalance(userId, result.subscriptionTier).catch(() => null);
    return NextResponse.json({ ...reply.body, balance }, { status: reply.status });
  } catch (error) {
    if (error instanceof AppleVerificationError) {
      loggers.api.warn('App Store transaction did not verify', { userId, failure: error.failure });
      const reply = verificationFailureReply(error.failure);
      return NextResponse.json(reply.body, { status: reply.status });
    }
    loggers.api.error('App Store transaction failed', error instanceof Error ? error : undefined, { userId });
    return NextResponse.json({ error: 'Failed to apply the purchase' }, { status: 500 });
  }
}
